/**
 * Shared category state for `dsh-mahiros-workspace-categories`.
 *
 * Categories and workspace assignments are *account* data: they describe the
 * same workspace tree on every device that opens this Host (the desktop
 * browser, a phone through `dsh-pocket`, another browser). They cannot live in
 * `localStorage`, because that storage is scoped to one browser origin — the
 * phone reaches the same Host through a different origin (the pocket proxy's
 * LAN IP, or a tunnel hostname), so it starts empty and shows every workspace
 * as 未分类.
 *
 * This module is the Host-owned copy: one JSON document under the Harness home
 * (`$DSH_HOME/workspace-categories/state.json`) holding category rows
 * (`{ id, name }`, array order = display order), the workspace → category
 * assignment map, and per-workspace manual session orders
 * (`sessionOrder: { workspaceId: [sessionId…] }`), plus a monotonically
 * increasing `rev`.
 *
 * Writes arrive as an ordered `ops` batch, so two devices editing at the same
 * time converge on one Host state instead of overwriting each other with a
 * whole stale snapshot. Everything here is dependency-free Node code so the
 * unit tests can drive it without mounting a Cordis tree.
 *
 * The browser half carries the same `sanitizeShared` / `applyOps` pair (it
 * cannot import this file); `test/client-model.test.js` runs both copies
 * against the same table so the two cannot drift silently.
 *
 * @module dsh-mahiros-workspace-categories/state-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** On-disk schema version. Bumped only for an incompatible layout. */
export const STATE_VERSION = 1

/** Category id / name / workspace id length cap accepted from the wire. */
const MAX_ID = 200
const MAX_NAME = 200
/** Ops per request and workspaces tracked in one document. */
export const MAX_OPS = 200
const MAX_WORKSPACES = 20000
/** Manual session order length accepted for one workspace. */
export const MAX_ORDER = 2000
/** Operation families this document version understands; clients probe this over GET. */
export const STORE_FEATURES = Object.freeze(['category.move', 'session.order'])

/** `assign` keys are workspace ids; they never reach a filesystem path. */
function asText(value, max) {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

/**
 * Copy a candidate shared state into the canonical
 * `{ categories, assign, sessionOrder }` shape, dropping anything malformed.
 * Both halves of the plugin use this so a corrupt stored document and a hostile
 * request both land on the same value.
 *
 * @param {unknown} raw - candidate state (`categories`, `assign`, `sessionOrder`).
 * @returns {{ categories: Array<{ id: string, name: string }>, assign: Record<string, string>, sessionOrder: Record<string, string[]> }}
 */
export function sanitizeShared(raw) {
	const source = raw !== null && typeof raw === 'object' ? raw : {}
	const categories = []
	const ids = new Set()
	if (Array.isArray(source.categories)) {
		for (const entry of source.categories) {
			if (entry === null || typeof entry !== 'object') continue
			const id = asText(entry.id, MAX_ID)
			const name = asText(entry.name, MAX_NAME)
			if (id === null || name === null || ids.has(id)) continue
			ids.add(id)
			categories.push({ id, name })
		}
	}
	const assign = {}
	const rawAssign = source.assign
	if (rawAssign !== null && typeof rawAssign === 'object' && !Array.isArray(rawAssign)) {
		let count = 0
		for (const [key, value] of Object.entries(rawAssign)) {
			if (count >= MAX_WORKSPACES) break
			const workspaceId = asText(key, MAX_ID)
			const categoryId = asText(value, MAX_ID)
			// An assignment naming a missing category would render as unassigned
			// anyway; dropping it keeps the document honest.
			if (workspaceId === null || categoryId === null || !ids.has(categoryId)) continue
			assign[workspaceId] = categoryId
			count += 1
		}
	}
	const sessionOrder = {}
	const rawOrder = source.sessionOrder
	if (rawOrder !== null && typeof rawOrder === 'object' && !Array.isArray(rawOrder)) {
		let count = 0
		for (const [key, value] of Object.entries(rawOrder)) {
			if (count >= MAX_WORKSPACES) break
			const workspaceId = asText(key, MAX_ID)
			if (workspaceId === null || !Array.isArray(value)) continue
			const ids = []
			const seen = new Set()
			for (const entry of value) {
				if (ids.length >= MAX_ORDER) break
				const sessionId = asText(entry, MAX_ID)
				if (sessionId === null || seen.has(sessionId)) continue
				seen.add(sessionId)
				ids.push(sessionId)
			}
			// An empty list is not a manual order; drop it so the renderer falls
			// back to recency instead of an authoritative empty order.
			if (ids.length === 0) continue
			sessionOrder[workspaceId] = ids
			count += 1
		}
	}
	return { categories, assign, sessionOrder }
}

/** Deep-copy one session-order map (the document must never alias callers). */
function copySessionOrder(sessionOrder) {
	const copy = {}
	for (const [workspaceId, ids] of Object.entries(sessionOrder ?? {})) copy[workspaceId] = ids.slice()
	return copy
}

/** Normalize one incoming session id list, preserving first occurrences. */
function cleanOrder(ids) {
	const clean = []
	const seen = new Set()
	for (const entry of ids) {
		if (clean.length >= MAX_ORDER) break
		const sessionId = asText(entry, MAX_ID)
		if (sessionId === null || seen.has(sessionId)) continue
		seen.add(sessionId)
		clean.push(sessionId)
	}
	return clean
}

/**
 * Apply one ordered batch of operations to a shared state, returning a new
 * value. Unknown or malformed operations are ignored here; the request
 * validator rejects them before they reach a durable write.
 *
 * @param {{ categories: Array<{ id: string, name: string }>, assign: Record<string, string>, sessionOrder: Record<string, string[]> }} state
 * @param {ReadonlyArray<Record<string, unknown>>} ops
 * @returns {{ categories: Array<{ id: string, name: string }>, assign: Record<string, string>, sessionOrder: Record<string, string[]> }}
 */
export function applyOps(state, ops) {
	let categories = state.categories.slice()
	let assign = Object.assign({}, state.assign)
	let sessionOrder = copySessionOrder(state.sessionOrder)
	for (const op of Array.isArray(ops) ? ops : []) {
		if (op === null || typeof op !== 'object') continue
		if (op.type === 'category.add') {
			const category = op.category !== null && typeof op.category === 'object' ? op.category : {}
			const id = asText(category.id, MAX_ID)
			const name = asText(category.name, MAX_NAME)
			if (id === null || name === null) continue
			if (categories.some((entry) => entry.id === id)) continue
			categories = categories.concat([{ id, name }])
		} else if (op.type === 'category.rename') {
			const id = asText(op.id, MAX_ID)
			const name = asText(op.name, MAX_NAME)
			if (id === null || name === null) continue
			categories = categories.map((entry) => (entry.id === id ? { id: entry.id, name } : entry))
		} else if (op.type === 'category.delete') {
			const id = asText(op.id, MAX_ID)
			if (id === null || !categories.some((entry) => entry.id === id)) continue
			categories = categories.filter((entry) => entry.id !== id)
			for (const [workspaceId, target] of Object.entries(assign)) {
				if (target === id) delete assign[workspaceId]
			}
		} else if (op.type === 'assign') {
			const workspaceId = asText(op.workspaceId, MAX_ID)
			if (workspaceId === null) continue
			if (op.categoryId === null || op.categoryId === undefined) {
				delete assign[workspaceId]
				continue
			}
			const categoryId = asText(op.categoryId, MAX_ID)
			if (categoryId === null || !categories.some((entry) => entry.id === categoryId)) continue
			assign = Object.assign({}, assign, { [workspaceId]: categoryId })
		} else if (op.type === 'session.order') {
			const workspaceId = asText(op.workspaceId, MAX_ID)
			if (workspaceId === null || !Array.isArray(op.sessionIds)) continue
			const ids = cleanOrder(op.sessionIds)
			if (ids.length === 0) {
				delete sessionOrder[workspaceId]
				continue
			}
			sessionOrder = Object.assign({}, sessionOrder, { [workspaceId]: ids })
		} else if (op.type === 'category.move') {
			const id = asText(op.id, MAX_ID)
			if (id === null) continue
			const from = categories.findIndex((entry) => entry.id === id)
			if (from === -1) continue
			const beforeId =
				op.beforeId === null || op.beforeId === undefined ? undefined : asText(op.beforeId, MAX_ID)
			if (beforeId === id) continue
			const without = categories.filter((entry) => entry.id !== id)
			const at = beforeId === undefined ? without.length : without.findIndex((entry) => entry.id === beforeId)
			// A vanished anchor means "ignore this move", not "append": appending
			// would land the row somewhere the user never chose.
			if (at === -1) continue
			categories = without.slice(0, at).concat([categories[from]], without.slice(at))
		}
	}
	return { categories, assign, sessionOrder }
}

/**
 * Validate a wire batch. Returns a stable message for the 400 response, or
 * `null` when every operation is something `applyOps` can apply.
 *
 * @param {unknown} ops
 * @returns {string | null}
 */
export function validateOps(ops) {
	if (!Array.isArray(ops)) return 'ops must be an array'
	if (ops.length === 0) return 'ops must not be empty'
	if (ops.length > MAX_OPS) return `ops must hold at most ${MAX_OPS} entries`
	for (const op of ops) {
		if (op === null || typeof op !== 'object') return 'each op must be an object'
		if (op.type === 'category.add') {
			const category = op.category
			if (category === null || typeof category !== 'object') return 'category.add needs a category'
			if (asText(category.id, MAX_ID) === null) return 'category.add needs a valid id'
			if (asText(category.name, MAX_NAME) === null) return 'category.add needs a valid name'
		} else if (op.type === 'category.rename') {
			if (asText(op.id, MAX_ID) === null) return 'category.rename needs a valid id'
			if (asText(op.name, MAX_NAME) === null) return 'category.rename needs a valid name'
		} else if (op.type === 'category.delete') {
			if (asText(op.id, MAX_ID) === null) return 'category.delete needs a valid id'
		} else if (op.type === 'assign') {
			if (asText(op.workspaceId, MAX_ID) === null) return 'assign needs a valid workspaceId'
			if (op.categoryId !== null && op.categoryId !== undefined && asText(op.categoryId, MAX_ID) === null) {
				return 'assign needs a valid categoryId or null'
			}
		} else if (op.type === 'session.order') {
			if (asText(op.workspaceId, MAX_ID) === null) return 'session.order needs a valid workspaceId'
			if (!Array.isArray(op.sessionIds)) return 'session.order needs a sessionIds array'
			if (op.sessionIds.length > MAX_ORDER) return `session.order must hold at most ${MAX_ORDER} entries`
			for (const sessionId of op.sessionIds) {
				if (asText(sessionId, MAX_ID) === null) return 'session.order needs valid session ids'
			}
		} else if (op.type === 'category.move') {
			if (asText(op.id, MAX_ID) === null) return 'category.move needs a valid id'
			if (op.beforeId !== null && op.beforeId !== undefined && asText(op.beforeId, MAX_ID) === null) {
				return 'category.move needs a valid beforeId or null'
			}
		} else {
			return `unknown op type ${JSON.stringify(op.type)}`
		}
	}
	return null
}

/** Resolve the Harness home the same way the rest of the Host does. */
export function resolveDshHome() {
	const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
	return configured === '' ? join(homedir(), '.dsh') : configured
}

/** Where this plugin keeps its shared document. */
export function resolveStateFile() {
	return join(resolveDshHome(), 'workspace-categories', 'state.json')
}

function emptyDocument() {
	return { version: STATE_VERSION, rev: 0, categories: [], assign: {}, sessionOrder: {}, updatedAt: null }
}

function sameShared(left, right) {
	return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Create one lazily-loaded, durably-written shared-state document.
 *
 * @param {{ file?: string, logger?: { warn?: (...args: unknown[]) => void } }} [options]
 */
export function createStateStore(options = {}) {
	const file = typeof options.file === 'string' && options.file !== '' ? options.file : resolveStateFile()
	const logger = options.logger
	/** @type {{ version: number, rev: number, categories: Array<{ id: string, name: string }>, assign: Record<string, string>, sessionOrder: Record<string, string[]>, updatedAt: string | null }} */
	let document = emptyDocument()
	/** @type {Promise<unknown> | null} */
	let loading = null
	/** Set when the stored bytes were unreadable, so the first write preserves them. */
	let corruptBackup = false
	/** Serializes durable writes so `rev` and the file never disagree. */
	let writeQueue = Promise.resolve()

	function warn(message, error) {
		if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
			logger.warn(`workspace-categories: ${message}`, error)
		}
	}

	async function load() {
		if (loading === null) {
			loading = (async () => {
				let raw
				try {
					raw = await readFile(file, 'utf8')
				} catch (error) {
					if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return
					// A transient read failure (EACCES, EIO, …) must not poison the
					// document for the life of the process: retry on the next call.
					loading = null
					throw error
				}
				let parsed
				try {
					parsed = JSON.parse(raw)
				} catch (error) {
					corruptBackup = true
					warn(`could not parse ${file}; keeping it as a backup and starting empty`, error)
					return
				}
				const shared = sanitizeShared(parsed)
				const rev = parsed !== null && typeof parsed === 'object' && Number.isSafeInteger(parsed.rev) && parsed.rev >= 0 ? parsed.rev : 0
				document = {
					version: STATE_VERSION,
					rev,
					categories: shared.categories,
					assign: shared.assign,
					sessionOrder: shared.sessionOrder,
					updatedAt: parsed !== null && typeof parsed === 'object' && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
				}
			})()
		}
		await loading
	}

	function enqueue(task) {
		const run = writeQueue.then(task, task)
		// A failed write must not poison every later write.
		writeQueue = run.then(
			() => undefined,
			() => undefined
		)
		return run
	}

	/**
	 * Write one candidate document. Memory is only advanced after this resolves,
	 * so a failed write leaves reads consistent with the bytes on disk and the
	 * caller can retry the same operations.
	 */
	async function persist(candidate) {
		await mkdir(dirname(file), { recursive: true })
		if (corruptBackup && candidate.rev === 0) {
			// Preserve the unreadable file instead of overwriting the user's data.
			try {
				await rename(file, `${file}.bad-${Date.now()}`)
			} catch (error) {
				if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') throw error
			}
			corruptBackup = false
		}
		const body = JSON.stringify(candidate, null, 2) + '\n'
		const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
		await writeFile(temporary, body, { mode: 0o600 })
		await rename(temporary, file)
	}

	/** @returns {{ rev: number, categories: Array<{ id: string, name: string }>, assign: Record<string, string>, sessionOrder: Record<string, string[]>, features: string[] }} */
	function snapshot() {
		return {
			rev: document.rev,
			categories: document.categories.map((entry) => ({ id: entry.id, name: entry.name })),
			assign: Object.assign({}, document.assign),
			sessionOrder: copySessionOrder(document.sessionOrder),
			features: STORE_FEATURES.slice()
		}
	}

	return {
		file,
		/** Read the current shared state; `since` asks for a cheap "unchanged" answer. */
		async read(since) {
			await load()
			return Object.assign(snapshot(), { changed: since !== document.rev })
		},
		/** Apply one ordered batch durably, then return the new authoritative state. */
		async apply(ops) {
			await load()
			const verdict = validateOps(ops)
			if (verdict !== null) {
				const error = new Error(verdict)
				error.code = 'bad-ops'
				throw error
			}
			return enqueue(async () => {
				const next = applyOps(document, ops)
				if (!sameShared(next, {
					categories: document.categories,
					assign: document.assign,
					sessionOrder: document.sessionOrder
				})) {
					const candidate = {
						version: STATE_VERSION,
						rev: document.rev + 1,
						categories: next.categories,
						assign: next.assign,
						sessionOrder: next.sessionOrder,
						updatedAt: new Date().toISOString()
					}
					await persist(candidate)
					document = candidate
				}
				return Object.assign(snapshot(), { applied: ops.length })
			})
		},
		/**
		 * Adopt a whole snapshot, but only while the document is still empty.
		 * This is the one-way migration path for a device that already holds
		 * categories in `localStorage` when it first reaches a fresh Host.
		 */
		async replace(input) {
			await load()
			if (document.rev !== 0) {
				const error = new Error('shared state already holds categories')
				error.code = 'not-empty'
				throw error
			}
			const next = sanitizeShared(input)
			if (
				next.categories.length === 0 &&
				Object.keys(next.assign).length === 0 &&
				Object.keys(next.sessionOrder).length === 0
			) {
				return Object.assign(snapshot(), { changed: false })
			}
			return enqueue(async () => {
				const candidate = {
					version: STATE_VERSION,
					rev: document.rev + 1,
					categories: next.categories,
					assign: next.assign,
					sessionOrder: next.sessionOrder,
					updatedAt: new Date().toISOString()
				}
				await persist(candidate)
				document = candidate
				return Object.assign(snapshot(), { changed: true })
			})
		}
	}
}
