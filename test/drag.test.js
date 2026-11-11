/**
 * Drag behaviour tests.
 *
 * Two rules are under test:
 *
 *  1. While a row is dragged, the tree folds everything below the dragged
 *     level (categories hide workspaces, workspaces hide sessions, sessions
 *     hide nothing) and the previous open/closed layout comes back when the
 *     drag ends. The fold is view-only: nothing is written to the saved state.
 *  2. Holding the dragged row in the top or bottom edge band of the list
 *     scrolls the list, so rows beyond the viewport stay reachable.
 *
 * The real bundle is mounted in a fake React with per-instance hook state, so
 * the tests deliver the component's own drag handlers the way a browser does
 * and read the row tree back — no DOM required.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadBundle, memoryStorage } from '../test-harness/bundle.js'

/* ------------------------------------------------------------------ *
 * A tiny stateful React stand-in
 * ------------------------------------------------------------------ */

/**
 * Mount function components for real: hook cells live per instance, state
 * setters re-render the whole tree synchronously, and effects run after the
 * render that registered them, cleanups included.
 */
function createRenderer() {
	const instances = new Map()
	const effectQueue = []
	const cleanupQueue = []
	let current = null
	let slot = 0
	let drawing = false
	let dirty = false
	let root = null
	let view = null

	const react = {
		createElement(type, props, ...children) {
			const normalized = Object.assign({}, props)
			normalized.children = children.length === 1 ? children[0] : children
			return { type, props: normalized }
		},
		useState(initial) {
			const cell = current
			const index = slot
			slot += 1
			if (!(index in cell.hooks)) cell.hooks[index] = typeof initial === 'function' ? initial() : initial
			const set = (next) => {
				const value = typeof next === 'function' ? next(cell.hooks[index]) : next
				if (Object.is(value, cell.hooks[index])) return
				cell.hooks[index] = value
				if (drawing) dirty = true
				else draw()
			}
			return [cell.hooks[index], set]
		},
		useRef(initial) {
			const cell = current
			const index = slot
			slot += 1
			if (!(index in cell.hooks)) cell.hooks[index] = { current: initial }
			return cell.hooks[index]
		},
		useMemo(fn) {
			slot += 1
			return fn()
		},
		useCallback(fn) {
			slot += 1
			return fn
		},
		useEffect(fn, deps) {
			const cell = current
			const index = slot
			slot += 1
			const previous = cell.effects[index]
			const unchanged =
				previous !== undefined &&
				deps !== undefined &&
				previous.deps !== undefined &&
				deps.length === previous.deps.length &&
				deps.every((value, at) => Object.is(value, previous.deps[at]))
			if (unchanged) return
			if (previous !== undefined && typeof previous.cleanup === 'function') cleanupQueue.push(previous.cleanup)
			const record = { deps: deps === undefined ? undefined : deps.slice(), cleanup: undefined }
			cell.effects[index] = record
			effectQueue.push(() => {
				const cleanup = fn()
				if (typeof cleanup === 'function') record.cleanup = cleanup
			})
		},
		useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
	}

	function instanceAt(path) {
		let cell = instances.get(path)
		if (cell === undefined) {
			cell = { hooks: [], effects: [] }
			instances.set(path, cell)
		}
		return cell
	}

	function renderComponent(type, props, path) {
		const previous = current
		const previousSlot = slot
		current = instanceAt(path)
		slot = 0
		try {
			return type(props)
		} finally {
			current = previous
			slot = previousSlot
		}
	}

	function expand(node, path) {
		if (node === null || node === undefined || node === false || node === true) return node
		if (Array.isArray(node)) return node.map((child, index) => expand(child, path + ':' + index))
		if (typeof node !== 'object') return node
		const type = node.type
		const props = node.props || {}
		if (typeof type === 'function') {
			const name = type.name
			return {
				type: name,
				props,
				children: expand(renderComponent(type, props, path + '/' + name), path + '/' + name)
			}
		}
		return { type, props, children: expand(props.children, path + '/<' + String(type) + '>') }
	}

	function draw() {
		drawing = true
		effectQueue.length = 0
		cleanupQueue.length = 0
		const expanded = expand(root, 'root')
		for (const cleanup of cleanupQueue.splice(0)) cleanup()
		for (const run of effectQueue.splice(0)) run()
		drawing = false
		if (dirty) {
			dirty = false
			return draw()
		}
		view = expanded
		return view
	}

	return {
		react,
		mount(Component, props) {
			instances.clear()
			root = { type: Component, props }
			return draw()
		},
		get view() {
			return view
		}
	}
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A window stand-in that records listeners and runs animation frames on demand. */
function dragWindow() {
	const listeners = new Map()
	const frames = []
	let nextId = 1
	const window = {
		location: { protocol: 'http:', href: 'http://harness.invalid/' },
		setTimeout: () => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		requestAnimationFrame(callback) {
			const id = nextId
			nextId += 1
			frames.push({ id, callback })
			return id
		},
		cancelAnimationFrame(id) {
			const at = frames.findIndex((entry) => entry.id === id)
			if (at !== -1) frames.splice(at, 1)
		},
		addEventListener(type, handler) {
			if (!listeners.has(type)) listeners.set(type, new Set())
			listeners.get(type).add(handler)
		},
		removeEventListener(type, handler) {
			const set = listeners.get(type)
			if (set !== undefined) set.delete(handler)
		}
	}
	return {
		window,
		listeners,
		frames,
		dispatch(type, event) {
			for (const handler of Array.from(listeners.get(type) ?? [])) handler(event)
		},
		runFrames(times) {
			for (let index = 0; index < times; index += 1) {
				const frame = frames.shift()
				if (frame === undefined) return
				frame.callback()
			}
		}
	}
}

function sessionFixture(id) {
	return { id, displayTitle: id, running: false, retainedBy: { mainView: 0 }, blank: false, updatedAt: 0 }
}

const WORKSPACES = [
	{ workspaceId: 'ws1', path: '/tmp/ws1', title: 'ws1', sessionIds: ['s1', 's2'] },
	{ workspaceId: 'ws2', path: '/tmp/ws2', title: 'ws2', sessionIds: ['s3'] },
	{ workspaceId: 'ws3', path: '/tmp/ws3', title: 'ws3', sessionIds: ['s4'] }
]

const SESSIONS = ['s1', 's2', 's3', 's4'].map(sessionFixture)

/**
 * Load a fresh bundle and mount the real tree with two categories, three
 * workspaces (one unassigned) and every workspace expanded.
 */
function mountTree(options = {}) {
	const storage = options.storage ?? memoryStorage()
	const drag = dragWindow()
	// Any confirmation the row action asks for is accepted by default.
	drag.window.confirm = options.confirm ?? (() => true)
	const renderer = createRenderer()
	const { model } = loadBundle({ storage, window: drag.window, react: renderer.react })
	model.mutateShared([
		{ type: 'category.add', category: { id: 'cat_a', name: '分类 A' } },
		{ type: 'category.add', category: { id: 'cat_b', name: '分类 B' } },
		{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_a' },
		{ type: 'assign', workspaceId: 'ws2', categoryId: 'cat_b' }
	])
	model.updateLocal({ expanded: { ws1: true, ws2: true, ws3: true } })
	const workspaces = {
		items: options.workspaces ?? WORKSPACES,
		archivedSessionIds: [],
		pinnedSessionIds: [],
		phase: 'ready'
	}
	const sessions = {
		ids: SESSIONS.map((session) => session.id),
		byId: Object.fromEntries(SESSIONS.map((session) => [session.id, session])),
		phase: 'ready'
	}
	const store = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })
	const props = {
		workspacesStore: store(workspaces),
		sessionsStore: store(sessions),
		sessionStatusSource: { getSnapshot: () => new Map(), subscribe: () => () => {} },
		openSession: () => {},
		startSession: () => {},
		createWorkspace: () => Promise.resolve(null),
		archiveSession: options.archiveSession ?? (() => {}),
		unarchiveSession: () => {},
		deleteWorkspace: options.deleteWorkspace ?? (() => Promise.resolve()),
		renameWorkspace: () => Promise.resolve(),
		renameSession: () => Promise.resolve({ title: '' }),
		insertWorkspaceBefore: options.insertWorkspaceBefore ?? (() => Promise.resolve()),
		wide: true,
		expandSidebar: () => {}
	}
	renderer.mount(model.WorkspaceTree, props)
	const count = (name) => collect(renderer.view, name).length
	return {
		model,
		drag,
		storage,
		renderer,
		count,
		rows: (name) => collect(renderer.view, name)
	}
}

/** Every node of one component/host type in the rendered tree, depth first. */
function collect(node, type, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out
	if (Array.isArray(node)) {
		for (const child of node) collect(child, type, out)
		return out
	}
	if (node.type === type) out.push(node)
	collect(node.children, type, out)
	return out
}

/** A drag event with just enough DataTransfer for the row handlers. */
function dragEvent(overrides = {}) {
	const data = new Map()
	return Object.assign(
		{
			stopPropagation: () => {},
			preventDefault: () => {},
			clientX: 100,
			clientY: 200,
			currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, right: 200, height: 20 }) },
			dataTransfer: {
				setData: (type, value) => data.set(type, value),
				getData: (type) => data.get(type) ?? '',
				effectAllowed: '',
				dropEffect: ''
			}
		},
		overrides
	)
}

function categoryRow(tree, id) {
	const row = tree.rows('CategoryRow').find((node) => node.props.category.id === id)
	assert.ok(row !== undefined, `missing category row ${id}`)
	return row
}

function workspaceRow(tree, id) {
	const row = tree.rows('WorkspaceRow').find((node) => node.props.workspace.workspaceId === id)
	assert.ok(row !== undefined, `missing workspace row ${id}`)
	return row
}

/** The scrolled list element (`div.twt-scroll`) and its ref. */
function listElement(tree) {
	const element = collect(tree.renderer.view, 'div').find((node) => node.props.className === 'twt-scroll')
	assert.ok(element !== undefined, 'missing the scrolling list')
	return element
}

function fakeList(overrides = {}) {
	return Object.assign(
		{
			scrollTop: 0,
			clientHeight: 200,
			scrollHeight: 900,
			getBoundingClientRect: () => ({ top: 100, bottom: 300, left: 0, right: 240, height: 200 })
		},
		overrides
	)
}

/** The drag drop bar, present only while a row is dragged. */
function dragBar(tree) {
	return collect(tree.renderer.view, 'div').find((node) => node.props.className === 'twt-drag-bar')
}

/** The two zones of the drag bar, cancel first. */
function dropZones(tree) {
	return collect(tree.renderer.view, 'div').filter((node) =>
		String(node.props.className ?? '').includes('twt-drop-zone')
	)
}

/** Cross-realm objects from the VM need normalizing before deepEqual. */
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function tick() {
	return new Promise((resolve) => setImmediate(resolve))
}

/* ------------------------------------------------------------------ *
 * Pure rules
 * ------------------------------------------------------------------ */

test('a drag folds the level below the dragged row and nothing else', () => {
	const { model } = loadBundle()
	assert.equal(model.dragFoldOf(null), null)
	assert.equal(model.dragFoldOf({ kind: 'category', categoryId: 'cat_a' }), 'categories')
	assert.equal(model.dragFoldOf({ kind: 'workspace', workspaceId: 'ws1' }), 'workspaces')
	assert.equal(model.dragFoldOf({ kind: 'session', workspaceId: 'ws1', sessionId: 's1' }), null)
})

test('edge autoscroll only moves while the pointer is in a band it can scroll', () => {
	const { model } = loadBundle()
	const view = {
		top: 100,
		bottom: 300,
		left: 0,
		right: 240,
		scrollTop: 100,
		clientHeight: 200,
		scrollHeight: 900
	}
	// Middle of the list: no movement.
	assert.equal(model.autoScrollStep({ x: 100, y: 200 }, view), 0)
	// Top band scrolls up, bottom band scrolls down.
	assert.ok(model.autoScrollStep({ x: 100, y: 104 }, view) < 0)
	assert.ok(model.autoScrollStep({ x: 100, y: 296 }, view) > 0)
	// Closer to the edge scrolls faster.
	assert.ok(
		Math.abs(model.autoScrollStep({ x: 100, y: 102 }, view)) >
			Math.abs(model.autoScrollStep({ x: 100, y: 132 }, view))
	)
	// Already at an end: nothing to scroll.
	assert.equal(model.autoScrollStep({ x: 100, y: 104 }, Object.assign({}, view, { scrollTop: 0 })), 0)
	assert.equal(model.autoScrollStep({ x: 100, y: 296 }, Object.assign({}, view, { scrollTop: 700 })), 0)
	// A pointer away from the list, or a list with nothing to scroll, leaves it alone.
	assert.equal(model.autoScrollStep({ x: 900, y: 104 }, view), 0)
	assert.equal(model.autoScrollStep({ x: 100, y: 296 }, Object.assign({}, view, { scrollHeight: 200 })), 0)
})

/* ------------------------------------------------------------------ *
 * Category drags fold workspaces
 * ------------------------------------------------------------------ */

test('dragging a category folds every workspace away, and dragend restores them', () => {
	const tree = mountTree()
	assert.equal(tree.count('WorkspaceRow'), 3)
	assert.equal(tree.count('SessionRow'), 4)
	const before = JSON.stringify(tree.storage.entries())

	categoryRow(tree, 'cat_a').props.onDragStart(dragEvent())
	// Only the two category headers remain.
	assert.equal(tree.count('CategoryRow'), 2)
	assert.equal(tree.count('WorkspaceRow'), 0)
	assert.equal(tree.count('SessionRow'), 0)
	// The fold is view-only: the saved state and the user's expansion are untouched.
	assert.equal(JSON.stringify(tree.storage.entries()), before)
	assert.deepEqual(tree.model.getViewState().expanded, { ws1: true, ws2: true, ws3: true })

	categoryRow(tree, 'cat_a').props.onDragEnd()
	assert.equal(tree.count('WorkspaceRow'), 3)
	assert.equal(tree.count('SessionRow'), 4)
	assert.equal(JSON.stringify(tree.storage.entries()), before)
})

/* ------------------------------------------------------------------ *
 * Workspace drags fold sessions
 * ------------------------------------------------------------------ */

test('dragging a workspace folds every session away, and dragend restores them', () => {
	const tree = mountTree()
	assert.equal(tree.count('WorkspaceRow'), 3)
	assert.equal(tree.count('SessionRow'), 4)

	workspaceRow(tree, 'ws1').props.onWorkspaceDragStart(dragEvent())
	assert.equal(tree.count('CategoryRow'), 2)
	assert.equal(tree.count('WorkspaceRow'), 3)
	assert.equal(tree.count('SessionRow'), 0)
	assert.deepEqual(tree.model.getViewState().expanded, { ws1: true, ws2: true, ws3: true })

	workspaceRow(tree, 'ws1').props.onWorkspaceDragEnd()
	assert.equal(tree.count('SessionRow'), 4)
})

/* ------------------------------------------------------------------ *
 * Session drags fold nothing
 * ------------------------------------------------------------------ */

test('dragging a session leaves the tree as it is', () => {
	const tree = mountTree()
	assert.equal(tree.count('SessionRow'), 4)
	const session = tree.rows('SessionRow').find((node) => node.props.summary.id === 's1')
	assert.ok(session !== undefined)

	session.props.onDragStart(dragEvent())
	assert.equal(tree.count('CategoryRow'), 2)
	assert.equal(tree.count('WorkspaceRow'), 3)
	assert.equal(tree.count('SessionRow'), 4)

	session.props.onDragEnd()
	assert.equal(tree.count('SessionRow'), 4)
})

/* ------------------------------------------------------------------ *
 * Top drop bar: cancel and delete
 * ------------------------------------------------------------------ */

test('the drag bar appears only while dragging, and its cancel zone keeps the order', () => {
	const inserted = []
	const deleted = []
	const tree = mountTree({
		insertWorkspaceBefore: (id, anchor) => {
			inserted.push([id, anchor])
			return Promise.resolve()
		},
		deleteWorkspace: (id) => {
			deleted.push(id)
			return Promise.resolve()
		}
	})
	assert.equal(dragBar(tree), undefined, 'no bar at rest')

	workspaceRow(tree, 'ws1').props.onWorkspaceDragStart(dragEvent())
	assert.ok(dragBar(tree) !== undefined, 'missing the drag bar')
	const zones = dropZones(tree)
	assert.equal(zones.length, 2)
	assert.equal(zones[0].props.children, '取消')
	assert.equal(zones[1].props.children, '删除')

	// Hovering a zone marks it hot, and dropping there cancels without changes.
	zones[0].props.onDragOver(dragEvent())
	assert.ok(dropZones(tree)[0].props.className.split(' ').includes('twt-drop-zone-hot'))
	zones[0].props.onDrop(dragEvent())

	assert.equal(dragBar(tree), undefined, 'the bar leaves with the drag')
	assert.deepEqual(inserted, [])
	assert.deepEqual(deleted, [])
	assert.deepEqual(plain(tree.model.getSharedState().categories.map((category) => category.id)), ['cat_a', 'cat_b'])
	assert.deepEqual(plain(tree.model.getViewState().assign), { ws1: 'cat_a', ws2: 'cat_b' })
	assert.equal(tree.count('SessionRow'), 4)
})

test('dropping a workspace on the delete zone runs the existing workspace delete', async () => {
	const deleted = []
	const tree = mountTree({
		deleteWorkspace: (id) => {
			deleted.push(id)
			return Promise.resolve()
		}
	})
	workspaceRow(tree, 'ws1').props.onWorkspaceDragStart(dragEvent())
	const remove = dropZones(tree)[1]
	remove.props.onDragOver(dragEvent())
	remove.props.onDrop(dragEvent())
	// The delete runs through the row action's own promise chain.
	await tick()
	assert.deepEqual(deleted, ['ws1'])
	// The row action also drops this device's assignment and expansion state.
	assert.equal(tree.model.getViewState().assign.ws1, undefined)
	assert.equal(tree.model.getViewState().expanded.ws1, undefined)
})

test('dropping a category on the delete zone deletes it', () => {
	const tree = mountTree()
	categoryRow(tree, 'cat_a').props.onDragStart(dragEvent())
	const remove = dropZones(tree)[1]
	remove.props.onDrop(dragEvent())
	assert.deepEqual(plain(tree.model.getSharedState().categories.map((category) => category.id)), ['cat_b'])
	assert.equal(tree.model.getViewState().assign.ws1, undefined)
})

test('dropping a session on the delete zone archives it (the existing removal)', () => {
	const archived = []
	const tree = mountTree({
		archiveSession: (id) => {
			archived.push(id)
			return Promise.resolve()
		}
	})
	const session = tree.rows('SessionRow').find((node) => node.props.summary.id === 's1')
	assert.ok(session !== undefined)
	session.props.onDragStart(dragEvent())
	const remove = dropZones(tree)[1]
	remove.props.onDrop(dragEvent())
	assert.deepEqual(archived, ['s1'])
})

/* ------------------------------------------------------------------ *
 * Edge autoscroll while dragging
 * ------------------------------------------------------------------ */

test('holding a dragged row in the bottom band scrolls the list, dragend stops it', () => {
	const tree = mountTree()
	const list = fakeList()
	listElement(tree).props.ref.current = list

	workspaceRow(tree, 'ws1').props.onWorkspaceDragStart(dragEvent())
	assert.equal(tree.drag.frames.length, 0, 'no frames before the pointer reaches an edge')

	// The pointer arrives 4px above the list's bottom edge.
	const event = { clientX: 100, clientY: 296 }
	tree.drag.dispatch('dragover', event)
	const expected = tree.model.autoScrollStep({ x: event.clientX, y: event.clientY }, {
		top: 100,
		bottom: 300,
		left: 0,
		right: 240,
		scrollTop: 0,
		clientHeight: 200,
		scrollHeight: 900
	})
	assert.ok(expected > 0)
	tree.drag.runFrames(4)
	assert.equal(list.scrollTop, expected * 4)

	// Releasing the row cancels the frame loop; further frames change nothing.
	tree.drag.dispatch('dragend', {})
	assert.equal(tree.drag.frames.length, 0)
	tree.drag.runFrames(2)
	assert.equal(list.scrollTop, expected * 4)
})

test('holding a dragged row in the top band scrolls back up', () => {
	const tree = mountTree()
	const list = fakeList({ scrollTop: 300 })
	listElement(tree).props.ref.current = list

	workspaceRow(tree, 'ws2').props.onWorkspaceDragStart(dragEvent())
	tree.drag.dispatch('dragover', { clientX: 100, clientY: 104 })
	tree.drag.runFrames(3)
	assert.ok(list.scrollTop < 300)

	tree.drag.dispatch('dragend', {})
})

test('leaving the window parks the loop, and the next dragover restarts it', () => {
	const tree = mountTree()
	const list = fakeList()
	listElement(tree).props.ref.current = list

	workspaceRow(tree, 'ws1').props.onWorkspaceDragStart(dragEvent())
	tree.drag.dispatch('dragover', { clientX: 100, clientY: 296 })
	tree.drag.runFrames(2)
	assert.ok(list.scrollTop > 0)

	// The pointer leaves the window: no more frames, the list stops moving.
	tree.drag.dispatch('dragleave', { relatedTarget: null })
	assert.equal(tree.drag.frames.length, 0)
	const parked = list.scrollTop
	tree.drag.runFrames(2)
	assert.equal(list.scrollTop, parked)

	// A dragover on a still-running drag restarts the loop.
	tree.drag.dispatch('dragover', { clientX: 100, clientY: 296 })
	tree.drag.runFrames(2)
	assert.ok(list.scrollTop > parked)

	tree.drag.dispatch('dragend', {})
})

test('a pointer away from the list does not scroll it', () => {
	const tree = mountTree()
	const list = fakeList()
	listElement(tree).props.ref.current = list

	workspaceRow(tree, 'ws1').props.onWorkspaceDragStart(dragEvent())
	// Horizontally outside the sidebar: the drag is over the main view.
	tree.drag.dispatch('dragover', { clientX: 900, clientY: 200 })
	tree.drag.runFrames(2)
	assert.equal(list.scrollTop, 0)
	assert.equal(tree.drag.frames.length, 0, 'the loop parks itself when there is nowhere to scroll')

	tree.drag.dispatch('dragend', {})
})
