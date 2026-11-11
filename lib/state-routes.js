/**
 * HTTP surface for the shared category state.
 *
 * The route rides Connection's authenticated `/api` channel, so it is not a
 * new unauthenticated door: the browser session cookie (the one every RPC and
 * bundle fetch already needs) is the same credential here, and only the owner
 * Peer reaches an exact Fetch route. That also makes it work through
 * `dsh-pocket` unchanged — the pocket proxy forwards the DSH session cookie
 * and the request body to the loopback Host, so the phone's `/api/...` call is
 * authenticated exactly like the desktop browser's.
 *
 * GET  /api/workspace-categories.state[?since=<rev>]
 *   → 200 { rev, categories, assign, sessionOrder, changed }
 * POST /api/workspace-categories.state
 *   { "ops": [ { "type": "category.add", ... }, { "type": "session.order", ... }, ... ] }
 *   { "replace": { "categories": [...], "assign": {...}, "sessionOrder": {...} } }   (only while rev === 0)
 *   → 200 { rev, categories, assign, sessionOrder, applied }
 *       | { rev, categories, assign, sessionOrder, changed }
 *
 * The browser half hardcodes this same path; `test/host-state.test.js` pins it
 * so the two cannot drift.
 *
 * @module dsh-mahiros-workspace-categories/state-routes
 */

import { MAX_OPS, validateOps } from './state-store.js'

/** Exact Fetch route inside Connection's `/api` channel. */
export const STATE_ROUTE_PATH = '/api/workspace-categories.state'

/** Upper bound for one request body; a category list is tiny. */
const MAX_BODY_BYTES = 256 * 1024

function json(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store'
		}
	})
}

function failure(error, status) {
	return json({ error, message: status === 500 ? 'internal-error' : error }, status)
}

/**
 * Build the Fetch handler for `STATE_ROUTE_PATH`.
 *
 * @param {object} store - the shared-state document created by
 *   `createStateStore()` in `state-store.js`.
 * @returns {(request: Request) => Promise<Response>}
 */
export function createStateRouteHandler(store) {
	return async function handleStateRequest(request) {
		const url = new URL(request.url, 'http://workspace-categories.invalid')

		if (request.method === 'GET' || request.method === 'HEAD') {
			const rawSince = url.searchParams.get('since')
			const since = rawSince !== null && /^\d+$/.test(rawSince) ? Number(rawSince) : null
			try {
				const snapshot = await store.read(since)
				return json(snapshot)
			} catch (error) {
				return failure('internal-error', 500)
			}
		}

		if (request.method !== 'POST') return failure('method-not-allowed', 405)

		const contentType = String(request.headers.get('content-type') ?? '').toLowerCase()
		if (!contentType.includes('application/json')) return failure('unsupported-media-type', 415)
		const declaredLength = Number(request.headers.get('content-length') ?? '0')
		if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return failure('body-too-large', 413)

		let body
		try {
			const text = await request.text()
			if (text.length > MAX_BODY_BYTES) return failure('body-too-large', 413)
			body = JSON.parse(text)
		} catch (error) {
			return failure('malformed-json', 400)
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) return failure('malformed-body', 400)

		try {
			if (body.replace !== undefined) {
				if (body.replace === null || typeof body.replace !== 'object') return failure('malformed-replace', 400)
				return json(await store.replace(body.replace))
			}
			if (body.ops === undefined) return failure('missing-ops', 400)
			if (Array.isArray(body.ops) && body.ops.length > MAX_OPS) return failure('too-many-ops', 400)
			const verdict = validateOps(body.ops)
			if (verdict !== null) return failure('bad-ops', 400)
			return json(await store.apply(body.ops))
		} catch (error) {
			if (error !== null && typeof error === 'object' && error.code === 'not-empty') {
				return failure('already-initialized', 409)
			}
			if (error !== null && typeof error === 'object' && error.code === 'bad-ops') {
				return failure('bad-ops', 400)
			}
			return failure('internal-error', 500)
		}
	}
}
