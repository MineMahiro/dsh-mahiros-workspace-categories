/**
 * Host loader entry for the workspace-tree plugin.
 *
 * The product lives in the browser, but categories cannot: `localStorage` is
 * scoped to one browser origin, and the phone reaches this same Host through a
 * different origin (the `dsh-pocket` proxy), which is why the phone used to
 * show every workspace as 未分类. So the Host half owns the shared document
 * (`$DSH_HOME/workspace-categories/state.json`) and serves it over Connection's
 * authenticated `/api` channel; the client half reads and writes it there and
 * falls back to `localStorage` when this half is not loaded (older Host or a
 * client-only deployment).
 *
 * Only the *account* part is shared: category rows and the workspace →
 * category map. Per-device presentation state (folded categories, expanded
 * workspaces, "show archived" filter) deliberately stays in `localStorage` —
 * a phone with a narrow screen should not uncollapse the desktop tree.
 *
 * @module dsh-mahiros-workspace-categories
 */

import { createStateRouteHandler, STATE_ROUTE_PATH } from './state-routes.js'
import { createStateStore } from './state-store.js'

export const name = 'dsh-mahiros-workspace-categories'

/**
 * Mount the shared-state route once the Host transport is available.
 *
 * `connection` only exists in browser-facing Hosts; a non-Web composition
 * simply has no route to register, and the client half degrades to local
 * storage there.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function apply(ctx) {
	ctx.inject(['connection'], (hostCtx) => {
		hostCtx.effect(() => {
			const store = createStateStore({ logger: hostCtx.logger })
			const handler = createStateRouteHandler(store)
			return hostCtx.connection.fetch.register({
				path: STATE_ROUTE_PATH,
				methods: ['GET', 'POST'],
				requestBody: 'buffered',
				fetch: handler
			})
		}, 'dsh-mahiros-workspace-categories: shared state route')
	})
}
