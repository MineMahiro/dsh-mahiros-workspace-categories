/**
 * Shared harness for the client-half tests.
 *
 * The client bundle is a `window.__ModuleLoader__` factory the browser loads,
 * so there is no module to import. These helpers evaluate the real bundle in a
 * small VM with fake `window`/`document`/`react`, so tests can drive the
 * exposed `__syncModel` and the real tree component headlessly. Callers may
 * inject their own React stand-in (`react`) and window members (`window`) to
 * render statefully or to observe drag listeners.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * Minimal React stand-in: enough to evaluate the real tree component
 * headlessly. Hooks run synchronously against the module state the component
 * reads (the outer harness only ever renders one snapshot), so element trees
 * can be walked to assert which rows show a status mark.
 */
export const fakeReact = {
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

export function memoryStorage(entries) {
	const map = new Map(Object.entries(entries ?? {}))
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
		has: (key) => map.has(key),
		entries: () => Object.fromEntries(map)
	}
}

/**
 * Evaluate one fresh copy of the bundle, as a page load would.
 *
 * @param options - `storage` mirror, `fetch`, `globals` (extra VM globals, for
 *   example a desktop bridge), `window` (extra window members, merged over the
 *   defaults) and `react` (the React stand-in to inject).
 * @returns the factory exports, its `__syncModel`, the storage mirror, the
 *   console warnings and the VM sandbox.
 */
export function loadBundle(options = {}) {
	const storage = options.storage ?? memoryStorage()
	const warnings = []
	let captured
	const win = Object.assign(
		{
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
		options.window ?? {}
	)
	const sandbox = Object.assign(
		{
			console: {
				log: () => {},
				error: () => {},
				warn: (...args) => warnings.push(args)
			},
			window: win,
			document: {
				visibilityState: 'visible',
				getElementById: () => null,
				createElement: () => ({ style: {}, textContent: '' }),
				head: { appendChild: () => {} },
				addEventListener: () => {},
				removeEventListener: () => {}
			}
		},
		options.globals ?? {}
	)
	sandbox.window.__ModuleLoader__ = { load: (spec) => (captured = spec) }
	vm.createContext(sandbox)
	vm.runInContext(source, sandbox, { filename: 'client.js' })
	const react = options.react ?? fakeReact
	const exports = captured.factory((name) => {
		if (name === 'react') return react
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: undefined }
		throw new Error(`unexpected require: ${name}`)
	})
	return { exports, model: exports.__syncModel, storage, warnings, sandbox, window: sandbox.window }
}
