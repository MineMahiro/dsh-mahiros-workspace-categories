/**
 * Client-half model tests.
 *
 * The client bundle is a `window.__ModuleLoader__` factory that the browser
 * loads, so there is no module to import. This test evaluates the real bundle
 * in a small VM with fake `window`/`document`/`react` and drives its exposed
 * `__syncModel`: migration, optimistic operations, Host adoption, seeding and
 * the shared-vs-local split. It also compares the browser copy of the model
 * with the Host copy from `lib/state-store.js` so the two cannot drift.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

import { applyOps as hostApplyOps, sanitizeShared as hostSanitizeShared } from '../lib/state-store.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * Minimal React stand-in: enough to evaluate the real tree component headlessly.
 * Hooks run synchronously against the module state the component reads (the
 * outer harness only ever renders one snapshot), so element trees can be walked
 * to assert which rows show a status mark.
 */
const fakeReact = {
	createElement(type, props, ...children) {
		const normalized = Object.assign({}, props)
		normalized.children = children.length === 1 ? children[0] : children
		return { type, props: normalized }
	},
	useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => undefined
}

function memoryStorage(entries) {
	const map = new Map(Object.entries(entries ?? {}))
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
		has: (key) => map.has(key),
		entries: () => Object.fromEntries(map)
	}
}

/** Evaluate one fresh copy of the bundle, as a page load would. */
function loadBundle(options = {}) {
	const storage = options.storage ?? memoryStorage()
	const warnings = []
	let captured
	const sandbox = Object.assign({
		console: {
			log: () => {},
			error: () => {},
			warn: (...args) => warnings.push(args)
		},
		window: {
			localStorage: storage,
			location: { protocol: 'http:', href: 'http://harness.invalid/' },
			fetch: options.fetch,
			// Keep the engine testable: no real timers, and the polling loop is
			// driven explicitly by the test through the exposed model surface.
			setTimeout: () => 0,
			clearTimeout: () => {},
			setInterval: () => 0,
			clearInterval: () => {},
			addEventListener: () => {},
			removeEventListener: () => {}
		},
		document: {
			visibilityState: 'visible',
			getElementById: () => null,
			createElement: () => ({ style: {}, textContent: '' }),
			head: { appendChild: () => {} },
			addEventListener: () => {},
			removeEventListener: () => {}
		}
	}, options.globals ?? {})
	sandbox.window.__ModuleLoader__ = { load: (spec) => (captured = spec) }
	vm.createContext(sandbox)
	vm.runInContext(source, sandbox, { filename: 'client.js' })
	const exports = captured.factory((name) => {
		if (name === 'react') return fakeReact
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: undefined }
		throw new Error(`unexpected require: ${name}`)
	})
	return { exports, model: exports.__syncModel, storage, warnings, sandbox }
}

/** Cross-realm objects from the VM need normalizing before deepEqual. */
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function tick() {
	return new Promise((resolve) => setImmediate(resolve))
}

function jsonResponse(value, status = 200) {
	return Promise.resolve({
		status,
		ok: status >= 200 && status < 300,
		json: () => Promise.resolve(value)
	})
}

const legacyState = JSON.stringify({
	version: 1,
	categories: [
		{ id: 'cat_a', name: '前端', collapsed: true },
		{ id: 'cat_b', name: '后端', collapsed: false }
	],
	assign: { ws1: 'cat_a' },
	expanded: { ws1: true },
	visible: { ws1: 15 },
	archivedFilter: 'show'
})

/* ------------------------------------------------------------------ *
 * Migration and the local / shared split
 * ------------------------------------------------------------------ */

test('a v1 document migrates into shared categories plus local preferences', () => {
	const storage = memoryStorage({ 'dsh.workspace-tree.state.v1': legacyState })
	const { model } = loadBundle({ storage })

	assert.deepEqual(plain(model.getSharedState()), {
		rev: 0,
		categories: [
			{ id: 'cat_a', name: '前端' },
			{ id: 'cat_b', name: '后端' }
		],
		assign: { ws1: 'cat_a' },
		sessionOrder: {}
	})

	const view = model.getViewState()
	assert.deepEqual(plain(view.categories), [
		{ id: 'cat_a', name: '前端', collapsed: true },
		{ id: 'cat_b', name: '后端', collapsed: false }
	])
	assert.deepEqual(plain(view.expanded), { ws1: true })
	assert.deepEqual(plain(view.visible), { ws1: 15 })
	assert.equal(view.archivedFilter, 'show')

	// The page mirror is written in the v2 layout right away.
	const written = JSON.parse(storage.getItem('dsh.workspace-tree.state.v2'))
	assert.equal(written.version, 2)
	assert.deepEqual(written.shared.categories, plain(model.getSharedState()).categories)
	assert.deepEqual(written.pending, [])
})

test('updateLocal never queues a Host operation; mutateShared always does', () => {
	const { model, storage } = loadBundle()
	model.updateLocal({ archivedFilter: 'only' })
	model.updateLocal({ collapsed: { cat_a: true } })
	assert.deepEqual(plain(model.getPendingOps()), [])
	assert.equal(model.getSharedState().categories.length, 0)

	model.mutateShared([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	assert.deepEqual(plain(model.getPendingOps()), [{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	assert.deepEqual(plain(model.getSharedState()).categories, [{ id: 'cat_a', name: '前端' }])
	// Folding a category is still device-local even with shared state present.
	model.updateLocal({ collapsed: { cat_a: true } })
	assert.equal(model.getPendingOps().length, 1)
	assert.equal(model.getViewState().categories[0].collapsed, true)

	const written = JSON.parse(storage.getItem('dsh.workspace-tree.state.v2'))
	assert.deepEqual(written.local.collapsed, { cat_a: true })
	assert.equal(written.pending.length, 1)
})

test('the outbox is bounded so a host-less deployment cannot grow forever', () => {
	const { model } = loadBundle()
	for (let index = 0; index < 520; index += 1) {
		model.mutateShared([{ type: 'assign', workspaceId: `ws_${index}`, categoryId: null }])
	}
	assert.equal(model.getPendingOps().length, 500)
})

/* ------------------------------------------------------------------ *
 * Model parity with the Host copy
 * ------------------------------------------------------------------ */

test('client and host apply the same operations to the same state', () => {
	const batches = [
		[{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }],
		[
			{ type: 'category.add', category: { id: 'cat_b', name: '后端' } },
			{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_b' },
			{ type: 'assign', workspaceId: 'ws2', categoryId: 'cat_missing' }
		],
		[
			{ type: 'assign', workspaceId: 'ws1', categoryId: null },
			{ type: 'category.rename', id: 'cat_b', name: '服务端' }
		],
		[{ type: 'category.delete', id: 'cat_b' }],
		[null, { type: 'category.add', category: {} }, { type: 'nope' }],
		[{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s2', 's1', 's3'] }],
		[{ type: 'session.order', workspaceId: 'ws1', sessionIds: [] }],
		[
			{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s1', 's1', '', 7, 's2'] },
			{ type: 'session.order', workspaceId: '', sessionIds: ['s1'] }
		],
		[
			{ type: 'category.add', category: { id: 'cat_b', name: 'B' } },
			{ type: 'category.move', id: 'cat_b', beforeId: 'cat_a' },
			{ type: 'category.move', id: 'cat_missing', beforeId: 'cat_a' },
			{ type: 'category.move', id: 'cat_b', beforeId: 'cat_missing' },
			{ type: 'category.move', id: 'cat_a', beforeId: null }
		]
	]
	let hostState = { categories: [], assign: {}, sessionOrder: {} }
	let clientState = { categories: [], assign: {}, sessionOrder: {} }
	const { model } = loadBundle()
	for (const batch of batches) {
		hostState = hostApplyOps(hostState, batch)
		clientState = plain(model.applySharedOps(clientState, batch))
		assert.deepEqual(clientState, hostState)
	}

	const samples = [
		{ categories: [{ id: 'a', name: 'A' }], assign: { w: 'a' } },
		{ categories: [{ id: 'a', name: 'A' }, { id: 'a', name: 'dup' }], assign: { w: 'missing' } },
		{ categories: 'nope', assign: [] },
		{ sessionOrder: { ws1: ['s2', 's2', '', 's1'], ws2: [], ws3: 'nope' } },
		{ sessionOrder: [] },
		null
	]
	for (const sample of samples) {
		assert.deepEqual(plain(model.sanitizeShared(sample)), hostSanitizeShared(sample))
	}
})

/* ------------------------------------------------------------------ *
 * Host adoption and flushing
 * ------------------------------------------------------------------ */

test('adopting a Host snapshot keeps unacknowledged operations on top', () => {
	const { model } = loadBundle()
	model.mutateShared([{ type: 'category.add', category: { id: 'cat_local', name: '本地' } }])
	assert.equal(model.getPendingOps().length, 1)

	model.adoptRemote(
		{ rev: 7, categories: [{ id: 'cat_host', name: '主机' }], assign: { ws1: 'cat_host' } },
		true
	)
	assert.equal(model.getSharedState().rev, 7)
	assert.deepEqual(plain(model.getSharedState()).categories.map((category) => category.id), ['cat_host', 'cat_local'])
	// The local operation is still pending, so it will reach the Host later.
	assert.equal(model.getPendingOps().length, 1)

	// Without `keepPending` the Host snapshot wins outright.
	model.adoptRemote({ rev: 8, categories: [], assign: {} }, false)
	assert.equal(model.getSharedState().rev, 8)
	assert.deepEqual(plain(model.getSharedState()).categories, [])
})

test('a successful flush clears the outbox and adopts the new revision', async () => {
	const calls = []
	const fetch = (path, init) => {
		calls.push({ path, init })
		return jsonResponse({
			rev: 3,
			categories: [{ id: 'cat_a', name: '前端' }],
			assign: {},
			applied: 1
		})
	}
	const { model } = loadBundle({ fetch })
	model.mutateShared([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	await tick()

	assert.equal(calls.length, 1)
	assert.equal(calls[0].path, '/api/workspace-categories.state')
	assert.equal(calls[0].init.method, 'POST')
	assert.deepEqual(JSON.parse(calls[0].init.body), {
		ops: [{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }]
	})
	assert.equal(model.getPendingOps().length, 0)
	assert.equal(model.getSharedState().rev, 3)
})

test('a failed flush keeps the outbox for the next attempt', async () => {
	let attempts = 0
	const fetch = () => {
		attempts += 1
		return Promise.reject(new Error('network down'))
	}
	const { model } = loadBundle({ fetch })
	model.mutateShared([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	await tick()
	assert.equal(attempts, 1)
	assert.equal(model.getPendingOps().length, 1)
	assert.equal(model.getSharedState().categories.length, 1)
	assert.equal(model.getSyncStatus(), 'offline')
})

/* ------------------------------------------------------------------ *
 * First contact
 * ------------------------------------------------------------------ */

test('a fresh Host is seeded from this device’s categories', async () => {
	const requests = []
	const fetch = (path, init) => {
		requests.push({ path, method: init === undefined || init.method === undefined ? 'GET' : init.method, init })
		if (init !== undefined && init.method === 'POST') {
			const body = JSON.parse(init.body)
			return jsonResponse({ rev: 1, categories: body.replace.categories, assign: body.replace.assign })
		}
		return jsonResponse({ rev: 0, categories: [], assign: {}, changed: true })
	}
	const storage = memoryStorage({ 'dsh.workspace-tree.state.v1': legacyState })
	const { model } = loadBundle({ storage, fetch })

	model.bootstrapSync()
	await tick()
	await tick()

	assert.equal(requests[0].method, 'GET')
	const seeded = requests.find((entry) => entry.method === 'POST')
	assert.ok(seeded !== undefined, 'expected a replace request')
	assert.deepEqual(JSON.parse(seeded.init.body), {
		replace: {
			categories: [
				{ id: 'cat_a', name: '前端' },
				{ id: 'cat_b', name: '后端' }
			],
			assign: { ws1: 'cat_a' },
			sessionOrder: {}
		}
	})
	assert.equal(model.getSharedState().rev, 1)
	assert.equal(model.getPendingOps().length, 0)
})

test('an initialized Host wins over this device’s stale local copy', async () => {
	const fetch = () =>
		jsonResponse({
			rev: 4,
			categories: [{ id: 'cat_host', name: '主机分类' }],
			assign: { ws9: 'cat_host' },
			changed: true
		})
	const storage = memoryStorage({ 'dsh.workspace-tree.state.v1': legacyState })
	const { model } = loadBundle({ storage, fetch })

	model.bootstrapSync()
	await tick()
	await tick()

	assert.deepEqual(plain(model.getSharedState()), {
		rev: 4,
		categories: [{ id: 'cat_host', name: '主机分类' }],
		assign: { ws9: 'cat_host' },
		sessionOrder: {}
	})
	// Local presentation preferences survive adoption.
	assert.equal(model.getViewState().expanded.ws1, true)
})

test('a missing route (client-only Host) degrades to local storage', async () => {
	const fetch = () => jsonResponse({ error: 'not found' }, 404)
	const { model } = loadBundle({ fetch })
	model.startSync()
	await tick()
	assert.equal(model.getSyncStatus(), 'unsupported')
	model.mutateShared([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	await tick()
	// The tree still works; the operation waits in the outbox.
	assert.deepEqual(plain(model.getSharedState()).categories, [{ id: 'cat_a', name: '前端' }])
	assert.equal(model.getPendingOps().length, 1)
	model.stopSync()
})

/* ------------------------------------------------------------------ *
 * Work-status markers
 * ------------------------------------------------------------------ */

/** Walk one rendered element tree, recording which rows carry a status mark. */
function walkTree(node, context, out) {
	if (node === null || node === undefined || node === false || node === true) return
	if (Array.isArray(node)) {
		for (const entry of node) walkTree(entry, context, out)
		return
	}
	if (typeof node !== 'object') return
	const type = node.type
	const props = node.props || {}
	out.elements.push(node)
	if (typeof type === 'function') {
		const name = type.name
		if (name === 'StatusMark') {
			out.marks.push({ context: context.kind, id: context.id, state: props.state, label: props.label, title: props.title })
			return
		}
		if (name === 'SessionRow') {
			out.sessions.push(props.summary.id)
			walkTree(type(props), { kind: 'session', id: props.summary.id }, out)
			return
		}
		if (name === 'WorkspaceRow') {
			out.workspaces.push(props.workspace.workspaceId)
			walkTree(type(props), { kind: 'workspace', id: props.workspace.workspaceId }, out)
			return
		}
		if (name === 'CategoryRow') {
			out.categories.push(props.category.id)
			walkTree(type(props), { kind: 'category', id: props.category.id }, out)
			return
		}
		walkTree(type(props), context, out)
		return
	}
	walkTree(props.children, context, out)
}

function sessionFixture(id, overrides) {
	return Object.assign(
		{
			id,
			displayTitle: id,
			running: false,
			retainedBy: { mainView: 0 },
			blank: false,
			updatedAt: 0
		},
		overrides ?? {}
	)
}

function statusMap(entries) {
	const map = new Map()
	for (const [id, value] of Object.entries(entries)) map.set(id, value)
	return map
}

/**
 * Render `WorkspaceTree` from the loaded bundle against one fake snapshot.
 *
 * @param model - `exports.__syncModel` of a loaded bundle.
 * @param options - workspace rows, session rows, and ui-session statuses.
 * @returns row ids and status marks seen while walking the tree.
 */
function renderTree(model, options) {
	const workspaces = {
		items: options.workspaces,
		archivedSessionIds: options.archivedSessionIds ?? [],
		pinnedSessionIds: options.pinnedSessionIds ?? [],
		phase: 'ready'
	}
	const sessions = {
		ids: options.sessions.map((session) => session.id),
		byId: Object.fromEntries(options.sessions.map((session) => [session.id, session])),
		phase: 'ready'
	}
	const store = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })
	const noop = () => {}
	const props = {
		workspacesStore: store(workspaces),
		sessionsStore: store(sessions),
		sessionStatusSource: { getSnapshot: () => options.statuses ?? new Map(), subscribe: () => () => {} },
		openSession: noop,
		startSession: options.startSession ?? noop,
		createWorkspace: options.createWorkspace ?? (() => Promise.resolve(null)),
		archiveSession: noop,
		unarchiveSession: noop,
		deleteWorkspace: () => Promise.resolve(),
		renameWorkspace: () => Promise.resolve(),
		renameSession: () => Promise.resolve({ title: '' }),
		insertWorkspaceBefore: options.insertWorkspaceBefore ?? (() => Promise.resolve()),
		wide: true,
		expandSidebar: noop
	}
	const out = { marks: [], sessions: [], workspaces: [], categories: [], elements: [] }
	walkTree({ type: model.WorkspaceTree, props }, { kind: 'tree' }, out)
	return out
}

function oneWorkspace() {
	return { workspaceId: 'ws1', path: '/tmp/demo', title: 'demo', sessionIds: ['s1', 's2', 's3'] }
}

function threeSessions() {
	return [
		sessionFixture('s1', { updatedAt: 30, running: true }),
		sessionFixture('s2', { updatedAt: 20 }),
		sessionFixture('s3', { updatedAt: 10 })
	]
}

function loadShared(model, extraOps) {
	const ops = [
		{ type: 'category.add', category: { id: 'cat_a', name: '分类 A' } },
		{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_a' },
		...extraOps
	]
	model.mutateShared(ops)
}

const statusesOfThree = () =>
	statusMap({
		s1: { running: true },
		s2: { pendingInteraction: { kind: 'approval' } },
		s3: { completionUnread: true }
	})

test('an expanded workspace shows its statuses on the session rows', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: { ws1: true } })
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: statusesOfThree()
	})
	assert.deepEqual(view.sessions.sort(), ['s1', 's2', 's3'])
	assert.deepEqual(
		view.marks.map((mark) => [mark.context, mark.title]),
		[
			['session', '运行中'],
			['session', '等待审批'],
			['session', '已完成']
		]
	)
})

test('a folded workspace carries the aggregate of every hidden session row', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: {} })
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: statusesOfThree()
	})
	assert.deepEqual(view.sessions, [])
	assert.deepEqual(view.marks.map((mark) => [mark.context, mark.state, mark.title]), [
		['workspace', 'warning', '等待处理 1 · 运行中 1 · 已完成 1']
	])
})

test('a folded category carries the aggregate of its workspaces', () => {
	const { model } = loadBundle()
	loadShared(model, [{ type: 'category.add', category: { id: 'cat_b', name: '分类 B' } }])
	model.updateLocal({ collapsed: { cat_a: true }, expanded: { ws1: true } })
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: statusesOfThree()
	})
	assert.deepEqual(view.workspaces, [])
	assert.deepEqual(view.sessions, [])
	assert.deepEqual(view.marks.map((mark) => [mark.context, mark.id, mark.state, mark.title]), [
		['category', 'cat_a', 'warning', '等待处理 1 · 运行中 1 · 已完成 1']
	])
})

test('sessions hidden behind 显示更多 still report status on the workspace row', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: { ws1: true }, visible: { ws1: 1 } })
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: statusesOfThree()
	})
	// Newest first: s1 is visible, s2 + s3 are behind the watermark.
	assert.deepEqual(view.sessions, ['s1'])
	// The row header renders before its session list, so the aggregate mark
	// comes first in document order.
	assert.deepEqual(view.marks.map((mark) => [mark.context, mark.state, mark.title]), [
		['workspace', 'warning', '等待处理 1 · 已完成 1'],
		['session', 'ongoing', '运行中']
	])
})

test('a forked session is a normal workspace row; subagent rows stay hidden', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: { ws1: true } })
	const view = renderTree(model, {
		workspaces: [{ workspaceId: 'ws1', path: '/tmp/demo', title: 'demo', sessionIds: ['s1', 's_fork', 's_agent'] }],
		sessions: [
			sessionFixture('s1', { updatedAt: 30 }),
			// A fork: `parentId` is its source lineage, not subagent ownership.
			sessionFixture('s_fork', { updatedAt: 40, parentId: 's1' }),
			// A subagent child: the only kind the tree hides.
			sessionFixture('s_agent', { updatedAt: 50, parentId: 's1', origin: 'subagent' })
		]
	})
	assert.deepEqual(view.sessions, ['s_fork', 's1'])
})

test('an idle subtree shows no status mark at all', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: {}, collapsed: { cat_a: true } })
	const idleSessions = threeSessions().map((session) => Object.assign({}, session, { running: false }))
	const view = renderTree(model, { workspaces: [oneWorkspace()], sessions: idleSessions, statuses: new Map() })
	assert.deepEqual(view.marks, [])
})

test('status priority mirrors the built-in browser', () => {
	const { model } = loadBundle()
	const summary = sessionFixture('s1', { archived: false })
	assert.equal(model.sessionStatusView({ running: true, pendingInteraction: { kind: 'question' } }, summary, false).state, 'warning')
	assert.equal(model.sessionStatusView({ running: true }, summary, false).state, 'ongoing')
	assert.equal(model.sessionStatusView({ completionUnread: true }, summary, false).state, 'done')
	assert.equal(model.sessionStatusView({}, summary, false), null)
	// Archived rows cannot be opened to acknowledge a completion, so it is hidden.
	assert.equal(model.sessionStatusView({ completionUnread: true }, sessionFixture('s1', { archived: true }), true), null)

	const aggregate = model.summarizeStatuses(
		statusMap({ a: { completionUnread: true }, b: { running: true } }),
		[
			sessionFixture('a', { updatedAt: 2 }),
			sessionFixture('b', { updatedAt: 1 })
		]
	)
	assert.deepEqual(plain(aggregate), { state: 'ongoing', label: '运行中 1 · 已完成 1', count: 2 })
	assert.equal(model.summarizeStatuses(new Map(), [sessionFixture('a', { updatedAt: 1 })]), null)
})

/* ------------------------------------------------------------------ *
 * Session rename
 * ------------------------------------------------------------------ */

/** Recursively render a real element tree, collecting every element and its rendered children. */
function collectElements(node, out = []) {
	if (node === null || node === undefined || node === false || node === true) return out
	if (Array.isArray(node)) {
		for (const entry of node) collectElements(entry, out)
		return out
	}
	if (typeof node !== 'object') return out
	out.push(node)
	const props = node.props || {}
	if (typeof node.type === 'function') collectElements(node.type(props), out)
	else collectElements(props.children, out)
	return out
}

function renameFixture(events) {
	return {
		summary: sessionFixture('s1', { displayTitle: '旧标题' }),
		status: null,
		active: false,
		busy: false,
		renaming: false,
		onOpen: (id) => events.push(['open', id]),
		onArchive: (id) => events.push(['archive', id]),
		onUnarchive: (id) => events.push(['unarchive', id]),
		onRenameStart: () => events.push(['start']),
		onRenameCommit: (title) => events.push(['commit', title]),
		onRenameCancel: () => events.push(['cancel'])
	}
}

test('a session row exposes an inline rename action next to archive', () => {
	const { model } = loadBundle()
	const events = []
	const elements = collectElements(model.SessionRow(renameFixture(events)))
	const row = elements.find((element) => element.type === 'div' && String(element.props.className || '').includes('twt-session'))
	const renameButton = elements.find(
		(element) => element.type === 'button' && element.props['aria-label'] === '重命名会话'
	)
	const archiveButton = elements.find(
		(element) => element.type === 'button' && element.props['aria-label'] === '归档会话'
	)
	assert.ok(row !== undefined, 'expected the session row element')
	assert.ok(renameButton !== undefined, 'expected the rename button')
	assert.ok(archiveButton !== undefined, 'expected the archive button')
	assert.equal(elements.some((element) => element.type === 'input'), false)
	// The row starts at the label: no leading session glyph/slot is rendered.
	assert.equal(elements.some((element) => String(element.props.className || '').includes('twt-glyph')), false)

	renameButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
	assert.deepEqual(events, [['start']])
	row.props.onClick()
	assert.deepEqual(events, [['start'], ['open', 's1']])
})

test('session row hover actions sit in a zero-width container', () => {
	const { model } = loadBundle()
	const events = []
	const elements = collectElements(model.SessionRow(renameFixture(events)))
	const container = elements.find(
		(element) => element.type === 'div' && element.props.className === 'twt-session-actions'
	)
	assert.ok(container !== undefined, 'expected the session action container')
	// Both hover buttons live inside it, so at rest they reserve no width and
	// the status dot sits at the row end.
	const labels = collectElements(container)
		.filter((element) => element.type === 'button')
		.map((element) => element.props['aria-label'])
	assert.deepEqual(labels, ['重命名会话', '归档会话'])
})

test('a blank session row does not offer rename', () => {
	const { model } = loadBundle()
	const events = []
	const elements = collectElements(
		model.SessionRow(
			Object.assign(renameFixture(events), {
				summary: sessionFixture('s1', { displayTitle: 'demo', blank: true })
			})
		)
	)
	const labels = elements.filter((element) => element.type === 'button').map((element) => element.props['aria-label'])
	assert.equal(labels.includes('重命名会话'), false)
	assert.ok(labels.includes('归档会话'))
})

test('the tree hides abandoned blank sessions and keeps the ones still in use', () => {
	const now = Date.now()
	const tenMinutesAgo = now - 10 * 60 * 1000
	const { model } = loadBundle({
		storage: memoryStorage({
			// The official conversation plugin persists drafts per Session; a
			// blank Session with an unsent draft must not vanish from the tree.
			'dsh.conversation.s4': JSON.stringify({ draft: { text: '还没发送', references: [] } })
		})
	})
	const workspace = {
		workspaceId: 'ws1',
		path: '/tmp/demo',
		title: 'demo',
		sessionIds: ['s1', 's2', 's3', 's4', 's5']
	}
	model.updateLocal({ expanded: { ws1: true } })
	const view = renderTree(model, {
		workspaces: [workspace],
		sessions: [
			// Left behind by an earlier page load (a phone visit): hidden.
			sessionFixture('s1', { blank: true, updatedAt: tenMinutesAgo }),
			// A Session that already has a turn: always visible.
			sessionFixture('s2', { updatedAt: 30 }),
			// The Session the main view holds (the just-created row): visible.
			sessionFixture('s3', { blank: true, retainedBy: { mainView: 1 }, updatedAt: tenMinutesAgo }),
			// Blank with an unsent composer draft: visible.
			sessionFixture('s4', { blank: true, updatedAt: tenMinutesAgo }),
			// Blank created moments ago, before its first message lands: visible.
			sessionFixture('s5', { blank: true, updatedAt: now })
		],
		statuses: new Map()
	})
	assert.deepEqual(view.sessions.sort(), ['s2', 's3', 's4', 's5'])
})

test('isEmptySession removes only unused, old, undrafted blank rows', () => {
	const now = 10_000_000
	const tenMinutesAgo = now - 10 * 60 * 1000
	const { model } = loadBundle({
		storage: memoryStorage({
			'dsh.conversation.drafted': JSON.stringify({ draft: { text: 'typed' } }),
			'dsh.conversation.legacy': JSON.stringify({ draft: 'old string format' }),
			'dsh.conversation.referenced': JSON.stringify({
				draft: { text: '  ', references: [{ source: 'file', ref: 'plain.txt' }] }
			}),
			'dsh.conversation.emptydraft': JSON.stringify({ draft: { text: '   ', references: [] } })
		})
	})
	const blank = (id, overrides) =>
		sessionFixture(id, Object.assign({ blank: true, updatedAt: tenMinutesAgo }, overrides ?? {}))
	assert.equal(model.isEmptySession(blank('old'), undefined, now), true)
	assert.equal(model.isEmptySession(blank('emptydraft'), undefined, now), true)
	assert.equal(model.isEmptySession(sessionFixture('normal', { updatedAt: 30 }), undefined, now), false)
	assert.equal(model.isEmptySession(blank('active'), 'active', now), false)
	assert.equal(model.isEmptySession(blank('fresh', { updatedAt: now - 1000 }), undefined, now), false)
	assert.equal(model.isEmptySession(blank('drafted'), undefined, now), false)
	assert.equal(model.isEmptySession(blank('legacy'), undefined, now), false)
	assert.equal(model.isEmptySession(blank('referenced'), undefined, now), false)
	assert.equal(model.isEmptySession(blank('running', { running: true }), undefined, now), false)
	assert.equal(model.isEmptySession(blank('titled', { title: 'keep me' }), undefined, now), false)
	assert.equal(model.isEmptySession(undefined, undefined, now), false)
})

test('draftHasContent accepts text, references and commands but not whitespace', () => {
	const { model } = loadBundle()
	assert.equal(model.draftHasContent(''), false)
	assert.equal(model.draftHasContent('  \n '), false)
	assert.equal(model.draftHasContent('hello'), true)
	assert.equal(model.draftHasContent({ text: 'hello' }), true)
	assert.equal(model.draftHasContent({ text: '', references: [] }), false)
	assert.equal(model.draftHasContent({ text: '', references: [{ ref: 'a.txt' }] }), true)
	assert.equal(model.draftHasContent({ text: '', command: { token: '/review' } }), true)
})

test('the inline session editor commits, cancels, and never opens the row', () => {
	const { model } = loadBundle()
	const events = []
	const editing = collectElements(model.SessionRow(Object.assign(renameFixture(events), { renaming: true })))
	const input = editing.find((element) => element.type === 'input')
	const row = editing.find((element) => element.type === 'div' && String(element.props.className || '').includes('twt-session'))
	assert.ok(input !== undefined, 'expected the inline input')
	assert.equal(input.props.defaultValue, '旧标题')
	assert.equal(input.props.autoFocus, true)

	// While editing, a row click is the input's own (blur), never navigation.
	row.props.onClick()
	assert.deepEqual(events, [])

	input.props.onKeyDown({ key: 'Enter', currentTarget: { value: '新标题' }, stopPropagation() {} })
	assert.deepEqual(events, [['commit', '新标题']])

	events.length = 0
	input.props.onKeyDown({ key: 'Escape', currentTarget: { value: '新标题' }, stopPropagation() {} })
	assert.deepEqual(events, [['cancel']])

	events.length = 0
	input.props.onBlur({ target: { value: '失焦标题' } })
	assert.deepEqual(events, [['commit', '失焦标题']])
})

/** A navigator context with only the services the rename adapter touches. */
function renameContext(overrides = {}) {
	const requests = []
	const state = { refreshed: 0, requests }
	const ctx = {
		get(name) {
			if (name === 'remote.session') {
				if ('sessionRemote' in overrides) return overrides.sessionRemote
				return {
					rename: (request) => {
						requests.push(request)
						return Promise.resolve({ ok: true, value: { title: request.title.trim(), seq: 12 } })
					}
				}
			}
			if (name === 'remote') return overrides.remote
			if (name === 'sessions') {
				return {
					refresh: () => {
						state.refreshed += 1
						return Promise.resolve()
					}
				}
			}
			return undefined
		}
	}
	return { ctx, state }
}

test('the rename adapter calls the generated session Remote and refreshes the list', async () => {
	const { model } = loadBundle()
	const { ctx, state } = renameContext()
	const navigator = model.createNavigator(ctx)

	const value = await navigator.renameSession('s1', '  新标题  ')
	assert.deepEqual(plain(value), { title: '新标题', seq: 12 })
	assert.deepEqual(plain(state.requests), [{ sessionId: 's1', title: '  新标题  ' }])
	assert.equal(state.refreshed, 1)
})

test('the rename adapter falls back to the root remote service and reports Host refusals', async () => {
	const { model } = loadBundle()
	const remote = {
		rename: () => Promise.resolve({ ok: false, error: { code: 'session/title-invalid', message: '标题不能为空' } })
	}
	const { ctx } = renameContext({ sessionRemote: undefined, remote: { session: remote } })
	const navigator = model.createNavigator(ctx)
	await assert.rejects(
		() => navigator.renameSession('s1', ''),
		(error) => String(error && error.message) === '标题不能为空'
	)
})

test('the rename adapter refuses to run without a mounted session Remote', async () => {
	const { model } = loadBundle()
	const { ctx } = renameContext({ sessionRemote: undefined, remote: undefined })
	const navigator = model.createNavigator(ctx)
	await assert.rejects(
		() => navigator.renameSession('s1', '新标题'),
		(error) => String(error && error.message).includes('会话重命名服务不可用')
	)
})

/**
 * A navigator context exposing only the workspace-creation seams: a recording
 * `workspaces.create` plus whatever extras a case needs.
 */
function workspaceContext(services = {}) {
	const created = []
	const ctx = {
		get(name) {
			if (name === 'workspaces') {
				return {
					create: (request) => {
						created.push(request.path)
						return Promise.resolve({
							workspaceId: `ws-${created.length}`,
							path: request.path,
							title: 'ws',
							sessionIds: []
						})
					}
				}
			}
			return services[name]
		}
	}
	return { ctx, created }
}

test('the new-workspace flow prefers the default-directory service', async () => {
	const { model } = loadBundle()
	const { ctx, created } = workspaceContext({
		workspaceDefaultDirectory: { pick: () => Promise.resolve('/srv/projects/demo') }
	})
	const workspace = await model.createNavigator(ctx).createWorkspace()
	assert.deepEqual(plain(workspace), {
		workspaceId: 'ws-1',
		path: '/srv/projects/demo',
		title: 'ws',
		sessionIds: []
	})
	assert.deepEqual(plain(created), ['/srv/projects/demo'])
})

test('the new-workspace flow falls back to the desktop bridge, then to uiWorkspace', async () => {
	const desktop = loadBundle({
		globals: { __DSH_DIRECTORY_PICKER__: { pick: () => Promise.resolve('/from/desktop') } }
	})
	const fromBridge = await desktop.model
		.createNavigator(workspaceContext().ctx)
		.createWorkspace()
	assert.equal(fromBridge.path, '/from/desktop')

	const ui = loadBundle()
	const fromUi = await ui.model
		.createNavigator(workspaceContext({ uiWorkspace: { pickDirectory: () => Promise.resolve('/from/ui') } }).ctx)
		.createWorkspace()
	assert.equal(fromUi.path, '/from/ui')
})

test('cancelling the picker creates no workspace and a missing picker explains itself', async () => {
	const { model } = loadBundle()
	const cancelled = await model
		.createNavigator(workspaceContext({ workspaceDefaultDirectory: { pick: () => Promise.resolve(null) } }).ctx)
		.createWorkspace()
	assert.equal(cancelled, null)

	const { ctx, created } = workspaceContext()
	await assert.rejects(
		() => model.createNavigator(ctx).createWorkspace(),
		(error) => String(error && error.message).includes('没有可用的目录选择器')
	)
	assert.deepEqual(plain(created), [])
})

test('missing core controllers degrade to stable empty stores instead of throwing', () => {
	const { model } = loadBundle()
	const stores = model.coreStores({ get: () => undefined })
	assert.deepEqual(plain(stores.workspacesStore.getSnapshot()), {
		items: [],
		archivedSessionIds: [],
		pinnedSessionIds: [],
		phase: 'ready'
	})
	assert.deepEqual(plain(stores.sessionsStore.getSnapshot()), { ids: [], byId: {}, phase: 'ready' })
	// React's useSyncExternalStore contract: an unchanged read is identity-stable.
	assert.equal(stores.workspacesStore.getSnapshot(), stores.workspacesStore.getSnapshot())
	assert.equal(stores.sessionsStore.getSnapshot(), stores.sessionsStore.getSnapshot())
	assert.equal(typeof stores.workspacesStore.subscribe(() => {}), 'function')

	// The live controllers, when present, are handed through untouched.
	const workspacesList = { getSnapshot: () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready' }), subscribe: () => () => {} }
	const sessionsList = { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} }
	const live = model.coreStores({
		get: (name) => (name === 'workspaces' ? { list: workspacesList } : name === 'sessions' ? { list: sessionsList } : undefined)
	})
	assert.equal(live.workspacesStore, workspacesList)
	assert.equal(live.sessionsStore, sessionsList)

	// And the tree renders its empty state with the degraded stores instead of throwing.
	const out = renderTree(model, { workspaces: [], sessions: [] })
	assert.deepEqual(plain(out.workspaces), [])
})

/* ------------------------------------------------------------------ *
 * Manual ordering and drag insertion rules
 * ------------------------------------------------------------------ */

test('a saved manual order drives the session rows, strangers leading', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: { ws1: true } })
	model.mutateShared([{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s2', 's1', 's3'] }])
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: new Map()
	})
	assert.deepEqual(view.sessions, ['s2', 's1', 's3'])

	// The saved order survives a Host round trip and an unrelated update.
	const { model: second } = loadBundle()
	second.adoptRemote(
		{
			rev: 2,
			categories: [],
			assign: {},
			sessionOrder: { ws1: ['s2', 's1', 's3'] }
		},
		false
	)
	second.updateLocal({ expanded: { ws1: true } })
	const afterAdopt = renderTree(second, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: new Map()
	})
	assert.deepEqual(afterAdopt.sessions, ['s2', 's1', 's3'])
})

test('members missing from the saved order lead it, and pinned rows front it', () => {
	const { model } = loadBundle()
	const saved = ['s1', 's2'] // s3 is new since the order was saved
	model.updateLocal({ expanded: { ws1: true } })
	model.mutateShared([{ type: 'session.order', workspaceId: 'ws1', sessionIds: saved }])
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		statuses: new Map()
	})
	assert.deepEqual(view.sessions, ['s3', 's1', 's2'])

	const { model: pinnedModel } = loadBundle()
	pinnedModel.updateLocal({ expanded: { ws1: true } })
	pinnedModel.mutateShared([{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s2', 's3', 's1'] }])
	const pinned = renderTree(pinnedModel, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		pinnedSessionIds: ['s1', 's3'],
		statuses: new Map()
	})
	assert.deepEqual(pinned.sessions, ['s3', 's1', 's2'])
})

test('the drag insertion rule is before/after exact and idempotent', () => {
	const { model } = loadBundle()
	const ids = ['a', 'b', 'c']

	assert.deepEqual(plain(model.resolveReorder(ids, 'a', 'b', 'after')), { order: ['b', 'a', 'c'], anchor: 'c' })
	assert.deepEqual(plain(model.resolveReorder(ids, 'b', 'a', 'before')), { order: ['b', 'a', 'c'], anchor: 'a' })
	assert.deepEqual(plain(model.resolveReorder(ids, 'b', 'a', 'after')), { order: ['a', 'b', 'c'], anchor: 'c' })
	assert.deepEqual(plain(model.resolveReorder(ids, 'c', 'b', 'after')), { order: ['a', 'b', 'c'] })
	assert.deepEqual(plain(model.resolveReorder(ids, 'a', 'c', 'after')), { order: ['b', 'c', 'a'] })
	assert.deepEqual(plain(model.resolveReorder(ids, 'a', 'a', 'before')), null)
	// A workspace dragged across categories is not in the target group yet; the
	// helper still inserts it at the row under the pointer.
	assert.deepEqual(plain(model.resolveReorder(ids, 'x', 'a', 'before')), { order: ['x', 'a', 'b', 'c'], anchor: 'a' })
	assert.deepEqual(plain(model.resolveReorder(ids, 'a', 'x', 'before')), null)
})

/* ------------------------------------------------------------------ *
 * Drop handlers (DOM-free: call the real closures with a synthetic event)
 * ------------------------------------------------------------------ */

function dragEvent(mime, id, clientY, rect = { top: 0, height: 20 }) {
	return {
		clientY,
		currentTarget: { getBoundingClientRect: () => rect },
		dataTransfer: {
			getData: (type) => (type === mime ? id : ''),
			setData() {},
			effectAllowed: 'move',
			dropEffect: 'move'
		},
		preventDefault() {},
		stopPropagation() {}
	}
}

function findElement(view, name, predicate) {
	return view.elements.find((element) => typeof element.type === 'function' && element.type.name === name && predicate(element.props))
}

function workspaceFixture(workspaceId, title, sessionIds) {
	return { workspaceId, path: '/tmp/' + workspaceId, title, sessionIds }
}

test('dropping a workspace between two rows inserts it and follows the category', async () => {
	const insertCalls = []
	const { model } = loadBundle()
	loadShared(model, [
		{ type: 'category.add', category: { id: 'cat_b', name: '分类 B' } },
		{ type: 'assign', workspaceId: 'ws2', categoryId: 'cat_b' }
	])
	const view = renderTree(model, {
		workspaces: [workspaceFixture('ws1', 'demo', []), workspaceFixture('ws2', 'other', [])],
		sessions: [],
		insertWorkspaceBefore: (workspaceId, anchor) => {
			insertCalls.push([workspaceId, anchor])
			return Promise.resolve()
		}
	})
	const target = findElement(view, 'WorkspaceRow', (props) => props.workspace.workspaceId === 'ws2')
	assert.ok(target !== undefined)
	// Drop ws1 on the upper half of ws2: insert before it, and move into cat_b.
	target.props.onWorkspaceDrop(dragEvent('application/x-dsh-workspace', 'ws1', 1))
	await tick()
	assert.deepEqual(plain(insertCalls), [['ws1', 'ws2']])
	assert.equal(plain(model.getSharedState()).assign.ws1, 'cat_b')
})

test('dropping a workspace on the lower half of the last row appends within its category', async () => {
	const insertCalls = []
	const { model } = loadBundle()
	loadShared(model, [])
	const view = renderTree(model, {
		workspaces: [workspaceFixture('ws1', 'demo', []), workspaceFixture('ws2', 'other', [])],
		sessions: [],
		insertWorkspaceBefore: (workspaceId, anchor) => {
			insertCalls.push([workspaceId, anchor])
			return Promise.resolve()
		}
	})
	const first = findElement(view, 'WorkspaceRow', (props) => props.workspace.workspaceId === 'ws1')
	const second = findElement(view, 'WorkspaceRow', (props) => props.workspace.workspaceId === 'ws2')
	// Dropping ws1 right before ws2 is already the current order: no Host call.
	first.props.onWorkspaceDrop(dragEvent('application/x-dsh-workspace', 'ws1', 1))
	await tick()
	assert.deepEqual(plain(insertCalls), [])

	// Dropping the first row below the last row appends it (anchor undefined).
	second.props.onWorkspaceDrop(dragEvent('application/x-dsh-workspace', 'ws1', 19))
	await tick()
	assert.equal(insertCalls.length, 1)
	assert.equal(insertCalls[0][0], 'ws1')
	assert.equal(insertCalls[0][1], undefined)
})

test('dropping a session before another row rewrites the shared manual order', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: { ws1: true } })
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions()
	})
	const target = findElement(view, 'SessionRow', (props) => props.summary.id === 's2')
	assert.ok(target !== undefined)
	// Drag s3 (last rendered) onto the upper half of s2.
	target.props.onDrop(dragEvent('application/x-dsh-session', 's3', 1))
	assert.deepEqual(plain(model.getSharedState()).sessionOrder.ws1, ['s1', 's3', 's2'])
})

test('a pinned row cannot be dropped across the pin boundary', () => {
	const { model } = loadBundle()
	loadShared(model, [])
	model.updateLocal({ expanded: { ws1: true } })
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: threeSessions(),
		pinnedSessionIds: ['s1']
	})
	const target = findElement(view, 'SessionRow', (props) => props.summary.id === 's2')
	target.props.onDrop(dragEvent('application/x-dsh-session', 's1', 1))
	assert.equal(model.getSharedState().sessionOrder.ws1, undefined)
})

test('session.order waits for a Host that reports sessionOrder', async () => {
	let upgraded = false
	let rev = 0
	const posts = []
	const fetch = (path, init) => {
		const method = init === undefined || init.method === undefined ? 'GET' : init.method
		if (method === 'POST') {
			const body = JSON.parse(init.body)
			posts.push(body)
			rev += 1
			const response = { rev, categories: [], assign: {}, applied: body.ops.length }
			if (upgraded) response.sessionOrder = {}
			return jsonResponse(response)
		}
		const response = { rev, categories: [], assign: {}, changed: rev === 0 }
		if (upgraded) response.sessionOrder = {}
		return jsonResponse(response)
	}
	const { model } = loadBundle({ fetch })
	model.startSync()
	// Wait for the bootstrap GET; the response has no sessionOrder, so the Host
	// is treated as not supporting manual session order.
	await tick()
	await tick()
	assert.equal(posts.length, 0)

	model.mutateShared([{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s2', 's1'] }])
	await tick()
	// Nothing was sent: the only pending op cannot be understood by this Host.
	assert.equal(posts.length, 0)
	assert.equal(model.getPendingOps().length, 1)

	// A category edit is still delivered; the order op stays queued behind it.
	model.mutateShared([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	await tick()
	await tick()
	assert.equal(posts.length, 1)
	assert.deepEqual(plain(posts[0].ops), [{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	assert.equal(model.getPendingOps().length, 1)
	assert.equal(model.getPendingOps()[0].type, 'session.order')

	// After a Host upgrade the shape is reported and the queued op is flushed.
	upgraded = true
	model.bootstrapSync()
	await tick()
	await tick()
	await tick()
	const sent = posts.flatMap((body) => body.ops)
	assert.ok(sent.some((op) => op.type === 'session.order'))
	assert.equal(model.getPendingOps().length, 0)
	model.stopSync()
})

test('dropping a category onto another category header moves it in the shared order', () => {
	const { model } = loadBundle()
	loadShared(model, [{ type: 'category.add', category: { id: 'cat_b', name: '分类 B' } }])
	const view = renderTree(model, {
		workspaces: [oneWorkspace()],
		sessions: []
	})
	const target = findElement(view, 'CategoryRow', (props) => props.category.id === 'cat_a')
	assert.ok(target !== undefined)
	// Drag cat_b onto the upper half of cat_a: [cat_a, cat_b] -> [cat_b, cat_a].
	target.props.onDrop(dragEvent('application/x-dsh-category', 'cat_b', 1))
	const order = plain(model.getSharedState()).categories.map((category) => category.id)
	assert.deepEqual(order, ['cat_b', 'cat_a'])
	// Dropping the first category below the last one appends it at the end. The
	// drop closure reads the category order from its render, so re-render first.
	const view2 = renderTree(model, { workspaces: [oneWorkspace()], sessions: [] })
	const last = findElement(view2, 'CategoryRow', (props) => props.category.id === 'cat_a')
	last.props.onDrop(dragEvent('application/x-dsh-category', 'cat_b', 19))
	const appended = plain(model.getSharedState()).categories.map((category) => category.id)
	assert.deepEqual(appended, ['cat_a', 'cat_b'])
})

test('category.move stays queued until the Host advertises the operation', async () => {
	let upgraded = false
	let rev = 0
	const posts = []
	const fetch = (path, init) => {
		const method = init === undefined || init.method === undefined ? 'GET' : init.method
		const shape = () => ({
			rev,
			categories: [],
			assign: {},
			sessionOrder: {},
			...(upgraded ? { features: ['category.move', 'session.order'] } : {})
		})
		if (method === 'POST') {
			const body = JSON.parse(init.body)
			posts.push(body)
			rev += 1
			return jsonResponse(Object.assign(shape(), { applied: body.ops.length }))
		}
		return jsonResponse(Object.assign(shape(), { changed: false }))
	}
	const { model } = loadBundle({ fetch })
	model.startSync()
	await tick()
	await tick()

	model.mutateShared([{ type: 'category.move', id: 'cat_a', beforeId: null }])
	await tick()
	// The running Host predates `category.move`: nothing is sent, the op waits.
	assert.equal(posts.length, 0)
	assert.equal(model.getPendingOps().length, 1)

	upgraded = true
	model.bootstrapSync()
	await tick()
	await tick()
	await tick()
	const sent = posts.flatMap((body) => body.ops)
	assert.ok(sent.some((op) => op.type === 'category.move'))
	assert.equal(model.getPendingOps().length, 0)
	model.stopSync()
})

/* ------------------------------------------------------------------ *
 * Add-workspace: the opening Session
 * ------------------------------------------------------------------ */

test('a newly added workspace starts and opens its first Session', async () => {
	const started = []
	const created = { workspaceId: 'ws2', path: '/tmp/ws2', title: 'ws2', sessionIds: [] }
	const { model } = loadBundle()
	loadShared(model, [])
	const view = renderTree(model, {
		workspaces: [workspaceFixture('ws1', 'demo', [])],
		sessions: [],
		createWorkspace: () => Promise.resolve(created),
		startSession: (workspaceId) => started.push(workspaceId)
	})
	const row = findElement(view, 'CategoryRow', (props) => props.category.id === 'cat_a')
	assert.ok(row !== undefined)
	row.props.onNewWorkspace()
	await tick()
	await tick()
	assert.deepEqual(plain(started), ['ws2'])
	// The new row is expanded so the Session it just opened is visible in the tree.
	assert.equal(plain(model.getViewState().expanded).ws2, true)
	assert.equal(plain(model.getSharedState()).assign.ws2, 'cat_a')
})

test('picking an already-registered folder adopts the row without opening another Session', async () => {
	const started = []
	const { model } = loadBundle()
	loadShared(model, [])
	const view = renderTree(model, {
		workspaces: [workspaceFixture('ws1', 'demo', [])],
		sessions: [],
		createWorkspace: () => Promise.resolve({ workspaceId: 'ws1', path: '/tmp/ws1', title: 'demo', sessionIds: [] }),
		startSession: (workspaceId) => started.push(workspaceId)
	})
	const row = findElement(view, 'CategoryRow', (props) => props.category.id === 'cat_a')
	row.props.onNewWorkspace()
	await tick()
	await tick()
	assert.deepEqual(plain(started), [])
})
