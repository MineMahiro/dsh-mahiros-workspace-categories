/**
 * dsh-mahiros-workspace-categories — client half.
 *
 * Renders a VS Code style category tree (分类 > 工作区 > 会话) into the
 * sidebar's `sidebar.workspaces` slot. That slot is `kind: "single"`, and a
 * single slot renders its lowest-priority entry, so registering at
 * `priority: -100` shadows ui-workspace's default browser (`priority: 0`)
 * without disabling it — disposing our entry brings the native browser back.
 * This plugin no longer offers a switch back to that browser: the tree is the
 * only view, and no footer/toolbar toggle is registered.
 *
 * Tree data comes from the client Cordis services (this plugin adds no Cordis
 * RPC of its own; the one extra Fetch route it uses is described below):
 *   ctx.get("workspaces").list  -> { items, archivedSessionIds, pinnedSessionIds, phase }
 *   ctx.get("sessions").list    -> { ids, byId, phase }   (byId rows carry displayTitle/running/retainedBy)
 * Opening a session is delegated to ctx.get("uiWorkspace") (retain mainView +
 * reveal the main panel), with a hand-rolled fallback.
 *
 * Session archiving reuses the workspaces controller
 * (`archiveSession` / `unarchiveSession`), because that is what installs the
 * returned archive set into the snapshot store; a `workspace/session-active`
 * refusal is answered with the same "stop and archive?" second step the
 * built-in browser takes. A tri-state filter (隐藏归档 / 含归档 / 仅归档) decides
 * whether archived rows show up in the tree at all.
 *
 * Empty Sessions are cleaned up in the view, not on disk: the Host creates a
 * blank Session whenever a page loads without a restorable selection (each
 * phone visit, a fresh browser profile), and listing every one of them left a
 * pile behind. Blank rows are therefore hidden unless they are the Session the
 * main view holds, carry a composer draft, are still inside a short
 * just-created grace window, or are running/titled.
 *
 * Categories and workspace assignments are *account* state, not page state:
 * the desktop browser, a phone through `dsh-pocket`, and any other browser
 * reaching this Host must see the same tree. They are owned by the Host half
 * (`lib/index.js` + `$DSH_HOME/workspace-categories/state.json`) and reached
 * over Connection's authenticated `/api` channel. This half keeps a
 * localStorage mirror plus an operation outbox, falls back to local-only when
 * the route is absent, and notices other devices through a 4 s revision poll.
 * Device preferences (folded categories, expanded workspaces, visible row
 * count, archived filter) stay local on purpose.
 *
 * Creating a workspace calls the `workspaceDefaultDirectory` client service
 * exposed by `@local/dsh-workspace-default-directory`. That service owns the
 * composed official in-app "Select Workspace Directory" dialog, seeded with
 * the directory configured by that bundle, and resolves one picked absolute
 * path (or `null` on cancel). This plugin only triggers the pick and adopts
 * the path with `workspaces.create`; it never renders the flow hole and never
 * opens the OS folder chooser.
 */

window.__ModuleLoader__.load({
	id: 'dsh-mahiros-workspace-categories',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement

		/**
		 * The shell seeds a fixed set of UI packages into every client bundle, and
		 * `@deepseek-ai/dsh-client-ui-primitives` is the one the built-in browser
		 * uses for its own hover tooltips (`ArchiveSessionRowButton` wraps its
		 * button in `Tooltip` with `side: "bottom"`, `align: "end"`,
		 * `delayMs: 500`) and for its session status marker (`SessionStatusDots`
		 * renders the primitive's `StateDot` with the `ongoing` / `warning` /
		 * `done` states). Reusing both keeps our hints and status colours
		 * identical to the rest of the app. The seed list is not part of this
		 * plugin's contract though, so a missing package must not break the tree:
		 * we degrade to the native `title` tooltip and to our own CSS dot.
		 */
		let Tooltip = null
		let StateDot = null
		try {
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
			if (primitives !== null && primitives !== undefined) {
				if (typeof primitives.Tooltip === 'function') Tooltip = primitives.Tooltip
				if (typeof primitives.StateDot === 'function') StateDot = primitives.StateDot
			}
		} catch (reason) {
			Tooltip = null
			StateDot = null
		}

		/* ------------------------------------------------------------------ *
		 * Persisted state: shared categories + per-device view preferences
		 * ------------------------------------------------------------------ */

		/**
		 * Categories and workspace assignments are account state: the desktop
		 * browser, a phone through `dsh-pocket`, and any other device that opens
		 * this Host must see the same tree. They therefore live on the Host
		 * (`$DSH_HOME/workspace-categories/state.json`, owned by `lib/index.js`)
		 * and are read/written over Connection's authenticated `/api` channel —
		 * `localStorage` is scoped to one browser origin, which is exactly why
		 * the phone used to show every workspace as 未分类.
		 *
		 * This is that Host document mirrored in the page: the last known
		 * `{ rev, categories, assign, sessionOrder }` plus `pendingOps`, an
		 * outbox of operations the Host has not acknowledged yet (so edits made
		 * while the Host half is missing or the connection blips are not lost).
		 *
		 * Presentation state the user only expects on the device in hand —
		 * folded category, expanded workspace, visible session count, archived
		 * filter — deliberately stays in `localStorage`. A phone should not
		 * uncollapse the desktop tree just because it loaded once.
		 */
		const STORAGE_KEY = 'dsh.workspace-tree.state.v2'
		const LEGACY_STORAGE_KEY = 'dsh.workspace-tree.state.v1'
		const STYLE_ID = 'dsh-mahiros-workspace-categories/styles'
		/** Must match `STATE_ROUTE_PATH` in `lib/state-routes.js`. */
		const SYNC_PATH = '/api/workspace-categories.state'
		const SYNC_POLL_MS = 4000
		const SYNC_RETRY_MS = 15000
		/** Oldest pending operations are dropped past this, so the outbox stays bounded. */
		const MAX_PENDING_OPS = 500

		const SESSION_STEP = 10
		const SESSION_DEFAULT = 5
		/** Mirrors the built-in browser's tri-state archived-row filter. */
		const ARCHIVED_FILTERS = ['default', 'show', 'only']
		/** Private drag payloads, so a workspace drop never reads a session id. */
		const DRAG_WORKSPACE_MIME = 'application/x-dsh-workspace'
		const DRAG_SESSION_MIME = 'application/x-dsh-session'
		const DRAG_CATEGORY_MIME = 'application/x-dsh-category'

		/**
		 * Empty-Session cleanup.
		 *
		 * The Host creates a blank Session whenever a page loads without a
		 * restorable selection — a phone that opens the pocket URL, a browser
		 * with a fresh profile, a reconnecting client. Nothing ever writes to
		 * those logs, but they stay in the workspace catalogue, and the tree used
		 * to list every one of them, so repeated phone visits left a pile of
		 * muted "empty" rows behind.
		 *
		 * Keeping them out of the list is the removal we can do safely: DSH has
		 * no delete-Session API, and archiving would only move the pile into the
		 * archived set. A blank row therefore stays hidden unless it is still in
		 * use:
		 *
		 *   - the Session the main view currently holds (the just-created row),
		 *   - a Session whose composer draft has content (typed, not sent),
		 *   - a Session created moments ago, so a fresh one is never swept away
		 *     before its first message lands,
		 *   - a Session that is running or carries a title.
		 *
		 * Nothing is archived or deleted. Type a draft into a hidden blank and it
		 * reappears; clear the draft and the next render hides it again.
		 */
		/** Per-Session composer draft key owned by `@deepseek-ai/dsh-client-ui-conversation`. */
		const CONVERSATION_STORE_KEY = 'dsh.conversation'
		/** A blank Session younger than this is "just created" and stays visible. */
		const EMPTY_SESSION_GRACE_MS = 2 * 60 * 1000
		/** Re-render cadence so a grace-window blank disappears on time. */
		const EMPTY_SESSION_RESCAN_MS = 20 * 1000

		function emptyLocal() {
			return { collapsed: {}, expanded: {}, visible: {}, archivedFilter: 'default' }
		}

		function emptyShared() {
			return { rev: 0, categories: [], assign: {}, sessionOrder: {} }
		}

		function textOf(value, max) {
			return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
		}

		/**
		 * Copy a Host or wire snapshot into the canonical
		 * `{ categories, assign, sessionOrder }` triple. Identical to the Host
		 * half's sanitizer (the browser bundle cannot import it);
		 * `test/client-model.test.js` compares both implementations.
		 */
		function sanitizeShared(raw) {
			const source = raw !== null && typeof raw === 'object' ? raw : {}
			const categories = []
			const ids = new Set()
			if (Array.isArray(source.categories)) {
				for (const entry of source.categories) {
					if (entry === null || typeof entry !== 'object') continue
					const id = textOf(entry.id, 200)
					const name = textOf(entry.name, 200)
					if (id === null || name === null || ids.has(id)) continue
					ids.add(id)
					categories.push({ id, name })
				}
			}
			const assign = {}
			const rawAssign = source.assign
			if (rawAssign !== null && typeof rawAssign === 'object' && !Array.isArray(rawAssign)) {
				for (const [key, value] of Object.entries(rawAssign)) {
					const workspaceId = textOf(key, 200)
					const categoryId = textOf(value, 200)
					if (workspaceId === null || categoryId === null || !ids.has(categoryId)) continue
					assign[workspaceId] = categoryId
				}
			}
			const sessionOrder = {}
			const rawOrder = source.sessionOrder
			if (rawOrder !== null && typeof rawOrder === 'object' && !Array.isArray(rawOrder)) {
				for (const [key, value] of Object.entries(rawOrder)) {
					const workspaceId = textOf(key, 200)
					if (workspaceId === null || !Array.isArray(value)) continue
					const ids = []
					const seen = new Set()
					for (const entry of value) {
						if (ids.length >= 2000) break
						const sessionId = textOf(entry, 200)
						if (sessionId === null || seen.has(sessionId)) continue
						seen.add(sessionId)
						ids.push(sessionId)
					}
					if (ids.length === 0) continue
					sessionOrder[workspaceId] = ids
				}
			}
			return { categories, assign, sessionOrder }
		}

		/** Device-local presentation state, defensively copied. */
		function sanitizeLocal(raw) {
			const source = raw !== null && typeof raw === 'object' ? raw : {}
			const collapsed = {}
			const rawCollapsed = source.collapsed !== null && typeof source.collapsed === 'object' && !Array.isArray(source.collapsed) ? source.collapsed : {}
			for (const [key, value] of Object.entries(rawCollapsed)) {
				if (textOf(key, 200) !== null && value === true) collapsed[key] = true
			}
			const expanded = {}
			const rawExpanded = source.expanded !== null && typeof source.expanded === 'object' && !Array.isArray(source.expanded) ? source.expanded : {}
			for (const [key, value] of Object.entries(rawExpanded)) {
				if (textOf(key, 200) !== null && value === true) expanded[key] = true
			}
			const visible = {}
			const rawVisible = source.visible !== null && typeof source.visible === 'object' && !Array.isArray(source.visible) ? source.visible : {}
			for (const [key, value] of Object.entries(rawVisible)) {
				if (textOf(key, 200) !== null && typeof value === 'number' && Number.isFinite(value) && value > 0) {
					visible[key] = Math.floor(value)
				}
			}
			return {
				collapsed,
				expanded,
				visible,
				archivedFilter: ARCHIVED_FILTERS.indexOf(source.archivedFilter) === -1 ? 'default' : source.archivedFilter
			}
		}

		/**
		 * Apply one batch of operations optimistically. Mirrors the Host half's
		 * `applyOps`; the Host stays authoritative, so a disagreement is repaired
		 * by adopting the next Host snapshot.
		 */
		function applySharedOps(state, ops) {
			let categories = state.categories.slice()
			let assign = Object.assign({}, state.assign)
			let sessionOrder = {}
			for (const [workspaceId, ids] of Object.entries(state.sessionOrder ?? {})) sessionOrder[workspaceId] = ids.slice()
			for (const op of Array.isArray(ops) ? ops : []) {
				if (op === null || typeof op !== 'object') continue
				if (op.type === 'category.add') {
					const category = op.category !== null && typeof op.category === 'object' ? op.category : {}
					const id = textOf(category.id, 200)
					const name = textOf(category.name, 200)
					if (id === null || name === null) continue
					if (categories.some((entry) => entry.id === id)) continue
					categories = categories.concat([{ id, name }])
				} else if (op.type === 'category.rename') {
					const id = textOf(op.id, 200)
					const name = textOf(op.name, 200)
					if (id === null || name === null) continue
					categories = categories.map((entry) => (entry.id === id ? { id: entry.id, name } : entry))
				} else if (op.type === 'category.delete') {
					const id = textOf(op.id, 200)
					if (id === null || !categories.some((entry) => entry.id === id)) continue
					categories = categories.filter((entry) => entry.id !== id)
					for (const [workspaceId, target] of Object.entries(assign)) {
						if (target === id) delete assign[workspaceId]
					}
				} else if (op.type === 'assign') {
					const workspaceId = textOf(op.workspaceId, 200)
					if (workspaceId === null) continue
					if (op.categoryId === null || op.categoryId === undefined) {
						delete assign[workspaceId]
						continue
					}
					const categoryId = textOf(op.categoryId, 200)
					if (categoryId === null || !categories.some((entry) => entry.id === categoryId)) continue
					assign = Object.assign({}, assign, { [workspaceId]: categoryId })
				} else if (op.type === 'session.order') {
					const workspaceId = textOf(op.workspaceId, 200)
					if (workspaceId === null || !Array.isArray(op.sessionIds)) continue
					const ids = []
					const seen = new Set()
					for (const entry of op.sessionIds) {
						if (ids.length >= 2000) break
						const sessionId = textOf(entry, 200)
						if (sessionId === null || seen.has(sessionId)) continue
						seen.add(sessionId)
						ids.push(sessionId)
					}
					if (ids.length === 0) {
						delete sessionOrder[workspaceId]
						continue
					}
					sessionOrder = Object.assign({}, sessionOrder, { [workspaceId]: ids })
				} else if (op.type === 'category.move') {
					const id = textOf(op.id, 200)
					if (id === null) continue
					const from = categories.findIndex((entry) => entry.id === id)
					if (from === -1) continue
					const beforeId = op.beforeId === null || op.beforeId === undefined ? undefined : textOf(op.beforeId, 200)
					if (beforeId === id) continue
					const without = categories.filter((entry) => entry.id !== id)
					const at = beforeId === undefined ? without.length : without.findIndex((entry) => entry.id === beforeId)
					if (at === -1) continue
					categories = without.slice(0, at).concat([categories[from]], without.slice(at))
				}
			}
			return { categories, assign, sessionOrder }
		}

		/** The v1 document kept categories, assignments and device preferences in one object. */
		function migrateLegacy(raw) {
			const source = raw !== null && typeof raw === 'object' ? raw : {}
			const collapsed = {}
			const categories = []
			if (Array.isArray(source.categories)) {
				for (const entry of source.categories) {
					if (entry === null || typeof entry !== 'object') continue
					const id = textOf(entry.id, 200)
					if (id === null) continue
					const name = textOf(entry.name, 200)
					categories.push({ id, name: name === null ? '未命名分类' : name })
					if (entry.collapsed === true) collapsed[id] = true
				}
			}
			const shared = sanitizeShared({ categories, assign: source.assign })
			return {
				local: sanitizeLocal(Object.assign({}, source, { collapsed })),
				shared: { rev: 0, categories: shared.categories, assign: shared.assign, sessionOrder: shared.sessionOrder },
				pending: []
			}
		}

		function readPersisted() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY)
				if (raw !== null) {
					const parsed = JSON.parse(raw)
					const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
					const rawShared = source.shared !== null && typeof source.shared === 'object' ? source.shared : {}
					const shared = sanitizeShared(rawShared)
					const rev = typeof rawShared.rev === 'number' && Number.isFinite(rawShared.rev) && rawShared.rev >= 0 ? Math.floor(rawShared.rev) : 0
					return {
						local: sanitizeLocal(source.local),
						shared: { rev, categories: shared.categories, assign: shared.assign, sessionOrder: shared.sessionOrder },
						pending: Array.isArray(source.pending)
							? source.pending.filter((op) => op !== null && typeof op === 'object')
							: []
					}
				}
				const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
				if (legacyRaw !== null) return migrateLegacy(JSON.parse(legacyRaw))
			} catch (error) {
				console.warn('[workspace-tree] could not read saved state', error)
			}
			return { local: emptyLocal(), shared: emptyShared(), pending: [] }
		}

		const restored = readPersisted()
		let localState = restored.local
		let sharedState = restored.shared
		let pendingOps = restored.pending.slice(-MAX_PENDING_OPS)

		function buildViewState() {
			return {
				categories: sharedState.categories.map((category) => ({
					id: category.id,
					name: category.name,
					collapsed: localState.collapsed[category.id] === true
				})),
				assign: sharedState.assign,
				sessionOrder: sharedState.sessionOrder,
				expanded: localState.expanded,
				visible: localState.visible,
				archivedFilter: localState.archivedFilter
			}
		}

		let viewState = buildViewState()
		const stateListeners = new Set()

		// Write the v2 mirror (and complete a v1 migration) on load, before any
		// component mounts, so a reload after an interrupted sync still sees the
		// same outbox and Host revision.
		persist()

		/** Write the page mirror; the Host copy is written by the sync engine. */
		function persist() {
			try {
				window.localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({
						version: 2,
						local: localState,
						shared: {
							rev: sharedState.rev,
							categories: sharedState.categories,
							assign: sharedState.assign,
							sessionOrder: sharedState.sessionOrder
						},
						pending: pendingOps
					})
				)
			} catch (error) {
				console.warn('[workspace-tree] could not persist state', error)
			}
		}

		function publish() {
			viewState = buildViewState()
			for (const listener of Array.from(stateListeners)) {
				try {
					listener()
				} catch (error) {
					console.error('[workspace-tree] state listener failed', error)
				}
			}
		}

		function getViewState() {
			return viewState
		}

		/** Change device-local preferences only (no Host round trip). */
		function updateLocal(patch) {
			localState = Object.assign({}, localState, patch)
			persist()
			publish()
		}

		/** Change shared state optimistically, then queue the operation for the Host. */
		function mutateShared(ops) {
			if (ops.length === 0) return
			sharedState = Object.assign({}, sharedState, applySharedOps(sharedState, ops))
			pendingOps = pendingOps.concat(ops).slice(-MAX_PENDING_OPS)
			persist()
			publish()
			flushOps()
		}

		/* ------------------------------------------------------------------ *
		 * Host sync
		 * ------------------------------------------------------------------ */

		const sync = {
			started: false,
			/** idle | ready | offline | unsupported */
			status: 'idle',
			/** Whether a Host response has carried `sessionOrder` yet (null = unknown). */
			sessionOrderSupported: null,
			/** Operation families the Host advertises; null until a response reports them. */
			hostFeatures: null,
			flushing: false,
			pollTimer: undefined,
			retryTimer: undefined
		}

		/**
		 * Remember whether the Host document carries the manual-session-order field.
		 * A Host that predates `session.order` rejects such an op as a whole batch
		 * (HTTP 400), which would also block unrelated category edits, so those
		 * operations stay in the outbox until a Host reporting the field answers.
		 */
		function noteSharedShape(data) {
			if (data === null || typeof data !== 'object' || Array.isArray(data)) return
			sync.sessionOrderSupported = Object.prototype.hasOwnProperty.call(data, 'sessionOrder')
			sync.hostFeatures = Array.isArray(data.features)
				? data.features.filter((feature) => typeof feature === 'string')
				: null
		}

		/** Whether the Host advertised one operation family. */
		function hostSupports(feature) {
			return sync.hostFeatures !== null && sync.hostFeatures.indexOf(feature) !== -1
		}

		function syncAvailable() {
			if (typeof window.fetch !== 'function') return false
			const location = window.location
			// The Electron desktop loads the page over file:// and carries its
			// requests over IPC; a relative /api fetch cannot work there.
			if (location !== undefined && location !== null && location.protocol === 'file:') return false
			return true
		}

		function requestJson(path, init) {
			const options = Object.assign(
				{ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } },
				init
			)
			return window.fetch(path, options).then((response) => {
				if (response.status === 404) {
					// Host half not mounted (older Host, or a client-only build).
					const error = new Error('shared state route is not mounted')
					error.code = 'unsupported'
					throw error
				}
				if (!response.ok) {
					const error = new Error('shared state request failed: HTTP ' + response.status)
					error.code = 'http'
					error.status = response.status
					throw error
				}
				return response.json()
			})
		}

		function hasSharedData(shared) {
			return (
				shared.categories.length > 0 ||
				Object.keys(shared.assign).length > 0 ||
				Object.keys(shared.sessionOrder).length > 0
			)
		}

		function noteSyncFailure(error) {
			sync.status = error !== null && typeof error === 'object' && error.code === 'unsupported' ? 'unsupported' : 'offline'
			scheduleRetry()
		}

		/**
		 * Adopt one Host snapshot. Unacknowledged operations stay on top of it,
		 * so a phone editing while a desktop edit lands does not lose either.
		 */
		function adoptRemote(data, keepPending) {
			noteSharedShape(data)
			const next = sanitizeShared(data)
			const rev = data !== null && typeof data === 'object' && typeof data.rev === 'number' && Number.isFinite(data.rev) && data.rev >= 0
				? Math.floor(data.rev)
				: sharedState.rev
			const merged = keepPending && pendingOps.length > 0 ? applySharedOps(next, pendingOps) : next
			sharedState = { rev, categories: merged.categories, assign: merged.assign, sessionOrder: merged.sessionOrder }
			persist()
			publish()
		}

		/** Send the outbox; adopt the authoritative snapshot it answers with. */
		function flushOps() {
			if (sync.flushing || pendingOps.length === 0) return
			if (!syncAvailable() || sync.status === 'unsupported') return
			// Older Hosts have no `session.order` op. Keep those operations in the
			// outbox instead of failing the whole batch (and every category edit
			// with it), and let a later Host that reports `sessionOrder` flush them.
			const ordersSupported = sync.sessionOrderSupported !== false
			const movesSupported = hostSupports('category.move')
			const batch = []
			for (const op of pendingOps) {
				if (batch.length >= 200) break
				if (op === null || typeof op !== 'object') {
					batch.push(op)
					continue
				}
				if (op.type === 'session.order' && !ordersSupported) continue
				if (op.type === 'category.move' && !movesSupported) continue
				batch.push(op)
			}
			if (batch.length === 0) return
			const batchSet = new Set(batch)
			sync.flushing = true
			requestJson(SYNC_PATH, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ ops: batch })
			})
				.then((data) => {
					pendingOps = ordersSupported
						? pendingOps.slice(batch.length)
						: pendingOps.filter((op) => !batchSet.has(op))
					sync.status = 'ready'
					clearRetry()
					adoptRemote(data, true)
				})
				.catch((error) => {
					console.warn('[workspace-tree] could not sync categories with the host', error)
					noteSyncFailure(error)
				})
				.finally(() => {
					sync.flushing = false
					// Only a successful batch may chain the next one immediately.
					// Retrying a failure here would spin a microtask loop while the
					// Host is unreachable; `scheduleRetry` owns that cadence.
					if (pendingOps.length > 0 && sync.status === 'ready') flushOps()
				})
		}

		/** First contact: adopt the Host copy, or migrate this device's copy up. */
		function bootstrapSync() {
			if (!syncAvailable()) {
				sync.status = 'unsupported'
				return
			}
			const localSnapshot = {
				categories: sharedState.categories,
				assign: sharedState.assign,
				sessionOrder: sharedState.sessionOrder
			}
			requestJson(SYNC_PATH + '?since=' + sharedState.rev, { method: 'GET' })
				.then((data) => {
					sync.status = 'ready'
					clearRetry()
					const rev = typeof data.rev === 'number' && Number.isFinite(data.rev) ? Math.floor(data.rev) : 0
					if (rev === 0 && hasSharedData(localSnapshot)) {
						// A fresh Host: publish the categories this device already had.
						pendingOps = []
						return requestJson(SYNC_PATH, {
							method: 'POST',
							headers: { 'content-type': 'application/json', accept: 'application/json' },
							body: JSON.stringify({ replace: localSnapshot })
						}).then((seeded) => adoptRemote(seeded, false))
					}
					adoptRemote(data, true)
					if (pendingOps.length > 0) flushOps()
					return undefined
				})
				.catch((error) => {
					console.warn('[workspace-tree] could not reach the host category state', error)
					noteSyncFailure(error)
				})
		}

		/** Cheap revision poll; only a new `rev` triggers a full adopt. */
		function pollSync() {
			if (!sync.started) return
			if (pendingOps.length > 0) {
				flushOps()
				return
			}
			if (sync.status === 'unsupported' || sync.status === 'idle') return
			if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
			requestJson(SYNC_PATH + '?since=' + sharedState.rev, { method: 'GET' })
				.then((data) => {
					sync.status = 'ready'
					clearRetry()
					// `changed:false` still carries the document shape, which is how a
					// page that outlived a Host upgrade learns `session.order` is accepted.
					noteSharedShape(data)
					if (data !== null && typeof data === 'object' && data.changed === true) adoptRemote(data, false)
					if (pendingOps.length > 0) flushOps()
				})
				.catch(noteSyncFailure)
		}

		function scheduleRetry() {
			if (sync.retryTimer !== undefined) return
			sync.retryTimer = window.setTimeout(() => {
				sync.retryTimer = undefined
				if (!sync.started) return
				if (sync.status === 'unsupported') bootstrapSync()
				else pollSync()
			}, SYNC_RETRY_MS)
		}

		function clearRetry() {
			if (sync.retryTimer === undefined) return
			window.clearTimeout(sync.retryTimer)
			sync.retryTimer = undefined
		}

		function refreshNow() {
			if (!sync.started) return
			if (sync.status === 'unsupported' || sync.status === 'idle') bootstrapSync()
			else if (pendingOps.length > 0) flushOps()
			else pollSync()
		}

		function onVisibilityChange() {
			if (typeof document !== 'undefined' && document.visibilityState === 'visible') refreshNow()
		}

		function startSync() {
			if (sync.started) return
			sync.started = true
			if (!syncAvailable()) {
				sync.status = 'unsupported'
				return
			}
			document.addEventListener('visibilitychange', onVisibilityChange)
			window.addEventListener('focus', refreshNow)
			window.addEventListener('online', refreshNow)
			sync.pollTimer = window.setInterval(pollSync, SYNC_POLL_MS)
			bootstrapSync()
		}

		function stopSync() {
			if (!sync.started) return
			sync.started = false
			if (sync.pollTimer !== undefined) window.clearInterval(sync.pollTimer)
			sync.pollTimer = undefined
			clearRetry()
			document.removeEventListener('visibilitychange', onVisibilityChange)
			window.removeEventListener('focus', refreshNow)
			window.removeEventListener('online', refreshNow)
		}

		function subscribeViewState(listener) {
			stateListeners.add(listener)
			return () => {
				stateListeners.delete(listener)
			}
		}

		function useViewState() {
			return react.useSyncExternalStore(subscribeViewState, getViewState, getViewState)
		}

		/** Subscribe to one of the Cordis snapshot stores delivered as a prop. */
		function useStoreSnapshot(store) {
			const subscribe = react.useCallback((listener) => store.subscribe(listener), [store])
			const getSnapshot = react.useCallback(() => store.getSnapshot(), [store])
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
		}

		/**
		 * What the tree renders when the core workspace/session controllers are
		 * missing from the composition.
		 *
		 * Every supported DSH build mounts both (`workspaces` and `sessions` are
		 * provided by the api controllers next to the official browser), but the
		 * hover/actions path is written to tolerate their absence per call, and the
		 * slot must not throw on its very first render: the slot machinery
		 * abdicates a single-slot entry that throws once, so the whole browser
		 * would disappear until the page is reloaded. These constant stores keep
		 * the tree mounted with its empty state instead.
		 */
		const EMPTY_WORKSPACES_SNAPSHOT = Object.freeze({
			items: [],
			archivedSessionIds: [],
			pinnedSessionIds: [],
			phase: 'ready'
		})
		const EMPTY_SESSIONS_SNAPSHOT = Object.freeze({ ids: [], byId: {}, phase: 'ready' })
		const EMPTY_WORKSPACES_STORE = Object.freeze({
			getSnapshot: () => EMPTY_WORKSPACES_SNAPSHOT,
			subscribe: () => () => {}
		})
		const EMPTY_SESSIONS_STORE = Object.freeze({
			getSnapshot: () => EMPTY_SESSIONS_SNAPSHOT,
			subscribe: () => () => {}
		})

		/**
		 * Resolve the two snapshot stores handed to the slot props, degrading to
		 * empty stores when a controller is not mounted.
		 *
		 * @param ctx - client root context.
		 * @returns {{ workspacesStore: object, sessionsStore: object }}
		 */
		function coreStores(ctx) {
			const workspaces = ctx.get('workspaces')
			const sessions = ctx.get('sessions')
			return {
				workspacesStore:
					workspaces !== undefined && workspaces !== null && workspaces.list !== undefined
						? workspaces.list
						: EMPTY_WORKSPACES_STORE,
				sessionsStore:
					sessions !== undefined && sessions !== null && sessions.list !== undefined
						? sessions.list
						: EMPTY_SESSIONS_STORE
			}
		}

		let idSeq = 0
		function newCategoryId() {
			idSeq += 1
			return 'cat_' + Date.now().toString(36) + '_' + idSeq.toString(36)
		}

		/* ------------------------------------------------------------------ *
		 * Derivations
		 * ------------------------------------------------------------------ */

		const UNASSIGNED_ID = '__unassigned__'

		function timeOf(value) {
			if (typeof value === 'number' && Number.isFinite(value)) return value
			const parsed = Date.parse(typeof value === 'string' ? value : '')
			return Number.isNaN(parsed) ? 0 : parsed
		}

		/**
		 * Whether one persisted composer draft carries something the user typed.
		 *
		 * The official conversation plugin persists the per-Session draft under
		 * `dsh.conversation.<sessionId>` as `{ draft: { text, references,
		 * command? }, view, viewRequest }`; older builds stored the draft value as
		 * a bare string. Any text (after trimming), reference chip or command chip
		 * makes the draft "not empty".
		 *
		 * @param draft - decoded `draft` field.
		 * @returns true when the composer would show user content.
		 */
		function draftHasContent(draft) {
			if (typeof draft === 'string') return draft.trim() !== ''
			if (draft === null || typeof draft !== 'object') return false
			if (typeof draft.text === 'string' && draft.text.trim() !== '') return true
			if (Array.isArray(draft.references) && draft.references.length > 0) return true
			return draft.command !== undefined && draft.command !== null
		}

		/**
		 * Read one Session's persisted composer draft and report whether it has
		 * content. Storage is per browser origin, so on the device that typed the
		 * draft the tree keeps that blank Session visible; another device simply
		 * sees it as unused.
		 *
		 * @param sessionId - Session whose draft to inspect.
		 * @returns true when the stored draft is non-empty.
		 */
		function composerDraftHasContent(sessionId) {
			const storage = typeof window === 'undefined' ? undefined : window.localStorage
			if (storage === undefined || storage === null) return false
			try {
				const raw = storage.getItem(CONVERSATION_STORE_KEY + '.' + sessionId)
				if (raw === null) return false
				const stored = JSON.parse(raw)
				if (stored === null || typeof stored !== 'object') return draftHasContent(stored)
				return draftHasContent(stored.draft)
			} catch (error) {
				return false
			}
		}

		/**
		 * True when a blank Session row is abandoned enough to hide from the tree.
		 *
		 * Blank means the Host bought the Session but no turn ever started; see
		 * the `Empty-Session cleanup` comment for the full policy. The active row,
		 * drafted rows, rows created inside the grace window, running rows and
		 * titled rows are all kept.
		 *
		 * @param summary - `sessions.list` row.
		 * @param activeSessionId - Session the main view currently holds, if any.
		 * @param now - wall clock for the grace window (epoch ms).
		 * @returns true when the row can be removed from the rendered tree.
		 */
		function isEmptySession(summary, activeSessionId, now) {
			if (summary === undefined || summary === null) return false
			if (summary.blank !== true) return false
			if (summary.id === activeSessionId) return false
			if (summary.running === true) return false
			if (typeof summary.title === 'string' && summary.title.trim() !== '') return false
			const updatedAt = timeOf(summary.updatedAt)
			if (updatedAt > 0 && now - updatedAt < EMPTY_SESSION_GRACE_MS) return false
			return !composerDraftHasContent(summary.id)
		}

		/** Message for a thrown value, whatever it happens to be. */
		function describe(reason) {
			return reason instanceof Error ? reason.message : String(reason)
		}

		/**
		 * True when the Host refused an archive because the Session still has
		 * work in progress. `workspaces.archiveSession` rethrows the refusal as
		 * a `WorkspaceArchiveError` carrying the offending RPC error, so the
		 * code below is the same one the built-in browser tests.
		 */
		function isActiveRefusal(reason) {
			if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return false
			const rpcError = reason.rpcError
			return rpcError !== undefined && rpcError !== null && rpcError.code === 'workspace/session-active'
		}

		/**
		 * Sessions belonging to one workspace, in the browser's own order.
		 *
		 * Rows carry an `archived` flag so the tree can offer archive on a live
		 * row and unarchive on a restored one. The filter is tri-state and
		 * mirrors the built-in browser exactly: "default" drops archived rows,
		 * "show" keeps everything, "only" keeps archived rows exclusively.
		 *
		 * @param workspace - workspace item from the workspaces snapshot.
		 * @param workspaceSnapshot - `workspaces.list` snapshot (archive/pin sets).
		 * @param sessionSnapshot - `sessions.list` snapshot (row metadata).
		 * @param categoryFilter - lowercased search needle; '' means no filter.
		 * @param archivedFilter - "default" | "show" | "only".
		 * @returns session rows, pinned first then most recently updated.
		 */
		/**
		 * Order the members of one workspace by its saved manual order.
		 *
		 * Without a saved order the built-in browser's rule applies (most
		 * recently updated first). With one, known members keep that order and
		 * members the saved list has never seen (a newly created Session, or a
		 * Session that appeared while another device held the old order) lead by
		 * recency: a fresh Session appears at the top instead of at an arbitrary
		 * middle position. Pinned rows are fronted afterwards, like the built-in
		 * browser, so a pin change never rewrites the saved order.
		 *
		 * @param rows - member rows already carrying `archived`.
		 * @param savedOrder - Host-shared session id order for this workspace, or undefined.
		 * @returns the ordered rows.
		 */
		function orderSessionRows(rows, savedOrder) {
			if (!Array.isArray(savedOrder) || savedOrder.length === 0) {
				return rows.sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt))
			}
			const byId = new Map(rows.map((row) => [row.id, row]))
			const ordered = []
			for (const id of savedOrder) {
				const row = byId.get(id)
				if (row === undefined) continue
				ordered.push(row)
				byId.delete(id)
			}
			const strangers = Array.from(byId.values()).sort(
				(left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt) || (left.id < right.id ? -1 : 1)
			)
			return strangers.concat(ordered)
		}

		/**
		 * Sessions belonging to one workspace, in the browser's own order.
		 *
		 * Rows carry an `archived` flag so the tree can offer archive on a live
		 * row and unarchive on a restored one. The filter is tri-state and
		 * mirrors the built-in browser exactly: "default" drops archived rows,
		 * "show" keeps everything, "only" keeps archived rows exclusively.
		 * Subagent sessions stay out of the tree; forked sessions are ordinary
		 * members and stay visible (their `parentId` is lineage, not ownership).
		 *
		 * @param workspace - workspace item from the workspaces snapshot.
		 * @param workspaceSnapshot - `workspaces.list` snapshot (archive/pin sets).
		 * @param sessionSnapshot - `sessions.list` snapshot (row metadata).
		 * @param categoryFilter - lowercased search needle; '' means no filter.
		 * @param archivedFilter - "default" | "show" | "only".
		 * @param savedOrder - Host-shared manual order for this workspace, if any.
		 * @returns session rows, pinned first then in manual (or recency) order.
		 */
		function sessionsOf(workspace, workspaceSnapshot, sessionSnapshot, categoryFilter, archivedFilter, savedOrder) {
			const archived = new Set(workspaceSnapshot.archivedSessionIds || [])
			const pinned = new Set(workspaceSnapshot.pinnedSessionIds || [])
			const members = []
			for (const id of workspace.sessionIds || []) {
				const summary = (sessionSnapshot.byId || {})[id]
				if (summary === undefined) continue
				// Subagent sessions stay out of the tree, like the built-in browser.
				// Do NOT drop every row with a `parentId`: a forked Session also
				// carries its source as `parentId` (lineage for nesting), and it is an
				// ordinary workspace member that belongs in the list. Only rows whose
				// `origin` says subagent are hidden.
				if (summary.origin === 'subagent') continue
				members.push(Object.assign({}, summary, { archived: archived.has(id) }))
			}
			const ordered = orderSessionRows(members, savedOrder)
			const rows = []
			for (const row of ordered) if (pinned.has(row.id)) rows.push(row)
			for (const row of ordered) if (!pinned.has(row.id)) rows.push(row)
			return rows.filter((row) => {
				if (archivedFilter === 'default' && row.archived) return false
				if (archivedFilter === 'only' && !row.archived) return false
				if (categoryFilter !== '' && !matches(row, categoryFilter)) return false
				return true
			})
		}

		/**
		 * Insert one id immediately before `anchor`, or append when the anchor is
		 * omitted. The anchor is looked up in the list *without* the moved id, so
		 * "before the row after me" is a no-op instead of an off-by-one move.
		 *
		 * @param ids - current order, without the moved id.
		 * @param id - id to insert.
		 * @param anchor - id to insert before, or undefined to append.
		 * @returns the new order.
		 */
		function insertIdBefore(ids, id, anchor) {
			const next = ids.slice()
			if (anchor === undefined) {
				next.push(id)
				return next
			}
			const at = next.indexOf(anchor)
			if (at === -1) next.push(id)
			else next.splice(at, 0, id)
			return next
		}

		/**
		 * Resolve one drag insertion against a group order.
		 *
		 * @param ids - group member ids in display order (the dragged id included).
		 * @param draggedId - id being moved.
		 * @param targetId - row the pointer is over.
		 * @param side - "before" | "after" relative to `targetId`.
		 * @returns the new order and the insert anchor (undefined appends), or
		 *   null when the target is not part of the group.
		 */
		function resolveReorder(ids, draggedId, targetId, side) {
			if (draggedId === targetId) return null
			const without = ids.filter((id) => id !== draggedId)
			const index = without.indexOf(targetId)
			if (index === -1) return null
			const anchor = side === 'before' ? targetId : index + 1 < without.length ? without[index + 1] : undefined
			return { order: insertIdBefore(without, draggedId, anchor), anchor }
		}

		/** Whether the pointer sits on the upper or lower half of the target row. */
		function dropSideAt(event) {
			const rect = event.currentTarget.getBoundingClientRect()
			return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
		}

		/* ------------------------------------------------------------------ *
		 * Drag presentation: folded rows and edge autoscroll
		 * ------------------------------------------------------------------ */

		/**
		 * Which level the tree folds for the duration of a drag.
		 *
		 * A reorder is only meaningful among peers, so while a row is dragged
		 * everything below its level folds away: dragging a category hides every
		 * workspace, dragging a workspace hides every session. Sessions are the
		 * deepest level, so dragging one folds nothing. The fold is derived from
		 * the live drag object and is never written to the local state, so
		 * releasing the row (drop, cancel, or a lost `dragend`) restores the
		 * previous open/closed layout exactly.
		 *
		 * @param dragState - the live drag object, or null.
		 * @returns "categories" (fold every category) | "workspaces" (fold every
		 *   workspace) | null.
		 */
		function dragFoldOf(dragState) {
			if (dragState === null || dragState === undefined) return null
			if (dragState.kind === 'category') return 'categories'
			if (dragState.kind === 'workspace') return 'workspaces'
			return null
		}

		/** Height of the edge band, in pixels, that scrolls the list while dragging. */
		const AUTOSCROLL_EDGE = 36
		/** Fastest edge scroll, in pixels per frame. */
		const AUTOSCROLL_MAX_STEP = 16

		/**
		 * How far the row list should scroll for one drag pointer.
		 *
		 * The band is measured from the list viewport rather than from the whole
		 * sidebar: a pointer inside the top `AUTOSCROLL_EDGE` pixels scrolls up,
		 * one in the bottom band scrolls down, and the speed ramps linearly with
		 * how deep into the band it sits. Nothing moves when the list is already
		 * at that end, when the pointer is horizontally away from the list (a drag
		 * over the main view must not scroll the sidebar), or when it is above or
		 * below both bands.
		 *
		 * @param pointer - `{ x, y }` in client coordinates.
		 * @param view - `{ top, bottom, left, right, scrollTop, clientHeight,
		 *   scrollHeight }` of the scrolled element.
		 * @returns signed pixels for one frame (negative scrolls up).
		 */
		function autoScrollStep(pointer, view) {
			if (pointer === null || pointer === undefined) return 0
			const height = Math.max(0, view.bottom - view.top)
			if (height === 0) return 0
			if (pointer.x < view.left - AUTOSCROLL_EDGE || pointer.x > view.right + AUTOSCROLL_EDGE) return 0
			const edge = Math.min(AUTOSCROLL_EDGE, height / 2)
			const viewport = view.clientHeight > 0 ? view.clientHeight : height
			const atTop = view.scrollTop <= 0
			const atBottom = view.scrollTop + viewport >= view.scrollHeight - 1
			const intoTop = view.top + edge - pointer.y
			if (intoTop > 0) {
				if (atTop) return 0
				return -Math.max(1, Math.round(Math.min(1, intoTop / edge) * AUTOSCROLL_MAX_STEP))
			}
			const intoBottom = pointer.y - (view.bottom - edge)
			if (intoBottom > 0) {
				if (atBottom) return 0
				return Math.max(1, Math.round(Math.min(1, intoBottom / edge) * AUTOSCROLL_MAX_STEP))
			}
			return 0
		}

		/** `requestAnimationFrame` with a timer fallback for hosts that lack it. */
		function requestFrame(callback) {
			const win = typeof window === 'undefined' ? undefined : window
			if (win === undefined) return 0
			if (typeof win.requestAnimationFrame === 'function') return win.requestAnimationFrame(callback)
			if (typeof win.setTimeout === 'function') return win.setTimeout(callback, 16)
			return 0
		}

		function cancelFrame(frame) {
			if (frame === 0 || frame === undefined || frame === null) return
			const win = typeof window === 'undefined' ? undefined : window
			if (win === undefined) return
			if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame)
			else if (typeof win.clearTimeout === 'function') win.clearTimeout(frame)
		}

		/** Read one private drag payload exactly (never the generic text/plain fallback). */
		function draggedPayloadOf(event, mime) {
			try {
				const transfer = event.dataTransfer
				if (transfer === null || transfer === undefined) return null
				const value = transfer.getData(mime)
				return typeof value === 'string' && value !== '' ? value : null
			} catch (error) {
				return null
			}
		}

		/** Read the payload of a drag, tolerating browsers that expose no DataTransfer. */
		function draggedIdOf(event, mime) {
			try {
				const transfer = event.dataTransfer
				if (transfer === null || transfer === undefined) return null
				const value = transfer.getData(mime) || transfer.getData('text/plain')
				return typeof value === 'string' && value !== '' ? value : null
			} catch (error) {
				return null
			}
		}

		function matches(summary, needle) {
			if (needle === '') return true
			const haystack = [summary.displayTitle, summary.title, summary.cwd, summary.id]
				.filter((value) => typeof value === 'string')
				.join('\u0000')
				.toLowerCase()
			return haystack.includes(needle)
		}

		function matchesWorkspace(workspace, needle) {
			if (needle === '') return true
			const haystack = [workspace.title, workspace.path, workspace.workspaceId]
				.filter((value) => typeof value === 'string')
				.join('\u0000')
				.toLowerCase()
			return haystack.includes(needle)
		}

		/* ------------------------------------------------------------------ *
		 * Work-status markers
		 * ------------------------------------------------------------------ */

		/**
		 * The unified UI status lives on the `uiSession` Cordis service
		 * (`sessionStatus`): a `Map<sessionId, { running, pendingInteraction,
		 * completionUnread }>` the built-in browser also reads. Session rows show
		 * the primary state as a dot; a folded workspace or category row shows the
		 * aggregate of the session rows it hides, so a fold never loses the fact
		 * that something inside is running, waiting for the user, or finished.
		 *
		 * Priority mirrors the built-in browser: a pending interaction outranks
		 * live activity, which outranks the unread-completion reminder.
		 */
		const PENDING_STATUS_LABELS = {
			approval: '等待审批',
			'plan-review': '等待审阅',
			question: '等待回答'
		}
		const STATUS_SEVERITY = { warning: 3, ongoing: 2, done: 1 }
		const EMPTY_STATUS_MAP = new Map()

		/** One session's status facts, falling back to the list row's `running` flag. */
		function statusFacts(status, summary) {
			const running = status !== undefined && status !== null && status.running !== undefined
				? status.running === true
				: summary !== undefined && summary.running === true
			const interaction = status !== undefined && status !== null ? status.pendingInteraction : undefined
			const pendingKind = interaction !== undefined && interaction !== null && typeof interaction.kind === 'string'
				? interaction.kind
				: undefined
			const completed = status !== undefined && status !== null && status.completionUnread === true
			return { running, pendingKind, completed }
		}

		/**
		 * The dot one session row shows, or `null` when the row is idle.
		 *
		 * Archived rows keep their live `running` / waiting dot but not the
		 * completion reminder — the built-in browser hides `done`/`idle` there
		 * too, because an archived row cannot be opened to acknowledge it.
		 */
		function sessionStatusView(status, summary, archived) {
			const facts = statusFacts(status, summary)
			if (facts.pendingKind !== undefined) {
				return { state: 'warning', label: PENDING_STATUS_LABELS[facts.pendingKind] || '等待处理' }
			}
			if (facts.running) return { state: 'ongoing', label: '运行中' }
			if (facts.completed && archived !== true) return { state: 'done', label: '已完成' }
			return null
		}

		/**
		 * Roll several session rows into the one dot a folded ancestor shows.
		 *
		 * @param statuses - `uiSession.sessionStatus` snapshot.
		 * @param summaries - session rows the ancestor hides.
		 * @returns `{ state, label, count }` of the highest-priority state, or null.
		 */
		function summarizeStatuses(statuses, summaries) {
			const counts = { warning: 0, ongoing: 0, done: 0 }
			for (const summary of summaries) {
				if (summary === undefined || summary === null) continue
				const view = sessionStatusView(statuses.get(summary.id), summary, summary.archived === true)
				if (view !== null) counts[view.state] += 1
			}
			let state = null
			for (const candidate of Object.keys(STATUS_SEVERITY)) {
				if (counts[candidate] > 0 && (state === null || STATUS_SEVERITY[candidate] > STATUS_SEVERITY[state])) state = candidate
			}
			if (state === null) return null
			const parts = []
			if (counts.warning > 0) parts.push('等待处理 ' + counts.warning)
			if (counts.ongoing > 0) parts.push('运行中 ' + counts.ongoing)
			if (counts.done > 0) parts.push('已完成 ' + counts.done)
			return { state, label: parts.join(' · '), count: counts.warning + counts.ongoing + counts.done }
		}

		/**
		 * A `useSyncExternalStore` source over `uiSession.sessionStatus`.
		 *
		 * The service is taken from `ctx.inject` rather than a one-shot lookup so
		 * a tree that mounts before the Session UI still upgrades when it
		 * appears; listeners registered in the meantime are attached at that
		 * point and asked to re-read. Without the service a row still shows the
		 * list's own `running` flag and folds show no aggregate rather than
		 * throwing.
		 */
		function createSessionStatusSource(ctx) {
			let source
			const listeners = new Map()
			function attach() {
				if (source === undefined) return
				for (const [listener, unsubscribe] of listeners) {
					if (unsubscribe !== undefined) continue
					listeners.set(listener, source.subscribe(listener))
				}
			}
			ctx.inject(['uiSession'], (sessionCtx) => {
				const uiSession = sessionCtx.uiSession
				if (uiSession === undefined || uiSession === null || uiSession.sessionStatus === undefined) return
				source = uiSession.sessionStatus
				attach()
				// The tree re-reads as soon as the service has a snapshot.
				for (const listener of Array.from(listeners.keys())) {
					try {
						listener()
					} catch (error) {
						console.error('[workspace-tree] status listener failed', error)
					}
				}
				return () => {
					source = undefined
					for (const [listener, unsubscribe] of listeners) {
						if (unsubscribe !== undefined) unsubscribe()
						listeners.set(listener, undefined)
					}
				}
			})
			return {
				getSnapshot() {
					if (source === undefined || typeof source.getSnapshot !== 'function') return EMPTY_STATUS_MAP
					const snapshot = source.getSnapshot()
					return snapshot === undefined || snapshot === null ? EMPTY_STATUS_MAP : snapshot
				},
				subscribe(listener) {
					const unsubscribe = source === undefined ? undefined : source.subscribe(listener)
					listeners.set(listener, unsubscribe)
					return () => {
						const current = listeners.get(listener)
						listeners.delete(listener)
						if (current !== undefined) current()
					}
				}
			}
		}

		/** The dot itself: the app's `StateDot` when seeded, our CSS dot otherwise. */
		function StatusMark(props) {
			const label = props.label
			const title = props.title === undefined ? label : props.title
			return h(
				'span',
				{ className: cls('twt-status', props.className), title, 'aria-label': label, role: 'img' },
				StateDot === null
					? h('span', { className: 'twt-status-dot', 'data-state': props.state })
					: h(StateDot, { state: props.state, size: 12 })
			)
		}

		/** Group workspace items under the declared categories. */
		function groupWorkspaces(workspaces, state) {
			const known = new Set(state.categories.map((category) => category.id))
			const buckets = new Map(state.categories.map((category) => [category.id, []]))
			const unassigned = []
			for (const workspace of workspaces) {
				const target = state.assign[workspace.workspaceId]
				if (target !== undefined && known.has(target)) buckets.get(target).push(workspace)
				else unassigned.push(workspace)
			}
			return { buckets, unassigned }
		}

		function currentMainSession(sessionSnapshot) {
			for (const id of sessionSnapshot.ids || []) {
				const summary = (sessionSnapshot.byId || {})[id]
				if (summary !== undefined && (summary.retainedBy || {}).mainView > 0) return id
			}
			return undefined
		}

		function workspaceOf(sessionId, workspaces) {
			for (const workspace of workspaces) {
				if ((workspace.sessionIds || []).includes(sessionId)) return workspace.workspaceId
			}
			return undefined
		}

		/* ------------------------------------------------------------------ *
		 * Icons
		 * ------------------------------------------------------------------ */

		const PATHS = {
			chevron: 'M6 3.5 10.5 8 6 12.5',
			plus: 'M8 3.2v9.6M3.2 8h9.6',
			pencil: 'M11.6 2.4l2 2-7.4 7.4-2.8.8.8-2.8z',
			close: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
			search: 'M7 2.6a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8zM10.3 10.3 13.6 13.6',
			layers: 'M8 2.2 14 5.5 8 8.8 2 5.5zM2 9l6 3.3L14 9M2 12.2 8 15.5l6-3.3',
			folder: 'M2.2 4.6A1.6 1.6 0 0 1 3.8 3h2.1l1.3 1.7h5A1.6 1.6 0 0 1 13.8 6.3v5.1A1.6 1.6 0 0 1 12.2 13H3.8A1.6 1.6 0 0 1 2.2 11.4z',
			archive: 'M2.4 2.9h11.2v2.9H2.4zM3.4 5.8h9.2v6.6a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2zM6.3 8.3h3.4',
			unarchive: 'M2.4 2.9h11.2v2.9H2.4zM3.4 5.8h9.2v6.6a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2zM8 12.9V8.1M6.1 10l1.9-1.9L9.9 10',
			trash: 'M3.4 4.7h9.2M6.3 4.7V3.4h3.4v1.3M4.7 4.7l.6 8.1h5.4l.6-8.1M6.8 7v3.3M9.2 7v3.3',
			filter: 'M2.6 4h10.8L9.2 8.6v4.1l-2.4 1.2V8.6z'
		}

		function Icon(props) {
			const size = props.size === undefined ? 13 : props.size
			return h(
				'svg',
				{
					className: 'twt-svg',
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					'aria-hidden': 'true',
					focusable: 'false'
				},
				h('path', {
					d: PATHS[props.name],
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: props.name === 'chevron' ? 1.7 : 1.35,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				})
			)
		}

		function cls() {
			let out = ''
			for (const value of arguments) {
				if (typeof value === 'string' && value !== '') out = out === '' ? value : out + ' ' + value
			}
			return out
		}

		/**
		 * A hover-revealed icon button that never steals the row's own click.
		 *
		 * The hint is the app's own `Tooltip` primitive when it is seeded (same
		 * side/align/delay as the built-in browser's archive button, so the pill
		 * lands below the icon, right-aligned, after 500 ms). Without the
		 * primitive the button falls back to a native `title` — and only then,
		 * because two tooltips for one hover would be worse than none.
		 */
		function RowButton(props) {
			const button = h(
				'button',
				{
					type: 'button',
					className: cls('twt-icon', props.className),
					title: Tooltip === null ? props.label : undefined,
					'aria-label': props.label,
					disabled: props.disabled === true,
					onClick: (event) => {
						event.preventDefault()
						event.stopPropagation()
						if (props.disabled === true) return
						props.onClick(event)
					},
					onMouseDown: (event) => event.stopPropagation()
				},
				props.children
			)
			if (Tooltip === null) return button
			return h(
				Tooltip,
				{ label: props.label, side: 'bottom', align: 'end', delayMs: 500 },
				button
			)
		}

		/* ------------------------------------------------------------------ *
		 * Tree rows
		 * ------------------------------------------------------------------ */

		function SessionRow(props) {
			const {
				summary,
				status,
				active,
				busy,
				renaming,
				onOpen,
				onArchive,
				onUnarchive,
				onRenameStart,
				onRenameCommit,
				onRenameCancel,
				draggable,
				dragging,
				dropSide,
				onDragStart,
				onDragEnd,
				onDragOver,
				onDrop
			} = props
			const archived = summary.archived === true
			// Committing by clicking somewhere in the row (blur) must not also open
			// the session: the blur handler runs before that click, so it arms a
			// short suppression window the row's own click consumes.
			const openSuppressedUntil = react.useRef(0)
			return h(
				'div',
				{
					className: cls(
						'twt-row',
						'twt-session',
						active && 'twt-active',
						archived && 'twt-archived',
						// `busy` disables the row's buttons while the archive call runs;
						// the row itself must not animate (a rotating row looks broken).
						dragging && 'twt-dragging',
						dropSide === 'before' && 'twt-drop-before',
						dropSide === 'after' && 'twt-drop-after'
					),
					role: 'button',
					tabIndex: 0,
					title: renaming === true ? undefined : summary.displayTitle,
					draggable: draggable === true && renaming !== true,
					onDragStart: draggable === true && renaming !== true ? onDragStart : undefined,
					onDragEnd: onDragEnd,
					onDragOver: onDragOver,
					onDrop: onDrop,
					// While the inline rename input is open, row clicks are the
					// input's own (blur commits) — they must not open the session.
					onClick: () => {
						if (renaming === true) return
						if (openSuppressedUntil.current > Date.now()) return
						onOpen(summary.id)
					},
					onKeyDown: (event) => {
						if (renaming === true) return
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onOpen(summary.id)
						}
					}
				},
				renaming === true
					? h('input', {
							className: 'twt-input twt-input-inline twt-session-input',
							defaultValue: summary.displayTitle,
							autoFocus: true,
							onClick: (event) => event.stopPropagation(),
							onMouseDown: (event) => event.stopPropagation(),
							onFocus: (event) => event.currentTarget.select(),
							onBlur: (event) => {
								openSuppressedUntil.current = Date.now() + 300
								onRenameCommit(event.target.value)
							},
							onKeyDown: (event) => {
								event.stopPropagation()
								if (event.key === 'Enter') onRenameCommit(event.currentTarget.value)
								else if (event.key === 'Escape') onRenameCancel()
							}
						})
					: h('span', { className: cls('twt-label', summary.blank && 'twt-muted') }, summary.displayTitle),
				status === null || status === undefined
					? null
					: h(StatusMark, { state: status.state, label: status.label, title: status.label }),
				// Both hover actions sit in one display:none container, the same
				// pattern as the workspace/category rows: at rest they take no width,
				// so the status dot lands at the row end instead of hovering over
				// invisible buttons. Rename first, then the archive toggle the
				// built-in browser also offers. A blank (unsent) Session has no title
				// to own yet; the built-in browser keeps rename off those rows too.
				h(
					'div',
					{ className: 'twt-session-actions' },
					summary.blank === true
						? null
						: h(
								RowButton,
								{
									label: '重命名会话',
									disabled: busy === true,
									onClick: () => onRenameStart()
								},
								h(Icon, { name: 'pencil', size: 12 })
							),
					h(
						RowButton,
						{
							label: archived ? '取消归档' : '归档会话',
							disabled: busy === true,
							onClick: () => (archived ? onUnarchive(summary.id) : onArchive(summary.id))
						},
						h(Icon, { name: archived ? 'unarchive' : 'archive', size: 13 })
					)
				)
			)
		}

		function WorkspaceRow(props) {
			const {
				workspace,
				sessions,
				expanded,
				visibleCount,
				statuses,
				activeSessionId,
				onToggle,
				onOpenSession,
				onNewSession,
				onArchiveSession,
				onUnarchiveSession,
				busySessionId,
				deleting,
				onDelete,
				renaming,
				onRenameStart,
				onRenameCommit,
				onRenameCancel,
				renamingSessionId,
				onSessionRenameStart,
				onSessionRenameCommit,
				onSessionRenameCancel,
				draggingRow,
				workspaceDropSide,
				draggingSessionId,
				sessionDropHint,
				onWorkspaceDragStart,
				onWorkspaceDragEnd,
				onWorkspaceDragOver,
				onWorkspaceDrop,
				onSessionDragStart,
				onSessionDragEnd,
				onSessionDragOver,
				onSessionDrop
			} = props

			const shown = sessions.slice(0, visibleCount)
			const hidden = sessions.length - shown.length
			// Rows the fold hides: the whole list when collapsed, otherwise only
			// the tail beyond the current `显示更多` watermark.
			const hiddenStatus = summarizeStatuses(statuses, expanded ? sessions.slice(visibleCount) : sessions)

			return h(
				'div',
				{ className: 'twt-workspace' },
				h(
					'div',
					{
						className: cls(
							'twt-row',
							'twt-ws-head',
							draggingRow && 'twt-dragging',
							workspaceDropSide === 'before' && 'twt-drop-before',
							workspaceDropSide === 'after' && 'twt-drop-after'
						),
						role: 'button',
						tabIndex: 0,
						title: workspace.path,
						draggable: renaming !== true,
						onDragStart: onWorkspaceDragStart,
						onDragEnd: onWorkspaceDragEnd,
						onDragOver: onWorkspaceDragOver,
						onDrop: onWorkspaceDrop,
						onClick: onToggle,
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								onToggle()
							}
						}
					},
					h(
						'button',
						{
							type: 'button',
							className: cls('twt-chevron', expanded && 'twt-chevron-open'),
							'aria-label': expanded ? '折叠' : '展开',
							'onaria-expanded': expanded,
							onClick: (event) => {
								event.stopPropagation()
								onToggle()
							}
						},
						h(Icon, { name: 'chevron', size: 11 })
					),
					renaming
						? h('input', {
								className: 'twt-input twt-input-inline',
								defaultValue: workspace.title || workspace.path,
								autoFocus: true,
								onClick: (event) => event.stopPropagation(),
								onMouseDown: (event) => event.stopPropagation(),
								onFocus: (event) => event.currentTarget.select(),
								onBlur: (event) => onRenameCommit(event.target.value),
								onKeyDown: (event) => {
									event.stopPropagation()
									if (event.key === 'Enter') onRenameCommit(event.currentTarget.value)
									else if (event.key === 'Escape') onRenameCancel()
								}
							})
						: h('span', { className: 'twt-label twt-ws-label' }, workspace.title || workspace.path),
					hiddenStatus === null || hiddenStatus === undefined
						? null
						: h(StatusMark, {
								state: hiddenStatus.state,
								label: '已折叠的会话：' + hiddenStatus.label,
								title: hiddenStatus.label
							}),
					h('span', { className: 'twt-count' }, String(sessions.length)),
					// Idle rows must show the whole workspace title: every hover-only
					// action (new session, rename, delete) sits in one
					// container that is `display:none` until the row is hovered or holds
					// focus. Without the container the hidden buttons would still reserve
					// their width (and flex gaps), truncating the label with an ellipsis.
					h(
						'div',
						{ className: 'twt-ws-actions' },
						h(RowButton, { label: '在此工作区新建会话', onClick: onNewSession }, h(Icon, { name: 'plus' })),
						h(RowButton, { label: '重命名工作区', onClick: onRenameStart }, h(Icon, { name: 'pencil', size: 13 })),
						h(
							RowButton,
							{
								label: '删除工作区',
								disabled: deleting === true,
								onClick: onDelete
							},
							h(Icon, { name: 'trash', size: 13 })
						)
					)
				),
				expanded
					? h(
							'div',
							{ className: 'twt-sessions' },
							shown.map((summary) =>
								h(SessionRow, {
									key: summary.id,
									summary,
									status: sessionStatusView(statuses.get(summary.id), summary, summary.archived === true),
									active: summary.id === activeSessionId,
									busy: summary.id === busySessionId,
									renaming: renamingSessionId === summary.id,
									draggable: summary.blank !== true && summary.archived !== true,
									dragging: draggingSessionId !== null && draggingSessionId === summary.id,
									dropSide:
										sessionDropHint !== null && sessionDropHint.id === summary.id
											? sessionDropHint.side
											: null,
									onOpen: onOpenSession,
									onArchive: onArchiveSession,
									onUnarchive: onUnarchiveSession,
									onRenameStart: () => onSessionRenameStart(summary.id),
									onRenameCommit: (title) => onSessionRenameCommit(summary.id, title),
									onRenameCancel: () => onSessionRenameCancel(),
									onDragStart: (event) => onSessionDragStart(summary.id, event),
									onDragEnd: onSessionDragEnd,
									onDragOver: (event) => onSessionDragOver(summary.id, event),
									onDrop: (event) => onSessionDrop(summary.id, event)
								})
							),
							hidden > 0
								? h(
										'button',
										{
											type: 'button',
											className: 'twt-more',
											onClick: (event) => {
												event.stopPropagation()
												props.onShowMore()
											}
										},
										'显示更多 (' + hidden + ')'
									)
								: null,
							sessions.length === 0 ? h('div', { className: 'twt-empty' }, '暂无会话') : null
						)
					: null
			)
		}

		function CategoryRow(props) {
			const {
				category,
				workspaces,
				status,
				dropActive,
				renaming,
				busy,
				onToggle,
				onRenameStart,
				onRenameCommit,
				onRenameCancel,
				onDelete,
				onNewWorkspace,
				onDrop,
				onDragOver,
				onDragLeave,
				onDragStart,
				onDragEnd,
				dragging,
				dropSide,
				children
			} = props

			const inputRef = react.useRef(null)
			react.useEffect(() => {
				if (renaming && inputRef.current !== null) {
					inputRef.current.focus()
					inputRef.current.select()
				}
			}, [renaming])

			const row = h(
				'div',
				{
					className: cls(
						'twt-row',
						'twt-cat',
						dropActive && 'twt-drop',
						dragging && 'twt-dragging',
						dropSide === 'before' && 'twt-drop-before',
						dropSide === 'after' && 'twt-drop-after'
					),
					role: 'button',
					tabIndex: 0,
					draggable: renaming !== true,
					onDragStart,
					onDragEnd,
					onClick: onToggle,
					onDragOver,
					onDragLeave,
					onDrop,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onToggle()
						}
					}
				},
				h(
					'button',
					{
						type: 'button',
						className: cls('twt-chevron', !category.collapsed && 'twt-chevron-open'),
						'aria-label': category.collapsed ? '展开' : '折叠',
						onClick: (event) => {
							event.stopPropagation()
							onToggle()
						}
					},
					h(Icon, { name: 'chevron', size: 11 })
				),
				renaming
					? h('input', {
							ref: inputRef,
							className: 'twt-input twt-input-inline',
							defaultValue: category.name,
							onClick: (event) => event.stopPropagation(),
							onBlur: (event) => onRenameCommit(event.target.value),
							onKeyDown: (event) => {
								event.stopPropagation()
								if (event.key === 'Enter') onRenameCommit(event.currentTarget.value)
								else if (event.key === 'Escape') onRenameCancel()
							}
						})
					: h('span', { className: 'twt-label twt-cat-label' }, category.name),
				status === null || status === undefined
					? null
					: h(StatusMark, {
							state: status.state,
							label: '分类内会话：' + status.label,
							title: status.label
						}),
				h('span', { className: 'twt-count' }, String(workspaces)),
				// Same hover-only container as the workspace row: at rest the
				// actions take no width, so the status dot sits at the row end next
				// to the count; hovering reveals them and pushes the dot left.
				h(
					'div',
					{ className: cls('twt-cat-actions', busy && 'twt-cat-actions-open') },
					h(
						'button',
						{
							type: 'button',
							className: 'twt-icon',
							title: busy ? '正在新建工作区…' : '在此分类新建工作区',
							'aria-label': '在此分类新建工作区',
							disabled: busy,
							onClick: (event) => {
								event.stopPropagation()
								onNewWorkspace()
							}
						},
						h(Icon, { name: 'plus' })
					),
					h(RowButton, { label: '重命名分类', onClick: onRenameStart }, h(Icon, { name: 'pencil' })),
					h(RowButton, { label: '删除分类', onClick: onDelete }, h(Icon, { name: 'close' }))
				)
			)

			return h('div', { className: 'twt-cat-block' }, row, category.collapsed ? null : children)
		}

		/* ------------------------------------------------------------------ *
		 * The tree
		 * ------------------------------------------------------------------ */

		function WorkspaceTree(props) {
			const state = useViewState()
			const workspaceSnapshot = useStoreSnapshot(props.workspacesStore)
			const sessionSnapshot = useStoreSnapshot(props.sessionsStore)
			// `uiSession.sessionStatus`: running / pending-interaction / unread
			// completion facts for every Session row (the built-in browser's own
			// source for its status dots).
			const statuses = react.useSyncExternalStore(
				props.sessionStatusSource.subscribe,
				props.sessionStatusSource.getSnapshot,
				props.sessionStatusSource.getSnapshot
			)
			const [query, setQuery] = react.useState('')
			const [renamingId, setRenamingId] = react.useState(null)
			const [creating, setCreating] = react.useState(false)
			const [dragCategory, setDragCategory] = react.useState(null)
			// True while the add-workspace flow (folder dialog + `workspaces.create`)
			// runs: the triggers are disabled so a second dialog cannot open, but
			// nothing animates — a spinning row of `＋` buttons reads as a stuck UI.
			const [adding, setAdding] = react.useState(false)
			const [error, setError] = react.useState(null)
			const [busySessionId, setBusySessionId] = react.useState(null)
			const [deletingWorkspaceId, setDeletingWorkspaceId] = react.useState(null)
			const [renamingWorkspaceId, setRenamingWorkspaceId] = react.useState(null)
			const [renamingSessionId, setRenamingSessionId] = react.useState(null)
			// One shared drag object carries either a workspace or a session move;
			// `dropHint` is the row that would receive it and which half is hot.
			const [dragState, setDragState] = react.useState(null)
			const [dropHint, setDropHint] = react.useState(null)
			// The scrolling row list; edge autoscroll only moves this element.
			const scrollRef = react.useRef(null)
			// Drop bar at the top of the tree, shown only while a row is dragged:
			// "cancel" ends the drag with no change, "delete" removes the row.
			const [dropZone, setDropZone] = react.useState(null)
			const dropBarRef = react.useRef(null)
			// Locally accepted Session titles. The Host persists a rename in the
			// Session log, but this connection only receives a title projection for
			// a Session it is following (an opened one); a plain sidebar row reads a
			// cached list hint that will not refresh on its own. Holding the
			// accepted title here keeps the row honest immediately on the device
			// that renamed; the entry retires once the list snapshot catches up.
			const [sessionTitles, setSessionTitles] = react.useState({})
			const [undo, setUndo] = react.useState(null)
			// Wall clock for the empty-Session grace window: a blank row leaves the
			// tree on the next snapshot change anyway, but this tick makes the
			// expiry happen on time when nothing else about the list changed.
			const [clock, setClock] = react.useState(() => Date.now())
			react.useEffect(() => {
				const timer = window.setInterval(() => setClock(Date.now()), EMPTY_SESSION_RESCAN_MS)
				return () => window.clearInterval(timer)
			}, [])
			const undoTimer = react.useRef(undefined)
			react.useEffect(
				() => () => {
					if (undoTimer.current !== undefined) clearTimeout(undoTimer.current)
				},
				[]
			)

			const narrow = props.wide === false
			const needle = query.trim().toLowerCase()

			const workspaceItems = react.useMemo(
				() => (workspaceSnapshot.items || []).filter((workspace) => matchesWorkspace(workspace, needle)),
				[workspaceSnapshot, needle]
			)
			const grouped = react.useMemo(() => groupWorkspaces(workspaceItems, state), [workspaceItems, state])
			const activeSessionId = currentMainSession(sessionSnapshot)
			// Rows under a workspace, computed once per snapshot/filter change so a
			// folded category can aggregate its descendants without repeating the
			// per-workspace derivation. Abandoned blank Sessions are filtered here,
			// so the workspace count, the collapsed-row status aggregate and the
			// 显示更多 watermark all agree with what is actually visible.
			const sessionsByWorkspace = react.useMemo(() => {
				const map = new Map()
				for (const workspace of workspaceItems) {
					map.set(
						workspace.workspaceId,
						sessionsOf(
							workspace,
							workspaceSnapshot,
							sessionSnapshot,
							needle,
							state.archivedFilter,
							state.sessionOrder[workspace.workspaceId]
						).filter((row) => !isEmptySession(row, activeSessionId, clock))
					)
				}
				return map
			}, [workspaceItems, workspaceSnapshot, sessionSnapshot, needle, state.archivedFilter, state.sessionOrder, activeSessionId, clock])
			const activeWorkspaceId = activeSessionId === undefined ? undefined : workspaceOf(activeSessionId, workspaceSnapshot.items || [])

			// ---- mutations ----
			//
			// Category rows and assignments are Host state (`mutateShared`), so
			// every device converges on the same tree; folding a category,
			// expanding a workspace and the archived filter are this device's
			// preferences (`updateLocal`).

			const assign = react.useCallback((workspaceId, categoryId) => {
				mutateShared([
					{
						type: 'assign',
						workspaceId,
						categoryId: categoryId === UNASSIGNED_ID || categoryId === undefined ? null : categoryId
					}
				])
			}, [])

			const createCategory = react.useCallback(
				(name) => {
					const trimmed = name.trim()
					if (trimmed === '') return
					const category = { id: newCategoryId(), name: trimmed }
					mutateShared([{ type: 'category.add', category }])
					return category.id
				},
				[]
			)

			const renameCategory = react.useCallback((categoryId, name) => {
				const trimmed = name.trim()
				setRenamingId(null)
				if (trimmed === '') return
				mutateShared([{ type: 'category.rename', id: categoryId, name: trimmed }])
			}, [])

			const deleteCategory = react.useCallback((categoryId) => {
				const category = getViewState().categories.find((entry) => entry.id === categoryId)
				const label = category === undefined ? '这个分类' : '“' + category.name + '”'
				if (!window.confirm('删除 ' + label + '？分类下的工作区会回到「未分类」。')) return
				// The Host drops every assignment that pointed at this category.
				mutateShared([{ type: 'category.delete', id: categoryId }])
				const collapsed = Object.assign({}, localState.collapsed)
				delete collapsed[categoryId]
				updateLocal({ collapsed })
			}, [])

			const toggleCategory = react.useCallback((categoryId) => {
				const collapsed = Object.assign({}, localState.collapsed)
				if (collapsed[categoryId] === true) delete collapsed[categoryId]
				else collapsed[categoryId] = true
				updateLocal({ collapsed })
			}, [])

			const toggleWorkspace = react.useCallback((workspaceId) => {
				const expanded = Object.assign({}, localState.expanded)
				if (expanded[workspaceId] === true) delete expanded[workspaceId]
				else expanded[workspaceId] = true
				updateLocal({ expanded })
			}, [])

			const showMore = react.useCallback((workspaceId) => {
				const visible = Object.assign({}, localState.visible)
				visible[workspaceId] = (visible[workspaceId] === undefined ? SESSION_DEFAULT : visible[workspaceId]) + SESSION_STEP
				updateLocal({ visible })
			}, [])

			const openSession = react.useCallback(
				(sessionId) => {
					try {
						props.openSession(sessionId)
					} catch (error) {
						console.error('[workspace-tree] open session failed', error)
					}
				},
				[props.openSession]
			)

			const newSession = react.useCallback(
				(workspaceId) => {
					try {
						props.startSession(workspaceId)
					} catch (error) {
						console.error('[workspace-tree] new session failed', error)
					}
				},
				[props.startSession]
			)

			/**
			 * Open the newly created workspace with its first Session.
			 *
			 * The built-in browser leaves a fresh workspace empty and waits for the
			 * user to press its `＋`; here the add-workspace flow itself starts the
			 * Session, so picking a folder lands on a ready-to-type conversation in
			 * that folder. `uiWorkspace.startSession` creates the blank Session and
			 * swaps the main view to it; the row is expanded first so the new
			 * Session is visible in the tree as well.
			 *
			 * @param workspaceId - the Workspace that was just registered.
			 */
			const openFirstSession = react.useCallback(
				(workspaceId) => {
					if (localState.expanded[workspaceId] !== true) {
						const expanded = Object.assign({}, localState.expanded)
						expanded[workspaceId] = true
						updateLocal({ expanded })
					}
					try {
						props.startSession(workspaceId)
					} catch (error) {
						console.error('[workspace-tree] start session in new workspace failed', error)
					}
				},
				[props.startSession]
			)

			/**
			 * Add a workspace through the `workspaceDefaultDirectory` service provided
			 * by `@local/dsh-workspace-default-directory`: that service opens the
			 * official in-app "Select Workspace Directory" dialog seeded with the
			 * configured default directory, and this tree adopts the picked path with
			 * `workspaces.create`, filing the new row under the category whose `＋`
			 * started the flow (`UNASSIGNED_ID` / undefined leaves it uncategorised).
			 * A workspace that did not exist before is then opened with its first
			 * Session (see `openFirstSession`).
			 *
			 * Re-entrancy is guarded on `adding`, not on a ref, because the trigger
			 * buttons are disabled while the chooser is up — and the chooser can stay
			 * up for as long as the user browses. While the flow runs the triggers
			 * are disabled only; nothing rotates, so a long folder browse does not
			 * leave a spinner behind on the sidebar.
			 */
			const addWorkspace = react.useCallback(
				(categoryId) => {
					if (adding) return
					setError(null)
					setAdding(true)
					const knownWorkspaceIds = new Set((workspaceSnapshot.items || []).map((item) => item.workspaceId))
					Promise.resolve(props.createWorkspace())
						.then((workspace) => {
							if (workspace === null || workspace === undefined) return
							if (categoryId !== undefined && categoryId !== UNASSIGNED_ID) {
								assign(workspace.workspaceId, categoryId)
							}
							// picking an already-registered folder reuses its row; only a
							// genuinely new workspace gets the opening Session.
							if (knownWorkspaceIds.has(workspace.workspaceId)) return
							openFirstSession(workspace.workspaceId)
						})
						.catch((reason) => {
							setError('新建工作区失败：' + describe(reason))
							console.error('[workspace-tree] add workspace failed', reason)
						})
						.finally(() => setAdding(false))
				},
				[adding, assign, openFirstSession, props.createWorkspace, workspaceSnapshot]
			)

			/**
			 * Delete one workspace after confirmation, mirroring the built-in
			 * browser's action. The Host delete only removes the registration
			 * (`workspaces.delete`): the directory and the Session logs stay on
			 * disk. This tree renders Sessions strictly under their workspace, so
			 * the removed workspace's Sessions leave the tree with it — the
			 * confirmation says so instead of implying the logs were deleted.
			 */
			const deleteWorkspace = react.useCallback(
				(workspaceId) => {
					const workspace = (workspaceSnapshot.items || []).find((item) => item.workspaceId === workspaceId)
					const name =
						workspace === undefined ? workspaceId : workspace.title || workspace.path || workspaceId
					const question =
						'删除工作区「' +
						name +
						'」？\n\n只会把它从工作区列表中移除：磁盘上的文件夹和会话记录都会保留。' +
						'不过这棵树只按工作区展示会话，删除后它的会话不会再显示在这里（官方列表的「未分组」中仍可找到）。'
					if (!window.confirm(question)) return
					setError(null)
					setDeletingWorkspaceId(workspaceId)
					Promise.resolve()
						.then(() => props.deleteWorkspace(workspaceId))
						.then(() => {
							// The workspace registration is gone host-side; drop our
							// assignment for it (shared) and this device's row state.
							const view = getViewState()
							const ops = []
							if (view.assign[workspaceId] !== undefined) ops.push({ type: 'assign', workspaceId, categoryId: null })
							// A deleted workspace leaves its manual session order behind;
							// an empty list tells the Host to drop the entry.
							if (view.sessionOrder[workspaceId] !== undefined) {
								ops.push({ type: 'session.order', workspaceId, sessionIds: [] })
							}
							if (ops.length > 0) mutateShared(ops)
							const expanded = Object.assign({}, localState.expanded)
							delete expanded[workspaceId]
							const visible = Object.assign({}, localState.visible)
							delete visible[workspaceId]
							updateLocal({ expanded, visible })
						})
						.catch((reason) => {
							setError('删除工作区失败：' + describe(reason))
							console.error('[workspace-tree] delete workspace failed', reason)
						})
						.finally(() => setDeletingWorkspaceId(null))
				},
				[props.deleteWorkspace, workspaceSnapshot]
			)

			/**
			 * Rename one workspace in place. The row swaps its label for an input
			 * while `renamingWorkspaceId` names it; Enter or blur commits, Escape
			 * cancels. An empty or unchanged draft is a no-op, and a title already
			 * used by another workspace is refused before the Host call (the
			 * built-in browser's "已存在同名工作区" rule).
			 */
			const renameWorkspace = react.useCallback(
				(workspaceId, title) => {
					setRenamingWorkspaceId(null)
					const items = workspaceSnapshot.items || []
					const target = items.find((item) => item.workspaceId === workspaceId)
					if (target === undefined) return
					const trimmed = title.trim()
					if (trimmed === '') return
					if (trimmed === (target.title || '')) return
					const duplicate = items.some(
						(item) => item.workspaceId !== workspaceId && (item.title || '') === trimmed
					)
					if (duplicate) {
						setError('已存在名为「' + trimmed + '」的工作区。')
						return
					}
					setError(null)
					Promise.resolve()
						.then(() => props.renameWorkspace(workspaceId, trimmed))
						.catch((reason) => {
							setError('重命名工作区失败：' + describe(reason))
							console.error('[workspace-tree] rename workspace failed', reason)
						})
				},
				[props.renameWorkspace, workspaceSnapshot]
			)

			// ---- rename sessions ----

			/**
			 * Rename one Session in place. The Host owns the title log and the
			 * normalization (`session/title-invalid` for an empty text, byte
			 * truncation for long ones), so the accepted title comes back in the
			 * response and that exact text is what the row shows.
			 *
			 * A Session row only receives a live title projection while the
			 * Session is followed, so the accepted title is also kept locally
			 * (`sessionTitles`) until the list snapshot reports it: the renaming
			 * device sees the new name at once, and every other device (including
			 * dsh-pocket's mobile page) reads it from the Host on its next list
			 * refresh / reload — the title is Host state, not localStorage.
			 */
			const renameSession = react.useCallback(
				(sessionId, title) => {
					setRenamingSessionId(null)
					const summary = (sessionSnapshot.byId || {})[sessionId]
					if (summary === undefined) return
					const trimmed = title.trim()
					if (trimmed === '') return
					const current = sessionTitles[sessionId] !== undefined ? sessionTitles[sessionId] : summary.displayTitle
					if (trimmed === current) return
					setError(null)
					Promise.resolve()
						.then(() => props.renameSession(sessionId, trimmed))
						.then((value) => {
							const accepted =
								value !== undefined && value !== null && typeof value.title === 'string' && value.title !== ''
									? value.title
									: trimmed
							setSessionTitles((titles) => Object.assign({}, titles, { [sessionId]: accepted }))
						})
						.catch((reason) => {
							setError('重命名会话失败：' + describe(reason))
							console.error('[workspace-tree] rename session failed', reason)
						})
				},
				[props.renameSession, sessionSnapshot, sessionTitles]
			)

			// Retire overrides the list snapshot now agrees with, so a later Host
			// title change (another device's rename, or automatic generation) wins.
			react.useEffect(() => {
				const byId = sessionSnapshot.byId || {}
				const settled = Object.keys(sessionTitles).filter(
					(id) => byId[id] !== undefined && byId[id].title === sessionTitles[id]
				)
				if (settled.length === 0) return
				setSessionTitles((titles) => {
					const next = Object.assign({}, titles)
					for (const id of settled) delete next[id]
					return next
				})
			}, [sessionSnapshot, sessionTitles])

			// ---- archive / unarchive sessions ----

			/** Arm the "undo" strip; a later archive replaces the pending one. */
			const showUndo = react.useCallback((sessionId, title) => {
				if (undoTimer.current !== undefined) clearTimeout(undoTimer.current)
				setUndo({ sessionId, title })
				undoTimer.current = setTimeout(() => {
					undoTimer.current = undefined
					setUndo(null)
				}, 10000)
			}, [])

			/**
			 * Archive one session, mirroring the built-in browser's flow.
			 *
			 * The Host refuses to archive a session that still has work in
			 * progress (`workspace/session-active`); the built-in browser reacts
			 * by asking "stop and archive?". We keep that two-step shape, with a
			 * plain `confirm()` because this plugin injects no UI primitives.
			 * The refusal is detected on the error, not on `summary.running`, so
			 * a session that merely looks idle still gets the real answer.
			 */
			const archiveSession = react.useCallback(
				(sessionId) => {
					const summary = (sessionSnapshot.byId || {})[sessionId]
					const title = summary !== undefined ? summary.displayTitle || sessionId : sessionId
					setBusySessionId(sessionId)
					setError(null)
					const run = async () => {
						try {
							await props.archiveSession(sessionId)
						} catch (reason) {
							if (!isActiveRefusal(reason)) throw reason
							const question =
								'“' +
								title +
								'”仍有正在进行的工作。\n\n归档会先停止这些工作；之后可在侧栏筛选「仅归档」中恢复会话，被停止的工作不会自动继续。\n\n确定停止并归档吗？'
							if (!window.confirm(question)) return false
							await props.archiveSession(sessionId, { stopActivity: true })
						}
						return true
					}
					run()
						.then((archived) => {
							if (archived) showUndo(sessionId, title)
						})
						.catch((reason) => {
							setError('归档失败：' + describe(reason))
							console.error('[workspace-tree] archive failed', reason)
						})
						.finally(() => setBusySessionId(null))
				},
				[sessionSnapshot, props.archiveSession, showUndo]
			)

			const unarchiveSession = react.useCallback(
				(sessionId) => {
					setBusySessionId(sessionId)
					setError(null)
					setUndo(null)
					Promise.resolve(props.unarchiveSession(sessionId))
						.catch((reason) => {
							setError('取消归档失败：' + describe(reason))
							console.error('[workspace-tree] unarchive failed', reason)
						})
						.finally(() => setBusySessionId(null))
				},
				[props.unarchiveSession]
			)

			const undoArchive = react.useCallback(() => {
				if (undo === null) return
				unarchiveSession(undo.sessionId)
			}, [undo, unarchiveSession])

			// ---- drag & drop: reorder rows, reassign workspaces ----
			//
			// One drag object carries either a workspace move or a session move.
			// Workspace rows accept workspaces (insert before/after; a target in
			// another category also reassigns the dragged row). Session rows accept
			// only sessions of their own workspace, so the account membership never
			// changes here. Category rows keep the older "move this workspace into
			// me" drop.
			//
			// Session order is Host-shared (`session.order` ops); workspace order is
			// the Host registry order (`workspaces.insertBefore`). Both therefore
			// survive a reload and reach `dsh-pocket` through the same `/api`
			// carrier.

			/** Category key (`id` or 未分类) a workspace currently renders under. */
			const categoryKeyOf = react.useCallback(
				(workspaceId) => {
					const target = state.assign[workspaceId]
					if (target === undefined) return UNASSIGNED_ID
					return state.categories.some((category) => category.id === target) ? target : UNASSIGNED_ID
				},
				[state]
			)

			const endDrag = react.useCallback(() => {
				setDragState(null)
				setDropHint(null)
				setDragCategory(null)
				setDropZone(null)
			}, [])

			/**
			 * The top drop bar: while a row is dragged it offers two exits that do
			 * not depend on the list — releasing over 取消 ends the drag with no
			 * change at all (the row keeps its position), releasing over 删除 runs
			 * the same destructive action the row's own hover button runs.
			 */
			const dragBarOver = react.useCallback(
				(zone, event) => {
					if (dragState === null) return
					event.preventDefault()
					event.stopPropagation()
					try {
						event.dataTransfer.dropEffect = 'move'
					} catch (error) {
						/* dropEffect is best-effort */
					}
					setDropHint(null)
					setDragCategory(null)
					setDropZone(zone)
				},
				[dragState]
			)

			const dragBarDrop = react.useCallback(
				(zone, event) => {
					if (dragState === null) return
					event.preventDefault()
					event.stopPropagation()
					const drag = dragState
					endDrag()
					if (zone !== 'delete') return
					// Reuse the row's existing action, confirmation included: a
					// category is deleted, a workspace leaves the list, and a session
					// is archived (DSH has no delete-session API; the undo strip covers
					// it). The drag state names the row; the payload read is the
					// fallback for a drag whose source row unmounted mid-flight.
					if (drag.kind === 'category') {
						const id = drag.categoryId ?? draggedPayloadOf(event, DRAG_CATEGORY_MIME)
						if (id !== null && id !== undefined) deleteCategory(id)
						return
					}
					if (drag.kind === 'workspace') {
						const id = drag.workspaceId ?? draggedPayloadOf(event, DRAG_WORKSPACE_MIME)
						if (id !== null && id !== undefined) deleteWorkspace(id)
						return
					}
					const id = drag.sessionId ?? draggedPayloadOf(event, DRAG_SESSION_MIME)
					if (id !== null && id !== undefined) archiveSession(id)
				},
				[archiveSession, deleteCategory, deleteWorkspace, dragState, endDrag]
			)

			/**
			 * Keep a dragged row reachable: while the pointer sits in the list's
			 * top or bottom edge band the list scrolls itself, so a row can be
			 * carried far beyond the visible range.
			 *
			 * `dragover` reports the pointer only while it moves, so the position
			 * is remembered and a frame loop keeps scrolling while the pointer is
			 * held still at the edge. The loop stops on drop/cancel, when the
			 * pointer leaves the window, and once the list cannot move further.
			 */
			react.useEffect(() => {
				if (dragState === null) return undefined
				const win = window
				let pointer = null
				let frame = 0
				const tick = () => {
					frame = 0
					const list = scrollRef.current
					if (list === null || pointer === null) return
					const rect = list.getBoundingClientRect()
					const step = autoScrollStep(pointer, {
						top: rect.top,
						bottom: rect.bottom,
						left: rect.left,
						right: rect.right,
						scrollTop: list.scrollTop,
						clientHeight: list.clientHeight,
						scrollHeight: list.scrollHeight
					})
					// Reaching an end (or leaving the band) parks the loop; the next
					// `dragover` restarts it if the pointer is still in a band.
					if (step === 0) {
						pointer = null
						return
					}
					list.scrollTop += step
					frame = requestFrame(tick)
				}
				const onDragOver = (event) => {
					// The drop bar sits at the top of the tree: hovering it selects an
					// exit, so it must not also drag the list along.
					const bar = dropBarRef.current
					if (
						bar !== null &&
						typeof bar.contains === 'function' &&
						event.target !== null &&
						event.target !== undefined &&
						bar.contains(event.target)
					) {
						pointer = null
						if (frame !== 0) {
							cancelFrame(frame)
							frame = 0
						}
						return
					}
					pointer = { x: event.clientX, y: event.clientY }
					if (frame === 0) frame = requestFrame(tick)
				}
				// Drop/cancel and leaving the window park the loop; a later
				// `dragover` (a drag that is still running) restarts it.
				const stop = () => {
					pointer = null
					if (frame !== 0) {
						cancelFrame(frame)
						frame = 0
					}
				}
				const onDragLeave = (event) => {
					// Leaving the window ends the drag feedback; moving between rows
					// keeps the pointer position.
					if (event.relatedTarget === null || event.relatedTarget === undefined) stop()
				}
				win.addEventListener('dragover', onDragOver, true)
				win.addEventListener('dragend', stop, true)
				win.addEventListener('drop', stop, true)
				win.addEventListener('dragleave', onDragLeave, true)
				return () => {
					stop()
					win.removeEventListener('dragover', onDragOver, true)
					win.removeEventListener('dragend', stop, true)
					win.removeEventListener('drop', stop, true)
					win.removeEventListener('dragleave', onDragLeave, true)
				}
			}, [dragState])

			const startWorkspaceDrag = react.useCallback((workspaceId, event) => {
				event.stopPropagation()
				setDragState({ kind: 'workspace', workspaceId })
				setDropHint(null)
				setDragCategory(null)
				try {
					event.dataTransfer.setData(DRAG_WORKSPACE_MIME, workspaceId)
					event.dataTransfer.setData('text/plain', workspaceId)
					event.dataTransfer.effectAllowed = 'move'
				} catch (error) {
					/* drag payload is best-effort */
				}
			}, [])

			const startSessionDrag = react.useCallback((workspaceId, sessionId, event) => {
				event.stopPropagation()
				setDragState({ kind: 'session', workspaceId, sessionId })
				setDropHint(null)
				setDragCategory(null)
				try {
					event.dataTransfer.setData(DRAG_SESSION_MIME, sessionId)
					event.dataTransfer.setData('text/plain', sessionId)
					event.dataTransfer.effectAllowed = 'move'
				} catch (error) {
					/* drag payload is best-effort */
				}
			}, [])

			const startCategoryDrag = react.useCallback((categoryId, event) => {
				event.stopPropagation()
				setDragState({ kind: 'category', categoryId })
				setDropHint(null)
				setDragCategory(null)
				try {
					event.dataTransfer.setData(DRAG_CATEGORY_MIME, categoryId)
					event.dataTransfer.setData('text/plain', categoryId)
					event.dataTransfer.effectAllowed = 'move'
				} catch (error) {
					/* drag payload is best-effort */
				}
			}, [])

			/** Insert one workspace before/after the row under the pointer. */
			const workspaceDragOver = react.useCallback(
				(workspaceId, event) => {
					if (dragState === null || dragState.kind !== 'workspace') return
					if (dragState.workspaceId === workspaceId) return
					event.preventDefault()
					event.stopPropagation()
					try {
						event.dataTransfer.dropEffect = 'move'
					} catch (error) {
						/* dropEffect is best-effort */
					}
					setDragCategory(null)
					const side = dropSideAt(event)
					setDropHint((current) =>
						current !== null && current.kind === 'workspace' && current.id === workspaceId && current.side === side
							? current
							: { kind: 'workspace', id: workspaceId, side }
					)
				},
				[dragState]
			)

			const workspaceDrop = react.useCallback(
				(targetId, event) => {
					event.preventDefault()
					event.stopPropagation()
					const draggedId =
						dragState !== null && dragState.kind === 'workspace'
							? dragState.workspaceId
							: draggedIdOf(event, DRAG_WORKSPACE_MIME)
					const side = dropSideAt(event)
					endDrag()
					if (draggedId === null || draggedId === targetId) return
					const items = workspaceSnapshot.items || []
					const targetCategory = categoryKeyOf(targetId)
					const groupIds = items
						.filter((item) => categoryKeyOf(item.workspaceId) === targetCategory)
						.map((item) => item.workspaceId)
					const moved = resolveReorder(groupIds, draggedId, targetId, side)
					if (moved === null) return
					if (moved.order.length === groupIds.length && moved.order.every((id, index) => id === groupIds[index])) return
					setError(null)
					if (categoryKeyOf(draggedId) !== targetCategory) {
						assign(draggedId, targetCategory === UNASSIGNED_ID ? null : targetCategory)
					}
					// Omit the anchor to append the row to the Host order; within
					// its category that reads as "after the last row".
					Promise.resolve()
						.then(() => props.insertWorkspaceBefore(draggedId, moved.anchor))
						.catch((reason) => {
							setError('调整工作区顺序失败：' + describe(reason))
							console.error('[workspace-tree] reorder workspace failed', reason)
						})
				},
				[dragState, categoryKeyOf, workspaceSnapshot, assign, props.insertWorkspaceBefore, endDrag]
			)

			/** Insert one session within its workspace's saved order. */
			const sessionDragOver = react.useCallback(
				(workspaceId, targetId, event) => {
					if (dragState === null || dragState.kind !== 'session') return
					if (dragState.workspaceId !== workspaceId || dragState.sessionId === targetId) return
					// Pins front a section; moving a row across the pin boundary cannot
					// be expressed as a manual order, so refuse that drop up front.
					const pinned = new Set(workspaceSnapshot.pinnedSessionIds || [])
					if (pinned.has(dragState.sessionId) !== pinned.has(targetId)) return
					event.preventDefault()
					event.stopPropagation()
					try {
						event.dataTransfer.dropEffect = 'move'
					} catch (error) {
						/* dropEffect is best-effort */
					}
					const side = dropSideAt(event)
					setDropHint((current) =>
						current !== null && current.kind === 'session' && current.id === targetId && current.side === side
							? current
							: { kind: 'session', workspaceId, id: targetId, side }
					)
				},
				[dragState, workspaceSnapshot]
			)

			const sessionDrop = react.useCallback(
				(workspaceId, targetId, event) => {
					event.preventDefault()
					event.stopPropagation()
					const draggedSessionId =
						dragState !== null && dragState.kind === 'session' && dragState.workspaceId === workspaceId
							? dragState.sessionId
							: draggedIdOf(event, DRAG_SESSION_MIME)
					const side = dropSideAt(event)
					endDrag()
					if (draggedSessionId === null || draggedSessionId === targetId) return
					const workspace = (workspaceSnapshot.items || []).find((item) => item.workspaceId === workspaceId)
					if (workspace === undefined) return
					const pinned = new Set(workspaceSnapshot.pinnedSessionIds || [])
					if (pinned.has(draggedSessionId) !== pinned.has(targetId)) return
					const ids = sessionsOf(
						workspace,
						workspaceSnapshot,
						sessionSnapshot,
						'',
						'show',
						state.sessionOrder[workspaceId]
					).map((row) => row.id)
					const moved = resolveReorder(ids, draggedSessionId, targetId, side)
					if (moved === null) return
					if (moved.order.length === ids.length && moved.order.every((id, index) => id === ids[index])) return
					setError(null)
					mutateShared([{ type: 'session.order', workspaceId, sessionIds: moved.order }])
				},
				[dragState, workspaceSnapshot, sessionSnapshot, state.sessionOrder, endDrag]
			)

			/**
			 * Category headers accept two drops: a workspace (move it into this
			 * category, the older behaviour) and another category (reorder the
			 * header list). The 未分类 pseudo-header is not a category, so it only
			 * takes workspaces.
			 */
			const dropHandlers = react.useCallback(
				(categoryId) => ({
					onDragOver: (event) => {
						if (dragState === null) return
						if (dragState.kind === 'category') {
							if (categoryId === UNASSIGNED_ID || dragState.categoryId === categoryId) return
							event.preventDefault()
							event.stopPropagation()
							try {
								event.dataTransfer.dropEffect = 'move'
							} catch (error) {
								/* dropEffect is best-effort */
							}
							setDragCategory(null)
							const side = dropSideAt(event)
							setDropHint((current) =>
								current !== null && current.kind === 'category' && current.id === categoryId && current.side === side
									? current
									: { kind: 'category', id: categoryId, side }
							)
							return
						}
						if (dragState.kind !== 'workspace') return
						event.preventDefault()
						event.stopPropagation()
						setDropHint(null)
						setDragCategory(categoryId)
					},
					onDragLeave: () => {
						setDragCategory((current) => (current === categoryId ? null : current))
						setDropHint((current) =>
							current !== null && current.kind === 'category' && current.id === categoryId ? null : current
						)
					},
					onDrop: (event) => {
						// The drag state normally names the source; the payload read is
						// the fallback for a drag whose source row unmounted mid-flight.
						const draggedCategory =
							dragState !== null && dragState.kind === 'category'
								? dragState.categoryId
								: draggedPayloadOf(event, DRAG_CATEGORY_MIME)
						event.preventDefault()
						event.stopPropagation()
						if (draggedCategory !== null) {
							const side = dropSideAt(event)
							endDrag()
							if (categoryId === UNASSIGNED_ID || draggedCategory === categoryId) return
							const ids = state.categories.map((category) => category.id)
							const moved = resolveReorder(ids, draggedCategory, categoryId, side)
							if (moved === null) return
							if (moved.order.length === ids.length && moved.order.every((id, index) => id === ids[index])) return
							setError(null)
							mutateShared([{ type: 'category.move', id: draggedCategory, beforeId: moved.anchor }])
							return
						}
						if (dragState === null || dragState.kind !== 'workspace') return
						const workspaceId = dragState.workspaceId
						endDrag()
						if (workspaceId !== null) assign(workspaceId, categoryId)
					}
				}),
				[assign, dragState, endDrag, state.categories]
			)

			// ---- narrow rail (collapsed sidebar) ----

			if (narrow) {
				const railCategories = state.categories
				return h(
					'div',
					{ className: 'twt-root twt-narrow' },
					railCategories.length > 0
						? railCategories.map((category) =>
								h(
									'button',
									{
										key: category.id,
										type: 'button',
										className: 'twt-rail',
										title: category.name,
										onClick: () => props.expandSidebar()
									},
									h(Icon, { name: 'folder', size: 16 })
								)
							)
						: null,
					(workspaceSnapshot.items || []).map((workspace) =>
						h(
							'button',
							{
								key: workspace.workspaceId,
								type: 'button',
								className: 'twt-rail',
								title: workspace.title || workspace.path,
								onClick: () => props.expandSidebar()
							},
							h(Icon, { name: 'layers', size: 16 })
						)
					)
				)
			}

			// ---- full tree ----

			// While a row is dragged the tree shows only the level being reordered,
			// so the pointer can travel between peers without crossing rows that
			// belong to a deeper level. Session drags fold nothing (sessions are the
			// deepest level), and the fold is never written back to the local state:
			// the render after the drag restores the previous open/closed layout.
			const fold = dragFoldOf(dragState)

			const renderWorkspace = (workspace) => {
				const expanded = fold === 'workspaces' ? false : state.expanded[workspace.workspaceId] === true
				const baseSessions = sessionsByWorkspace.get(workspace.workspaceId) || []
				// Overlay accepted-but-not-yet-reflected titles without mutating the
				// snapshot row the sessions service owns.
				const sessions =
					Object.keys(sessionTitles).length === 0
						? baseSessions
						: baseSessions.map((summary) =>
								sessionTitles[summary.id] === undefined
									? summary
									: Object.assign({}, summary, {
											displayTitle: sessionTitles[summary.id],
											title: sessionTitles[summary.id]
										})
							)
				return h(WorkspaceRow, {
					key: workspace.workspaceId,
					workspace,
					sessions,
					expanded,
					visibleCount: state.visible[workspace.workspaceId] === undefined ? SESSION_DEFAULT : state.visible[workspace.workspaceId],
					statuses,
					activeSessionId,
					busySessionId,
					onToggle: () => toggleWorkspace(workspace.workspaceId),
					onShowMore: () => showMore(workspace.workspaceId),
					onOpenSession: openSession,
					onNewSession: () => newSession(workspace.workspaceId),
					onArchiveSession: archiveSession,
					onUnarchiveSession: unarchiveSession,
					deleting: deletingWorkspaceId === workspace.workspaceId,
					onDelete: () => deleteWorkspace(workspace.workspaceId),
					renaming: renamingWorkspaceId === workspace.workspaceId,
					onRenameStart: () => setRenamingWorkspaceId(workspace.workspaceId),
					onRenameCommit: (title) => renameWorkspace(workspace.workspaceId, title),
					onRenameCancel: () => setRenamingWorkspaceId(null),
					renamingSessionId,
					onSessionRenameStart: (sessionId) => setRenamingSessionId(sessionId),
					onSessionRenameCommit: renameSession,
					onSessionRenameCancel: () => setRenamingSessionId(null),
					draggingRow: dragState !== null && dragState.kind === 'workspace' && dragState.workspaceId === workspace.workspaceId,
					workspaceDropSide:
						dropHint !== null && dropHint.kind === 'workspace' && dropHint.id === workspace.workspaceId
							? dropHint.side
							: null,
					draggingSessionId: dragState !== null && dragState.kind === 'session' ? dragState.sessionId : null,
					sessionDropHint:
						dropHint !== null && dropHint.kind === 'session' && dropHint.workspaceId === workspace.workspaceId
							? dropHint
							: null,
					onWorkspaceDragStart: (event) => startWorkspaceDrag(workspace.workspaceId, event),
					onWorkspaceDragEnd: endDrag,
					onWorkspaceDragOver: (event) => workspaceDragOver(workspace.workspaceId, event),
					onWorkspaceDrop: (event) => workspaceDrop(workspace.workspaceId, event),
					onSessionDragStart: (sessionId, event) => startSessionDrag(workspace.workspaceId, sessionId, event),
					onSessionDragEnd: endDrag,
					onSessionDragOver: (sessionId, event) => sessionDragOver(workspace.workspaceId, sessionId, event),
					onSessionDrop: (sessionId, event) => sessionDrop(workspace.workspaceId, sessionId, event)
				})
			}

			const body = []

			for (const category of state.categories) {
				const workspaces = grouped.buckets.get(category.id) || []
				// A category being dragged folds every category, leaving the header
				// list as the only thing to aim at. This fold is view-only: the local
				// state keeps the user's real `collapsed` value.
				const folded = fold === 'categories' || category.collapsed === true
				// Folded category: every workspace row (and therefore every session
				// row) is hidden, so the category row carries their combined dot.
				// Expanded: each workspace row reports only its own hidden tail.
				const categoryStatus = folded
					? summarizeStatuses(
							statuses,
							workspaces.reduce((all, workspace) => all.concat(sessionsByWorkspace.get(workspace.workspaceId) || []), [])
						)
					: null
				body.push(
					h(
						CategoryRow,
						Object.assign(
							{
								key: category.id,
								category: folded ? Object.assign({}, category, { collapsed: true }) : category,
								workspaces: workspaces.length,
								status: categoryStatus,
								dropActive: dragCategory === category.id,
								renaming: renamingId === category.id,
								busy: adding,
								dragging:
									dragState !== null && dragState.kind === 'category' && dragState.categoryId === category.id,
								dropSide:
									dropHint !== null && dropHint.kind === 'category' && dropHint.id === category.id
										? dropHint.side
										: null,
								onDragStart: (event) => startCategoryDrag(category.id, event),
								onDragEnd: endDrag,
								onToggle: () => toggleCategory(category.id),
								onRenameStart: () => setRenamingId(category.id),
								onRenameCommit: (name) => renameCategory(category.id, name),
								onRenameCancel: () => setRenamingId(null),
								onDelete: () => deleteCategory(category.id),
								onNewWorkspace: () => addWorkspace(category.id)
							},
							dropHandlers(category.id)
						),
						workspaces.length === 0
							? h('div', { className: 'twt-empty twt-empty-indent' }, '把工作区拖到这里')
							: folded
								? null
								: workspaces.map(renderWorkspace)
					)
				)
			}

			// The "未分类" bucket is a permanent drop target: it must stay visible
			// even when every workspace is filed under a category, otherwise there is
			// no place to drag a workspace back out of a category. A completely empty
			// tree (no categories, no workspaces) keeps the dedicated empty state.
			if (grouped.unassigned.length > 0 || state.categories.length > 0) {
				body.push(
					h(
						'div',
						{ key: UNASSIGNED_ID, className: cls('twt-cat-block', dragCategory === UNASSIGNED_ID && 'twt-dropping') },
						h(
							'div',
							Object.assign(
								{
									className: cls('twt-row', 'twt-cat', 'twt-cat-muted', dragCategory === UNASSIGNED_ID && 'twt-drop')
								},
								dropHandlers(UNASSIGNED_ID)
							),
							h('span', { className: 'twt-chevron' }),
							h('span', { className: 'twt-label twt-cat-label' }, '未分类'),
							h('span', { className: 'twt-count' }, String(grouped.unassigned.length)),
							h(
								'button',
								{
									type: 'button',
									className: 'twt-icon',
									title: adding ? '正在新建工作区…' : '新建工作区',
									'aria-label': '新建工作区',
									disabled: adding,
									onClick: (event) => {
										event.stopPropagation()
										addWorkspace(UNASSIGNED_ID)
									}
								},
								h(Icon, { name: 'plus' })
							)
						),
						// The pseudo-category folds with the rest while a category is
						// dragged, so the sidebar shows one flat header list.
						fold === 'categories' ? null : grouped.unassigned.map(renderWorkspace)
					)
				)
			}

			if (body.length === 0) {
				body.push(
					h(
						'div',
						{ key: 'empty', className: 'twt-empty-block' },
						h('div', { className: 'twt-empty' }, needle === '' ? '还没有工作区' : '没有匹配的工作区或会话'),
						needle === ''
							? h(
									'button',
									{
										type: 'button',
										className: 'twt-add-btn',
										disabled: adding,
										onClick: () => addWorkspace()
									},
									h(Icon, { name: 'plus', size: 12 }),
									adding ? '正在新建工作区…' : '新建工作区'
								)
							: null
					)
				)
			}

			return h(
				'div',
				{ className: 'twt-root' },
				h(
					'div',
					{ className: 'twt-header' },
					h('span', { className: 'twt-title' }, '工作区分类'),
					h(
						RowButton,
						{
							label: adding ? '正在新建工作区…' : '新建工作区',
							disabled: adding,
							onClick: () => addWorkspace()
						},
						h(Icon, { name: 'folder', size: 13 })
					),
					h(RowButton, { label: '新建分类', onClick: () => setCreating(true) }, h(Icon, { name: 'plus' }))
				),
				// While a row is dragged, the two exits live in one bar at the top of
				// the tree. They are drop targets, not buttons: the pointer travels
				// there exactly like over a row, so releasing over 取消 keeps the
				// previous order and releasing over 删除 runs the row's own delete.
				dragState === null
					? null
					: h(
							'div',
							{ className: 'twt-drag-bar', ref: dropBarRef },
							h(
								'div',
								{
									className: cls('twt-drop-zone', dropZone === 'cancel' && 'twt-drop-zone-hot'),
									title: '松手取消这次拖动，顺序保持不变',
									onDragOver: (event) => dragBarOver('cancel', event),
									onDragLeave: () => setDropZone((current) => (current === 'cancel' ? null : current)),
									onDrop: (event) => dragBarDrop('cancel', event)
								},
								'取消'
							),
							h(
								'div',
								{
									className: cls(
										'twt-drop-zone',
										'twt-drop-zone-danger',
										dropZone === 'delete' && 'twt-drop-zone-hot'
									),
									title: '松手删除：分类/工作区会先确认；会话执行归档（可撤销）',
									onDragOver: (event) => dragBarOver('delete', event),
									onDragLeave: () => setDropZone((current) => (current === 'delete' ? null : current)),
									onDrop: (event) => dragBarDrop('delete', event)
								},
								'删除'
							)
						),
				creating
					? h('input', {
							className: 'twt-input',
							autoFocus: true,
							placeholder: '分类名称，回车确认',
							onKeyDown: (event) => {
								if (event.key === 'Enter') {
									createCategory(event.currentTarget.value)
									setCreating(false)
								} else if (event.key === 'Escape') setCreating(false)
							},
							onBlur: (event) => {
								createCategory(event.target.value)
								setCreating(false)
							}
						})
					: null,
				workspaceSnapshot.phase !== 'ready' || sessionSnapshot.phase !== 'ready'
					? h('div', { className: 'twt-empty' }, '正在载入…')
					: null,
				h(
					'div',
					{ className: 'twt-search' },
					h(Icon, { name: 'search', size: 12 }),
					h('input', {
						className: 'twt-search-input',
						value: query,
						placeholder: '筛选…',
						onChange: (event) => setQuery(event.target.value)
					}),
					query === ''
						? null
						: h(
								'button',
								{ type: 'button', className: 'twt-icon', 'aria-label': '清除筛选', onClick: () => setQuery('') },
								h(Icon, { name: 'close', size: 11 })
							),
					/* A native <select> keeps its own white chrome unless the
					 * appearance is reset, which reads as a bright patch inside the
					 * sidebar. So: reset it, let the chip borrow the row's own
					 * colour, and draw the caret ourselves. */
					h(
						'span',
						{ className: cls('twt-filter', state.archivedFilter !== 'default' && 'twt-filter-on') },
						h(
							'select',
							{
								className: 'twt-filter-select',
								title: '已归档会话的显示方式',
								'aria-label': '已归档会话的显示方式',
								value: state.archivedFilter,
								onClick: (event) => event.stopPropagation(),
								onChange: (event) => updateLocal({ archivedFilter: event.target.value })
							},
							[
								h('option', { key: 'default', value: 'default' }, '隐藏归档'),
								h('option', { key: 'show', value: 'show' }, '含归档'),
								h('option', { key: 'only', value: 'only' }, '仅归档')
							]
						),
						h('span', { className: 'twt-filter-caret' }, h(Icon, { name: 'chevron', size: 9 }))
					)
				),
				error === null
					? null
					: h(
							'div',
							{ className: 'twt-error', title: error },
							h('span', { className: 'twt-error-text' }, error),
							h(
								'button',
								{
									type: 'button',
									className: 'twt-icon twt-error-close',
									'aria-label': '关闭提示',
									onClick: () => setError(null)
								},
								h(Icon, { name: 'close', size: 11 })
							)
						),
				undo === null
					? null
					: h(
							'div',
							{ className: 'twt-undo' },
							h('span', { className: 'twt-undo-text', title: undo.title }, '已归档「' + undo.title + '」'),
							h(
								'button',
								{
									type: 'button',
									className: 'twt-undo-btn',
									disabled: busySessionId !== null,
									onClick: undoArchive
								},
								'撤销'
							)
						),
				h('div', { className: 'twt-scroll', ref: scrollRef }, body),
				activeWorkspaceId === undefined
					? null
					: h('div', { className: 'twt-hint' }, '当前工作区：' + activeWorkspaceId.slice(0, 8))
			)
		}

		/* ------------------------------------------------------------------ *
		 * Styles
		 * ------------------------------------------------------------------ */

		const CSS = `
.twt-root{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;font-size:14.5px;color:inherit;line-height:1.45}
.twt-header{display:flex;align-items:center;gap:1px;padding:4px 6px 2px}
/* Drag exits: shown only while a row is dragged. "取消" keeps everything as it
 * was; "删除" reuses the row's own delete (danger coloured, dashed until hot). */
.twt-drag-bar{display:flex;gap:6px;margin:0 6px 4px;flex:0 0 auto}
.twt-drop-zone{flex:1 1 0;display:flex;align-items:center;justify-content:center;min-height:28px;border-radius:6px;border:1px dashed color-mix(in srgb,currentColor 32%,transparent);font-size:13px;opacity:.8;user-select:none;cursor:grabbing}
.twt-drop-zone-hot{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent);border-color:color-mix(in srgb,currentColor 55%,transparent)}
.twt-drop-zone-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 45%,transparent)}
.twt-drop-zone-danger.twt-drop-zone-hot{background:color-mix(in srgb,#e5484d 16%,transparent);border-color:#e5484d}
.twt-title{flex:1 1 auto;font-size:12.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;opacity:.5;overflow:hidden;white-space:nowrap}
.twt-search{display:flex;align-items:center;gap:5px;margin:2px 6px 4px;padding:3px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);opacity:.9}
.twt-search-input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px}
.twt-search-input::placeholder{color:inherit;opacity:.45}
.twt-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 4px 8px}
.twt-row{display:flex;align-items:center;gap:4px;min-height:26px;padding:2px 6px;border-radius:6px;cursor:pointer;user-select:none}
.twt-row:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-row.twt-active{background:color-mix(in srgb,currentColor 15%,transparent);font-weight:500}
.twt-row.twt-drop{background:color-mix(in srgb,currentColor 18%,transparent);outline:1px dashed color-mix(in srgb,currentColor 45%,transparent)}
/* Drag feedback: the dragged row fades, the row under the pointer shows the
 * exact insertion edge (before = top line, after = bottom line). */
.twt-dragging{opacity:.45}
.twt-row.twt-drop-before{box-shadow:inset 0 2px 0 var(--dsw-alias-state-business-primary,currentColor)}
.twt-row.twt-drop-after{box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary,currentColor)}
.twt-cat{font-weight:600;min-height:28px}
.twt-cat-muted{font-weight:500;opacity:.75}
.twt-cat-block{margin-bottom:7px}
.twt-cat-block:last-child{margin-bottom:2px}
.twt-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.twt-cat-label{letter-spacing:.01em}
.twt-ws-label{opacity:.92}
.twt-muted{opacity:.55;font-style:italic}
.twt-count{order:1;margin-left:auto;font-size:12.5px;opacity:.4;padding:0 2px;font-variant-numeric:tabular-nums}
.twt-workspace{padding:1px 0}
.twt-ws-head{min-height:25px}
.twt-ws-actions{display:none;align-items:center;gap:4px;flex:0 0 auto}
.twt-ws-head:hover .twt-ws-actions,.twt-ws-head:focus-visible .twt-ws-actions,.twt-ws-head:has(:focus-visible) .twt-ws-actions{display:flex}
.twt-ws-actions .twt-icon{opacity:.6}
@media (hover:none){.twt-ws-actions{display:flex}}
.twt-cat-actions{display:none;align-items:center;gap:4px;flex:0 0 auto}
.twt-cat:hover .twt-cat-actions,.twt-cat:focus-visible .twt-cat-actions,.twt-cat:has(:focus-visible) .twt-cat-actions{display:flex}
.twt-cat-actions.twt-cat-actions-open{display:flex}
.twt-cat-actions .twt-icon{opacity:.6}
@media (hover:none){.twt-cat-actions{display:flex}}
.twt-sessions{display:flex;flex-direction:column;gap:2px;margin:1px 0 2px 13px;padding:1px 0 2px 9px;border-left:1px solid color-mix(in srgb,currentColor 16%,transparent)}
.twt-sessions>.twt-empty{padding-left:6px}
.twt-session{min-height:24px}
.twt-session-actions{display:none;align-items:center;gap:4px;flex:0 0 auto}
.twt-session:hover .twt-session-actions,.twt-session:focus-visible .twt-session-actions,.twt-session:has(:focus-visible) .twt-session-actions{display:flex}
.twt-session-actions .twt-icon{opacity:.6}
@media (hover:none){.twt-session-actions{display:flex}}
/* Session work status: the app's own StateDot when seeded, this fallback
 * otherwise. The wrapper keeps one 12px cell so rows do not shift between the
 * spinner (ongoing) and the coloured dots (warning/done). */
.twt-status{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:12px;height:12px}
.twt-status-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}
.twt-status-dot[data-state=warning]{background:var(--dsw-alias-state-warn-primary)}
.twt-status-dot[data-state=done]{background:var(--dsw-alias-state-success-primary)}
.twt-status-dot[data-state=ongoing]{width:12px;height:12px;background:transparent;border:1.5px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:twt-spin 1s linear infinite}
.twt-chevron{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto;border:0;background:transparent;color:inherit;padding:0;opacity:.5;cursor:pointer;transition:transform .12s ease}
.twt-chevron-open{transform:translateX(1px) rotate(90deg)}
.twt-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 auto;border:0;border-radius:4px;background:transparent;color:inherit;padding:0;opacity:0;cursor:pointer}
.twt-row:hover .twt-icon,.twt-header .twt-icon{opacity:.6}
.twt-icon:hover{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}
.twt-icon:focus-visible{opacity:1}
/* Touch screens have no hover to reveal session-row actions; keep the row
 * buttons (session rename / archive) visible there, which is also what makes
 * the rename entry usable through dsh-pocket on a phone. */
@media (hover:none){.twt-icon{opacity:.6}}
.twt-filter{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;max-width:46%;min-width:0;border-radius:5px;background:transparent;transition:background .12s ease}
.twt-filter:hover,.twt-filter:focus-within{background:color-mix(in srgb,currentColor 9%,transparent)}
.twt-filter-select{max-width:100%;min-width:0;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:1px 11px 1px 4px;outline:0;opacity:.6;cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis}
.twt-filter:hover .twt-filter-select,.twt-filter-select:focus{opacity:.95}
.twt-filter-on .twt-filter-select{opacity:.95;font-weight:600}
.twt-filter-caret{position:absolute;right:3px;top:50%;display:inline-flex;transform:translateY(-50%) rotate(90deg);opacity:.4;pointer-events:none}
.twt-filter-select option{color:CanvasText;background:Canvas}
.twt-archived{opacity:.62}
.twt-archived .twt-label{font-style:italic}
.twt-undo{display:flex;align-items:center;gap:6px;margin:2px 6px 4px;padding:4px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:13px}
.twt-undo-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.twt-undo-btn{flex:0 0 auto;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:600;padding:1px 6px;cursor:pointer;opacity:.85}
.twt-undo-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 16%,transparent);opacity:1}
.twt-undo-btn:disabled{opacity:.4;cursor:default}
.twt-more{align-self:flex-start;text-align:left;margin:2px 0 1px 18px;border:0;background:transparent;color:inherit;opacity:.55;font:inherit;font-size:13.5px;padding:1px 4px;border-radius:4px;cursor:pointer}
.twt-more:hover{opacity:.9;background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-empty{padding:6px 10px;font-size:13.5px;opacity:.45}
.twt-empty-block{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.twt-add-btn{display:inline-flex;align-items:center;gap:5px;margin:0 8px 4px;padding:3px 8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13.5px;cursor:pointer;opacity:.75}
.twt-add-btn:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-add-btn:disabled{cursor:default;opacity:.45}
.twt-error{display:flex;align-items:flex-start;gap:4px;margin:2px 6px 4px;padding:4px 6px;border-radius:6px;background:color-mix(in srgb,#e5484d 16%,transparent);color:inherit;font-size:13px}
.twt-error-text{flex:1 1 auto;min-width:0;word-break:break-word;line-height:1.35}
.twt-error-close{opacity:.6;width:16px;height:16px}
.twt-error-close:hover{opacity:1}
@keyframes twt-spin{to{transform:rotate(360deg)}}
.twt-empty-indent{padding-left:22px}
.twt-input{margin:2px 6px 4px;padding:3px 7px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:14px;outline:0}
.twt-input-inline{flex:1 1 auto;min-width:0;margin:0;padding:0 3px;border-radius:4px;font-weight:600}
.twt-session-input{font-weight:400;padding:0 2px}
.twt-hint{padding:2px 8px 4px;font-size:12.5px;opacity:.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.twt-narrow{align-items:center;gap:2px;padding:4px 0}
.twt-rail{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:inherit;opacity:.65;cursor:pointer}
.twt-rail:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}
.twt-svg{display:block}
`

		function ensureStyles() {
			const existing = document.getElementById(STYLE_ID)
			if (existing !== null) {
				// A replaced client bundle can reuse the id in a page that already
				// has the previous stylesheet; keep the sheet in sync so new rules
				// (and removed ones) take effect without a full page reload.
				if (existing.textContent !== CSS) existing.textContent = CSS
				return
			}
			const element = document.createElement('style')
			element.id = STYLE_ID
			element.textContent = CSS
			document.head.appendChild(element)
		}

		/* ------------------------------------------------------------------ *
		 * Opening sessions
		 * ------------------------------------------------------------------ */

		/**
		 * Pick one absolute directory to adopt, preferring the composed in-app
		 * dialog and degrading to the official native chooser.
		 *
		 * 1. `workspaceDefaultDirectory` — provided by the optional companion
		 *    directory plugin, which owns the composed official in-app "Select
		 *    Workspace Directory" dialog (seeded with its configured default
		 *    directory). That is the flow this fork is normally used with.
		 * 2. The Electron shell's injected `__DSH_DIRECTORY_PICKER__` bridge, then
		 *    `uiWorkspace.pickDirectory()` (which fronts `remote.directoryPicker`) —
		 *    the exact preference order the official `dsh-client-ui-directory-picker-native`
		 *    plugin uses. This keeps a plain DSH install usable even when the
		 *    companion plugin is not installed.
		 *
		 * Resolves an absolute path, or null when the user cancels.
		 *
		 * @param ctx - client root context.
		 * @returns Promise<string | null> absolute path, or null on cancel.
		 */
		function pickDirectory(ctx) {
			const picker = ctx.get('workspaceDefaultDirectory')
			if (picker !== undefined && picker !== null && typeof picker.pick === 'function') {
				return Promise.resolve(picker.pick())
			}
			const desktop = typeof globalThis === 'undefined' ? undefined : globalThis.__DSH_DIRECTORY_PICKER__
			if (desktop !== undefined && desktop !== null && typeof desktop.pick === 'function') {
				return Promise.resolve(desktop.pick())
			}
			const uiWorkspace = ctx.get('uiWorkspace')
			if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.pickDirectory === 'function') {
				return Promise.resolve(uiWorkspace.pickDirectory())
			}
			return Promise.reject(new Error('没有可用的目录选择器（workspaceDefaultDirectory / 桌面桥 / uiWorkspace 都不可用）'))
		}

		/**
		 * The workspaces controller, or a clear error when the core UI is absent.
		 * Archiving is a controller command (it installs the returned archive set
		 * into the snapshot store), not a plain snapshot read.
		 *
		 * @param ctx - client root context.
		 * @returns the workspaces controller.
		 */
		function requireWorkspaces(ctx) {
			const workspaces = ctx.get('workspaces')
			if (workspaces === undefined || workspaces === null || typeof workspaces.archiveSession !== 'function') {
				throw new Error('workspaces 服务不可用')
			}
			return workspaces
		}

		/**
		 * `uiWorkspace` owns the main-view swap. When it is unavailable we
		 * reproduce its essential effect: retain the target under `mainView`
		 * (which is what the layout renders) and reveal the main panel.
		 */
		function createNavigator(ctx) {
			let mainReference

			const fallbackOpen = (sessionId) => {
				const sessions = ctx.get('sessions')
				const reference = sessions.retain(sessionId, { source: 'mainView' })
				const previous = mainReference
				mainReference = reference
				if (previous !== undefined) previous.release()
				const layout = ctx.get('layout')
				if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
			}

			return {
				openSession(sessionId) {
					const uiWorkspace = ctx.get('uiWorkspace')
					if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
						uiWorkspace.openSession(sessionId)
						return
					}
					fallbackOpen(sessionId)
				},
				startSession(workspaceId) {
					const uiWorkspace = ctx.get('uiWorkspace')
					if (uiWorkspace !== undefined && typeof uiWorkspace.startSession === 'function') {
						uiWorkspace.startSession(workspaceId)
						return
					}
					const sessions = ctx.get('sessions')
					Promise.resolve(sessions.create({ workspaceId }))
						.then((sessionId) => fallbackOpen(sessionId))
						.catch((error) => console.error('[workspace-tree] new session failed', error))
				},
				/**
				 * Archive one session. `options.stopActivity` is the "stop and
				 * archive" answer to a `workspace/session-active` refusal; without
				 * it the Host refuses rather than killing live work.
				 */
				archiveSession(sessionId, options) {
					return requireWorkspaces(ctx).archiveSession(sessionId, options)
				},
				unarchiveSession(sessionId) {
					return requireWorkspaces(ctx).unarchiveSession(sessionId)
				},
				/**
				 * Delete one workspace registration. The Host keeps the directory
				 * and the Session logs; only the workspace row leaves the client
				 * snapshot.
				 *
				 * @param workspaceId - workspace to delete.
				 * @returns Promise<WorkspaceDeleteValue>
				 */
				deleteWorkspace(workspaceId) {
					const workspaces = ctx.get('workspaces')
					if (workspaces === undefined || typeof workspaces.delete !== 'function') {
						throw new Error('workspaces 服务不支持删除工作区')
					}
					return workspaces.delete(workspaceId)
				},
				/**
				 * Rename one workspace; the client model merges the returned
				 * Workspace row into the snapshot, so the tree re-renders with the
				 * new title.
				 *
				 * @param workspaceId - workspace to rename.
				 * @param title - new non-blank title.
				 * @returns Promise<WorkspaceView>
				 */
				renameWorkspace(workspaceId, title) {
					const workspaces = ctx.get('workspaces')
					if (workspaces === undefined || typeof workspaces.rename !== 'function') {
						throw new Error('workspaces 服务不支持重命名工作区')
					}
					return workspaces.rename(workspaceId, title)
				},
				/**
				 * Move one workspace inside the Host registry order. The workspaces
				 * client service follows the Host order, so the same order reaches the
				 * desktop and a `dsh-pocket` phone without this plugin storing a copy.
				 *
				 * @param workspaceId - workspace to move.
				 * @param beforeWorkspaceId - anchor workspace; omitted appends.
				 * @returns Promise<void>
				 */
				insertWorkspaceBefore(workspaceId, beforeWorkspaceId) {
					const workspaces = ctx.get('workspaces')
					if (workspaces === undefined || typeof workspaces.insertBefore !== 'function') {
						throw new Error('workspaces 服务不支持工作区排序')
					}
					return workspaces.insertBefore(workspaceId, beforeWorkspaceId)
				},
				/**
				 * Rename one Session through the generated `session/rename` Remote,
				 * the same Host contract the built-in UI uses for a user-owned title
				 * (the `sessions` service's public face deliberately exposes only
				 * catalog reads and navigation, and its object layer would have to
				 * open the Session just to reach this call).
				 *
				 * Every request rides the Connection's authenticated `/api` carrier,
				 * so `dsh-pocket`'s reverse proxy forwards it unchanged — the phone
				 * calls the same Host route as the desktop. The title is durable in
				 * the Session log; the client list is refreshed so this page stops
				 * relying on its accepted-title cache.
				 *
				 * @param sessionId - Session to rename.
				 * @param title - raw title text; the Host normalizes it.
				 * @returns Promise<{ title: string, seq: number }> the accepted title.
				 */
				renameSession(sessionId, title) {
					// The generated namespace is its own Cordis service
					// (`remote.session`); the root `remote` service also forwards
					// dotted names, so accept either shape.
					let sessionRemote = ctx.get('remote.session')
					if (sessionRemote === undefined) {
						const remote = ctx.get('remote')
						sessionRemote = remote === undefined ? undefined : remote.session
					}
					if (sessionRemote === undefined || sessionRemote === null || typeof sessionRemote.rename !== 'function') {
						return Promise.reject(new Error('会话重命名服务不可用（Host 未挂载 session/title）'))
					}
					return Promise.resolve(sessionRemote.rename({ sessionId, title })).then((result) => {
						if (result === undefined || result === null || result.ok !== true) {
							const error = result !== undefined && result !== null ? result.error : undefined
							const message =
								error !== undefined && error !== null && typeof error.message === 'string' && error.message !== ''
									? error.message
									: 'Host 拒绝了重命名请求'
							throw new Error(message)
						}
						// The list hint for a cold Session does not update from the
						// rename alone; pull the list so the snapshot (and any other
						// reader of this row) converges. Failure here is cosmetic.
						const sessions = ctx.get('sessions')
						if (sessions !== undefined && sessions !== null && typeof sessions.refresh === 'function') {
							Promise.resolve(sessions.refresh()).catch((reason) => {
								console.warn('[workspace-tree] session list refresh after rename failed', reason)
							})
						}
						return result.value
					})
				},
				/**
				 * The official "add workspace" flow, start to finish: pick a directory
				 * through the `workspaceDefaultDirectory` service (which owns the
				 * composed official in-app dialog seeded with the configured default
				 * directory), then adopt it. `workspaces.create({ path })` resolves an
				 * existing absolute path into a Workspace row and the client model
				 * merges that row into the snapshot immediately, so our tree re-renders
				 * without a reload.
				 *
				 * @returns Promise<Workspace | null> null when the user cancels.
				 */
				createWorkspace() {
					return pickDirectory(ctx).then((path) => {
						if (path === null || path === undefined || path === '') return null
						const workspaces = ctx.get('workspaces')
						if (workspaces === undefined || typeof workspaces.create !== 'function') {
							throw new Error('workspaces 服务不可用')
						}
						return workspaces.create({ path })
					})
				}
			}
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		/** Only `slots` is required: everything else is resolved lazily. */
		const inject = ['slots']

		function apply(ctx) {
			ensureStyles()

			const navigator = createNavigator(ctx)
			// Status dots read the Session UI status through their own
			// `useSyncExternalStore` source; the service is resolved lazily, so a
			// tree that mounts first still upgrades once the session UI is live.
			const sessionStatusSource = createSessionStatusSource(ctx)

			// The tree mounts before (or without) the Host half being reachable:
			// the page paints from the localStorage mirror immediately, and the
			// sync engine adopts the Host document as soon as it answers.
			startSync()
			ctx.effect(() => () => stopSync())

			// Session titles live in each Session's Host log, so a rename made on
			// another device only reaches this page when the Session list is
			// re-read. Re-read it when the page comes back to the foreground (the
			// usual dsh-pocket phone flow: rename on the desktop, pick the phone
			// up), throttled so ordinary focus changes cost nothing.
			const SESSION_REFRESH_MS = 30000
			let lastSessionRefresh = 0
			const refreshSessionList = () => {
				const now = Date.now()
				if (now - lastSessionRefresh < SESSION_REFRESH_MS) return
				lastSessionRefresh = now
				const sessions = ctx.get('sessions')
				if (sessions === undefined || sessions === null || typeof sessions.refresh !== 'function') return
				Promise.resolve(sessions.refresh()).catch((reason) => {
					console.warn('[workspace-tree] session list refresh failed', reason)
				})
			}
			const foregroundRefresh = () => {
				if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
				refreshSessionList()
			}
			window.addEventListener('focus', foregroundRefresh)
			document.addEventListener('visibilitychange', foregroundRefresh)
			ctx.effect(() => () => {
				window.removeEventListener('focus', foregroundRefresh)
				document.removeEventListener('visibilitychange', foregroundRefresh)
			})

			const injectedProps = () =>
				Object.assign(coreStores(ctx), {
					sessionStatusSource,
					openSession: navigator.openSession,
					startSession: navigator.startSession,
					createWorkspace: navigator.createWorkspace,
					archiveSession: navigator.archiveSession,
					unarchiveSession: navigator.unarchiveSession,
					deleteWorkspace: navigator.deleteWorkspace,
					renameWorkspace: navigator.renameWorkspace,
					insertWorkspaceBefore: navigator.insertWorkspaceBefore,
					renameSession: navigator.renameSession
				})

			// `sidebar.workspaces` is a single slot: our -100 entry shadows
			// ui-workspace's default 0 entry, and disposing it restores it. The tree
			// is the only browser this plugin shows — there is no view toggle, no
			// footer switch and no top-bar "back to native list" action.
			ctx.slots.inject('sidebar.workspaces', () =>
				ctx.slots.register(
					{
						name: 'sidebar.workspaces',
						priority: -100,
						registrant: 'dsh-mahiros-workspace-categories',
						inject: injectedProps
					},
					WorkspaceTree
				)
			)
		}

		exports.apply = apply
		exports.inject = inject
		/**
		 * Model surface pinned by `test/client-model.test.js`. The browser bundle
		 * cannot import the Host module, so the two copies of the model are
		 * compared through this property; nothing in the plugin reads it.
		 */
		exports.__syncModel = {
			STORAGE_KEY,
			LEGACY_STORAGE_KEY,
			SYNC_PATH,
			sanitizeShared,
			sanitizeLocal,
			applySharedOps,
			getViewState,
			getSharedState: () => ({
				rev: sharedState.rev,
				categories: sharedState.categories,
				assign: sharedState.assign,
				sessionOrder: sharedState.sessionOrder
			}),
			getPendingOps: () => pendingOps.slice(),
			getSyncStatus: () => sync.status,
			mutateShared,
			updateLocal,
			adoptRemote,
			flushOps,
			bootstrapSync,
			startSync,
			stopSync,
			// Work-status model and the tree component, so the tests can drive the
			// real aggregation rules and the real row wiring in a fake React.
			sessionStatusView,
			summarizeStatuses,
			WorkspaceTree,
			// The real session row and the navigator factory, so the tests can drive
			// the inline rename wiring and the `session/rename` Remote adapter.
			SessionRow,
			createNavigator,
			// Ordering and drag-insertion rule, exported as pure functions so the
			// drop semantics are tested without a DOM.
			sessionsOf,
			orderSessionRows,
			resolveReorder,
			// Drag presentation: the fold each drag level applies and the edge
			// autoscroll curve, exported so both are tested without a DOM.
			dragFoldOf,
			autoScrollStep,
			// Empty-Session cleanup rule, exported so the keep/remove policy is
			// tested without walking the rendered tree.
			isEmptySession,
			composerDraftHasContent,
			draftHasContent,
			// Snapshot stores that keep the slot mounted in a composition where
			// the core controllers are absent; exported so the degradation is tested.
			coreStores
		}
		return module.exports
	}
})
