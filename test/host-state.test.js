/**
 * Host-half tests: shared category document + the `/api` Fetch route.
 *
 * Run with `node --test test/`.
 *
 * The route is exercised through the same `Request`/`Response` pair the
 * Connection bridge hands it, and the `apply()` wiring is driven with a small
 * fake Cordis context so the registration contract (path, methods, buffered
 * body, effect-owned disposer) is pinned without booting a Host.
 */

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { apply } from '../lib/index.js'
import { createStateRouteHandler, STATE_ROUTE_PATH } from '../lib/state-routes.js'
import {
	applyOps,
	createStateStore,
	MAX_OPS,
	resolveStateFile,
	sanitizeShared,
	STORE_FEATURES,
	validateOps
} from '../lib/state-store.js'

const roots = []

async function temporaryHome() {
	const root = await mkdtemp(join(tmpdir(), 'ws-categories-'))
	roots.push(root)
	return root
}

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop()
		await rm(root, { recursive: true, force: true })
	}
})

function request(path, init) {
	return new Request(`http://harness.invalid${path}`, init)
}

function postBody(body) {
	return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/* ------------------------------------------------------------------ *
 * Pure model
 * ------------------------------------------------------------------ */

test('sanitizeShared keeps well-formed categories and drops dangling assignments', () => {
	const shared = sanitizeShared({
		categories: [
			{ id: 'cat_a', name: '前端' },
			{ id: 'cat_a', name: '重复 id 丢弃' },
			{ id: '', name: '空 id 丢弃' },
			{ id: 'cat_b', name: 7 },
			null
		],
		assign: { ws1: 'cat_a', ws2: 'cat_missing', ws3: 3 }
	})
	assert.deepEqual(shared.categories, [{ id: 'cat_a', name: '前端' }])
	assert.deepEqual(shared.assign, { ws1: 'cat_a' })
	assert.deepEqual(shared.sessionOrder, {})
})

test('sanitizeShared keeps one well-formed manual session order per workspace', () => {
	const shared = sanitizeShared({
		sessionOrder: {
			ws1: ['s2', 's1', 's2', '', 7],
			ws2: [],
			ws3: 'nope',
			'': ['s1']
		}
	})
	assert.deepEqual(shared.sessionOrder, { ws1: ['s2', 's1'] })
})

test('applyOps applies adds, renames, deletes and assignments in order', () => {
	let state = { categories: [], assign: {} }
	state = applyOps(state, [
		{ type: 'category.add', category: { id: 'cat_a', name: '前端' } },
		{ type: 'category.add', category: { id: 'cat_b', name: '后端' } },
		{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_a' },
		{ type: 'category.rename', id: 'cat_b', name: '服务端' }
	])
	assert.deepEqual(state.categories, [
		{ id: 'cat_a', name: '前端' },
		{ id: 'cat_b', name: '服务端' }
	])
	assert.deepEqual(state.assign, { ws1: 'cat_a' })

	state = applyOps(state, [
		{ type: 'assign', workspaceId: 'ws1', categoryId: null },
		{ type: 'assign', workspaceId: 'ws2', categoryId: 'cat_a' },
		{ type: 'category.delete', id: 'cat_a' }
	])
	assert.deepEqual(state.categories, [{ id: 'cat_b', name: '服务端' }])
	// Deleting a category clears the assignments that pointed at it.
	assert.deepEqual(state.assign, {})
})

test('applyOps ignores malformed operations instead of throwing', () => {
	const state = applyOps({ categories: [], assign: {} }, [
		null,
		'category.add',
		{ type: 'category.add' },
		{ type: 'category.add', category: { id: 'cat_a', name: 'ok' } },
		{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_missing' },
		{ type: 'no-such-op' }
	])
	assert.deepEqual(state, { categories: [{ id: 'cat_a', name: 'ok' }], assign: {}, sessionOrder: {} })
})

test('applyOps moves categories before an anchor or to the end', () => {
	let state = applyOps({ categories: [], assign: {} }, [
		{ type: 'category.add', category: { id: 'cat_a', name: 'A' } },
		{ type: 'category.add', category: { id: 'cat_b', name: 'B' } },
		{ type: 'category.add', category: { id: 'cat_c', name: 'C' } }
	])
	const ids = () => state.categories.map((entry) => entry.id)
	assert.deepEqual(ids(), ['cat_a', 'cat_b', 'cat_c'])

	state = applyOps(state, [{ type: 'category.move', id: 'cat_c', beforeId: 'cat_a' }])
	assert.deepEqual(ids(), ['cat_c', 'cat_a', 'cat_b'])

	// An omitted anchor appends, and moving a category before itself is a no-op.
	state = applyOps(state, [
		{ type: 'category.move', id: 'cat_c', beforeId: null },
		{ type: 'category.move', id: 'cat_b', beforeId: 'cat_b' },
		{ type: 'category.move', id: 'cat_missing', beforeId: 'cat_a' },
		{ type: 'category.move', id: 'cat_b', beforeId: 'cat_missing' }
	])
	assert.deepEqual(ids(), ['cat_a', 'cat_b', 'cat_c'])
})

test('applyOps writes and clears manual session order', () => {
	let state = applyOps({ categories: [], assign: {} }, [
		{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s3', 's1', 's3', 's2'] },
		{ type: 'session.order', workspaceId: 'ws2', sessionIds: ['s1'] }
	])
	assert.deepEqual(state.sessionOrder, { ws1: ['s3', 's1', 's2'], ws2: ['s1'] })

	state = applyOps(state, [{ type: 'session.order', workspaceId: 'ws1', sessionIds: [] }])
	assert.deepEqual(state.sessionOrder, { ws2: ['s1'] })
})

test('validateOps names a stable failure for every bad batch', () => {
	assert.equal(validateOps([]), 'ops must not be empty')
	assert.equal(validateOps('nope'), 'ops must be an array')
	assert.match(validateOps(new Array(MAX_OPS + 1).fill({ type: 'category.delete', id: 'x' })), /at most 200/)
	assert.equal(validateOps([{ type: 'category.add', category: { id: 'cat_a' } }]), 'category.add needs a valid name')
	assert.equal(validateOps([{ type: 'category.rename', id: 'cat_a' }]), 'category.rename needs a valid name')
	assert.equal(validateOps([{ type: 'assign', workspaceId: '' }]), 'assign needs a valid workspaceId')
	assert.equal(validateOps([{ type: 'session.order', workspaceId: 'ws1' }]), 'session.order needs a sessionIds array')
	assert.equal(validateOps([{ type: 'session.order', workspaceId: '', sessionIds: [] }]), 'session.order needs a valid workspaceId')
	assert.equal(validateOps([{ type: 'session.order', workspaceId: 'ws1', sessionIds: [''] }]), 'session.order needs valid session ids')
	assert.equal(validateOps([{ type: 'category.move', id: '' }]), 'category.move needs a valid id')
	assert.equal(validateOps([{ type: 'category.move', id: 'cat_a', beforeId: 7 }]), 'category.move needs a valid beforeId or null')
	assert.match(validateOps([{ type: 'bogus' }]), /unknown op type/)
	assert.equal(validateOps([{ type: 'category.delete', id: 'cat_a' }]), null)
	assert.equal(validateOps([{ type: 'session.order', workspaceId: 'ws1', sessionIds: ['s1'] }]), null)
	assert.equal(validateOps([{ type: 'category.move', id: 'cat_a', beforeId: 'cat_b' }]), null)
	assert.equal(validateOps([{ type: 'category.move', id: 'cat_a', beforeId: null }]), null)
})

/* ------------------------------------------------------------------ *
 * Durable store
 * ------------------------------------------------------------------ */

test('store persists ops and reloads them from disk', async () => {
	const home = await temporaryHome()
	const file = join(home, 'workspace-categories', 'state.json')

	const store = createStateStore({ file })
	assert.deepEqual(await store.read(null), {
		rev: 0,
		categories: [],
		assign: {},
		sessionOrder: {},
		features: [...STORE_FEATURES],
		changed: true
	})

	const first = await store.apply([
		{ type: 'category.add', category: { id: 'cat_a', name: '前端' } },
		{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_a' }
	])
	assert.equal(first.rev, 1)
	assert.deepEqual(first.categories, [{ id: 'cat_a', name: '前端' }])
	assert.deepEqual(first.assign, { ws1: 'cat_a' })

	const reloaded = createStateStore({ file })
	assert.deepEqual(await reloaded.read(1), {
		rev: 1,
		categories: [{ id: 'cat_a', name: '前端' }],
		assign: { ws1: 'cat_a' },
		sessionOrder: {},
		features: [...STORE_FEATURES],
		changed: false
	})
	assert.deepEqual(await reloaded.read(0), {
		rev: 1,
		categories: [{ id: 'cat_a', name: '前端' }],
		assign: { ws1: 'cat_a' },
		sessionOrder: {},
		features: [...STORE_FEATURES],
		changed: true
	})

	const document = JSON.parse(await readFile(file, 'utf8'))
	assert.equal(document.rev, 1)
	assert.equal(document.version, 1)
	assert.deepEqual(document.categories, [{ id: 'cat_a', name: '前端' }])
})

test('a failed durable write leaves memory on the old revision and retries cleanly', async (t) => {
	if (process.platform === 'win32') return t.skip('POSIX permissions needed to force a write failure')
	const home = await temporaryHome()
	const directory = join(home, 'workspace-categories')
	const file = join(directory, 'state.json')
	await mkdir(directory, { recursive: true })
	const store = createStateStore({ file })
	// Load first (the document does not exist yet), then make the directory
	// read-only so only the write fails.
	assert.equal((await store.read(null)).rev, 0)
	await chmod(directory, 0o555)
	try {
		await assert.rejects(() => store.apply([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }]))
		const unchanged = await store.read(null)
		assert.equal(unchanged.rev, 0)
		assert.deepEqual(unchanged.categories, [])
	} finally {
		await chmod(directory, 0o755)
	}

	const retried = await store.apply([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	assert.equal(retried.rev, 1)
	assert.deepEqual((await createStateStore({ file }).read(null)).categories, [{ id: 'cat_a', name: '前端' }])
})

test('a no-op batch does not bump rev', async () => {
	const home = await temporaryHome()
	const store = createStateStore({ file: join(home, 'state.json') })
	await store.apply([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	const again = await store.apply([
		{ type: 'category.add', category: { id: 'cat_a', name: '前端' } },
		{ type: 'assign', workspaceId: 'ws1', categoryId: 'cat_missing' }
	])
	assert.equal(again.rev, 1)
	assert.equal(again.applied, 2)
})

test('replace migrates a first snapshot once and refuses afterwards', async () => {
	const home = await temporaryHome()
	const store = createStateStore({ file: join(home, 'state.json') })
	const seeded = await store.replace({ categories: [{ id: 'cat_a', name: '前端' }], assign: { ws1: 'cat_a' } })
	assert.equal(seeded.rev, 1)
	await assert.rejects(
		() => store.replace({ categories: [{ id: 'cat_b', name: '后端' }], assign: {} }),
		(error) => error.code === 'not-empty'
	)
	assert.equal((await store.read(null)).rev, 1)
})

test('an unreadable document is backed up instead of overwritten', async () => {
	const home = await temporaryHome()
	const file = join(home, 'state.json')
	await writeFile(file, '{not json')
	const warnings = []
	const store = createStateStore({ file, logger: { warn: (...args) => warnings.push(args) } })
	assert.deepEqual(await store.read(null), {
		rev: 0,
		categories: [],
		assign: {},
		sessionOrder: {},
		features: [...STORE_FEATURES],
		changed: true
	})
	assert.equal(warnings.length, 1)

	await store.apply([{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }])
	const restored = createStateStore({ file })
	assert.deepEqual((await restored.read(null)).categories, [{ id: 'cat_a', name: '前端' }])
})

test('concurrent batches serialize and every write survives', async () => {
	const home = await temporaryHome()
	const store = createStateStore({ file: join(home, 'state.json') })
	const names = Array.from({ length: 12 }, (_, index) => ({ type: 'category.add', category: { id: `cat_${index}`, name: `分类 ${index}` } }))
	await Promise.all(names.map((op) => store.apply([op])))
	const snapshot = await store.read(null)
	assert.equal(snapshot.rev, 12)
	assert.equal(snapshot.categories.length, 12)
})

test('writes reject the Harness home when DSH_HOME is blank', () => {
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = '   '
	try {
		assert.match(resolveStateFile(), /[/\\]\.dsh[/\\]workspace-categories[/\\]state\.json$/)
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
	}
})

/* ------------------------------------------------------------------ *
 * Fetch route
 * ------------------------------------------------------------------ */

test('the route path is a legal Connection endpoint below /api', () => {
	assert.equal(STATE_ROUTE_PATH, '/api/workspace-categories.state')
	assert.match(STATE_ROUTE_PATH, /^\/api\/[A-Za-z0-9_$.-]+$/)
})

test('GET returns an empty document, POST applies ops, GET?since answers unchanged', async () => {
	const home = await temporaryHome()
	const handle = createStateRouteHandler(createStateStore({ file: join(home, 'state.json') }))

	const empty = await handle(request(STATE_ROUTE_PATH, { method: 'GET' }))
	assert.equal(empty.status, 200)
	assert.equal(empty.headers.get('cache-control'), 'no-store')
	assert.deepEqual(await empty.json(), {
		rev: 0,
		categories: [],
		assign: {},
		sessionOrder: {},
		features: [...STORE_FEATURES],
		changed: true
	})

	const written = await handle(
		request(STATE_ROUTE_PATH, postBody({ ops: [{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }] }))
	)
	assert.equal(written.status, 200)
	assert.deepEqual(await written.json(), {
		rev: 1,
		categories: [{ id: 'cat_a', name: '前端' }],
		assign: {},
		sessionOrder: {},
		features: [...STORE_FEATURES],
		applied: 1
	})

	const unchanged = await handle(request(`${STATE_ROUTE_PATH}?since=1`, { method: 'GET' }))
	assert.deepEqual(await unchanged.json(), {
		rev: 1,
		categories: [{ id: 'cat_a', name: '前端' }],
		assign: {},
		sessionOrder: {},
		features: [...STORE_FEATURES],
		changed: false
	})
})

test('POST replace seeds a fresh document and conflicts once initialized', async () => {
	const home = await temporaryHome()
	const handle = createStateRouteHandler(createStateStore({ file: join(home, 'state.json') }))

	const seeded = await handle(
		request(STATE_ROUTE_PATH, postBody({ replace: { categories: [{ id: 'cat_a', name: '前端' }], assign: {} } }))
	)
	assert.equal(seeded.status, 200)
	assert.equal((await seeded.json()).rev, 1)

	const conflict = await handle(
		request(STATE_ROUTE_PATH, postBody({ replace: { categories: [{ id: 'cat_b', name: '后端' }], assign: {} } }))
	)
	assert.equal(conflict.status, 409)
})

test('the route rejects malformed requests with stable statuses', async () => {
	const home = await temporaryHome()
	const handle = createStateRouteHandler(createStateStore({ file: join(home, 'state.json') }))

	const wrongType = await handle(request(STATE_ROUTE_PATH, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }))
	assert.equal(wrongType.status, 415)

	const brokenJson = await handle(request(STATE_ROUTE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))
	assert.equal(brokenJson.status, 400)

	const missingOps = await handle(request(STATE_ROUTE_PATH, postBody({})))
	assert.equal(missingOps.status, 400)

	const unknownOp = await handle(request(STATE_ROUTE_PATH, postBody({ ops: [{ type: 'explode' }] })))
	assert.equal(unknownOp.status, 400)

	const tooMany = await handle(request(STATE_ROUTE_PATH, postBody({ ops: new Array(MAX_OPS + 1).fill({ type: 'category.delete', id: 'x' }) })))
	assert.equal(tooMany.status, 400)
})

/* ------------------------------------------------------------------ *
 * apply() wiring
 * ------------------------------------------------------------------ */

test('apply registers one authenticated exact route inside the connection service', async () => {
	const home = await temporaryHome()
	const previousHome = process.env.DSH_HOME
	process.env.DSH_HOME = home
	try {
		const registered = []
		const disposers = []
		const injected = []
		const hostCtx = {
			logger: { warn() {} },
			inject(deps, callback) {
				injected.push(deps)
				callback(hostCtx)
			},
			effect(factory, label) {
				disposers.push({ label, dispose: factory() })
			},
			connection: {
				fetch: {
					register(route) {
						registered.push(route)
						return async () => {}
					}
				}
			}
		}

		apply(hostCtx)
		assert.deepEqual(injected, [['connection']])
		assert.equal(registered.length, 1)
		const [route] = registered
		assert.equal(route.path, STATE_ROUTE_PATH)
		assert.deepEqual([...route.methods], ['GET', 'POST'])
		assert.equal(route.requestBody, 'buffered')
		assert.equal(typeof route.fetch, 'function')
		assert.match(disposers[0].label, /shared state route/)

		const response = await route.fetch(
			request(STATE_ROUTE_PATH, postBody({ ops: [{ type: 'category.add', category: { id: 'cat_a', name: '前端' } }] }))
		)
		assert.equal(response.status, 200)
		assert.deepEqual((await response.json()).categories, [{ id: 'cat_a', name: '前端' }])

		// The route reads the Host home at request time, so the file lives there.
		const document = JSON.parse(await readFile(join(home, 'workspace-categories', 'state.json'), 'utf8'))
		assert.deepEqual(document.categories, [{ id: 'cat_a', name: '前端' }])
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previousHome
	}
})

test('apply is inert when the Host has no browser transport', () => {
	let called = false
	apply({
		inject() {
			called = true
		}
	})
	// `inject` runs and only waits; nothing throws without `connection`.
	assert.equal(called, true)
})
