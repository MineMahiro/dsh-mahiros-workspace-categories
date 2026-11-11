/**
 * Repository guard for a publishable fork.
 *
 * These tests do not exercise plugin behavior; they pin down the facts a public
 * GitHub release must keep true:
 *
 *   - the package name, the client bundle id, the Host entry name and the
 *     Cordis patch row all agree, so the plugin resolves after any rename;
 *   - no published file contains a path or address that only works on the
 *     author's machine (portability);
 *   - the Cordis patch row id is fork-specific and its `disabled` guard covers
 *     the upstream package name (no duplicate `sidebar.workspaces` entry when
 *     both plugins happen to be installed);
 *   - the MIT license keeps the upstream copyright and NOTICE names the base
 *     project (attribution);
 *   - the two READMEs stay short, structural mirrors of each other, and their
 *     install command keeps pointing at this version's release asset.
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { name as hostName } from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

const pkg = JSON.parse(await read('package.json'))
const patch = await read('cordis.patch.yml')
const client = await read('lib/client.js')
const license = await read('LICENSE')
const notice = await read('NOTICE')

/** Both human-facing READMEs; the English one mirrors the Chinese structure. */
const READMES = ['README.md', 'README.en.md']

const PUBLISHED_FILES = [
	'package.json',
	'cordis.patch.yml',
	'icon.svg',
	'lib/index.js',
	'lib/client.js',
	'lib/state-store.js',
	'lib/state-routes.js',
	'locale/zh.json',
	'locale/en.json'
]

/** Fragments that would tie a published file to one machine or deployment. */
const MACHINE_SPECIFIC = [
	['POSIX home directory', /\/home\/[a-z]/i],
	['WSL drive mount', /\/mnt\/[a-f]\//i],
	['Windows user directory', /[A-Za-z]:\\Users/],
	['loopback address', /127\.0\.0\.1|localhost:\d+/],
	['development port', /:30[0-9]{2}\b/]
]

/** Headings of one level and the TOC anchors they must resolve to. */
const headings = (text, level) =>
	[...text.matchAll(new RegExp(`^#{${level}} (.+)$`, 'gm'))].map((match) => match[1])
const tocAnchors = (text) => [...text.matchAll(/^- \[.+?\]\(#(.+?)\)$/gm)].map((match) => match[1])
const slug = (heading) =>
	heading
		.trim()
		.toLowerCase()
		.replace(/`/g, '')
		.replace(/[^\p{L}\p{N}\- ]/gu, '')
		.replace(/ /g, '-')

test('the package name, bundle id, Host entry and patch row agree', async () => {
	assert.equal(pkg.name, 'dsh-mahiros-workspace-categories')
	assert.equal(hostName, pkg.name)
	assert.match(client, new RegExp(`id: '${pkg.name}'`))
	assert.match(patch, new RegExp(`name: '${pkg.name}'`))
	assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
	assert.equal(pkg.dsh.client.platform, 'web')
	assert.equal(pkg.dsh.manifestVersion, 1)
	assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
	for (const injected of pkg.dsh.client.inject) assert.match(injected, /^@deepseek-ai\//)
})

test('the compatibility window is capped, and peers only name packages the plugin really uses', () => {
	// app-boot throws when a bundle's engines.dsh does not match, so an open-ended
	// range would promise versions nobody verified.
	assert.match(pkg.engines.dsh, /^>=0\.2\.0-rc\.2 </)
	assert.match(pkg.engines.dsh, /<0\.2\.3-0/)
	assert.match(pkg.engines.node, />=20/)

	// `dsh-client-ui-slots` is only a shell-seeded external and is never imported
	// by this plugin; `dsh-client-ui-primitives` is the one real (guarded) require.
	assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-slots'], undefined)
	for (const [name, range] of Object.entries(pkg.peerDependencies)) {
		if (name === '@deepseek-ai/cordis') continue
		assert.match(range, /^>=0\.2\.0-rc\.2 </, `${name} stays inside the verified window`)
		assert.match(range, /<0\.3\.0-0$/)
	}
	assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-client-ui-primitives'].optional, true)
})

test('the published file set exists and needs no build step', async () => {
	assert.equal(pkg.type, 'module')
	assert.equal(pkg.main, 'lib/index.js')
	assert.equal(pkg.license, 'MIT')
	assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies expected')
	for (const entry of pkg.files) {
		const info = await stat(join(root, entry))
		assert.ok(info.isFile() || info.isDirectory(), `missing published file: ${entry}`)
	}
	for (const relative of PUBLISHED_FILES) {
		const info = await stat(join(root, relative))
		assert.ok(info.isFile(), `missing published file: ${relative}`)
	}
})

test('no published file leaks a machine-specific path or address', async () => {
	for (const relative of [...PUBLISHED_FILES, ...READMES, 'AGENTS.md', 'NOTICE', 'LICENSE']) {
		const content = await read(relative)
		for (const [label, pattern] of MACHINE_SPECIFIC) {
			assert.doesNotMatch(content, pattern, `${relative} contains a ${label}`)
		}
	}
})

test('the Cordis patch row is fork-specific and steps aside for the upstream plugin', async () => {
	const rowId = patch.match(/^\s*- id: (\S+)$/m)?.[1]
	assert.ok(rowId, 'patch inserts one row id')
	assert.notEqual(rowId, 'workspace-tree', 'the upstream bundle owns the `workspace-tree` row id')
	assert.match(patch, new RegExp(`id: ${rowId}[\\s\\S]*disabled: !!js`))
	// Both packages register `sidebar.workspaces` at priority -100: the guard
	// must recognize the upstream package name as well as our own.
	assert.match(patch, /e\.options\.name === 'dsh-workspace-categories'/)
	assert.match(patch, /e\.options\.name === 'dsh-mahiros-workspace-categories'/)
	assert.ok((patch.match(/e\.options\.name === /g) ?? []).length >= 2)
})

test('the license keeps the upstream MIT notice and NOTICE names the fork base', () => {
	assert.match(license, /^MIT License/)
	assert.match(license, /Copyright \(c\) 2026 knight/)
	assert.match(license, /Copyright \(c\) 2026 MineMahiro/)
	assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/)

	assert.match(notice, /https:\/\/github\.com\/Knight-Zjy\/dsh-workspace-categories/)
	assert.match(notice, /MIT/i)
})

const README_SECTIONS = {
	'README.md': { quickStart: /^## 快速开始$/m, compatibility: /^## 兼容性$/m, license: /^## 许可声明$/m },
	'README.en.md': { quickStart: /^## Quick start$/m, compatibility: /^## Compatibility$/m, license: /^## License$/m }
}

test('the READMEs stay human-facing and ship the install and compatibility notes', async () => {
	for (const relative of READMES) {
		const text = await read(relative)
		assert.match(text, /^# dsh-mahiros-workspace-categories$/m, `${relative} starts with the repo name`)
		assert.match(text, README_SECTIONS[relative].quickStart, `${relative} opens with a quick start`)
		assert.match(text, README_SECTIONS[relative].compatibility, `${relative} states compatibility`)
		assert.match(text, README_SECTIONS[relative].license, `${relative} states the license`)
		assert.match(text, /0\.2\.0-rc\.2/, `${relative} states the minimum DSH version`)
		assert.match(text, /dsh plugin --profile/, `${relative} shows the install command`)
		assert.match(text, /docs\/COMPATIBILITY\.md/, `${relative} links the compatibility notes`)
		assert.ok(text.split('\n').length <= 220, `${relative} stays short`)
	}
})

test('the README install command points at this version’s release asset', async () => {
	const asset = `${pkg.name}-${pkg.version}.tgz`
	for (const relative of READMES) {
		const text = await read(relative)
		assert.ok(text.includes(`/releases/download/v${pkg.version}/`), `${relative} links the v${pkg.version} release`)
		assert.ok(text.includes(asset), `${relative} names ${asset}`)
	}
})

test('the English README mirrors the Chinese one', async () => {
	const zh = await read('README.md')
	const en = await read('README.en.md')
	for (const level of [2, 3]) {
		assert.equal(
			headings(en, level).length,
			headings(zh, level).length,
			`the English README keeps the same number of H${level} headings`
		)
	}
	assert.match(zh, /\[English\]\(\.\/README\.en\.md\)/, 'the Chinese README links its English mirror')
	assert.match(en, /\[中文\]\(\.\/README\.md\)/, 'the English README links the Chinese original')
	for (const [relative, text] of [
		['README.md', zh],
		['README.en.md', en]
	]) {
		const anchors = tocAnchors(text)
		assert.ok(anchors.length >= 8, `${relative} ships a table of contents`)
		const known = new Set(headings(text, 2).map(slug))
		for (const anchor of anchors) assert.ok(known.has(anchor), `${relative} TOC anchor #${anchor} has a heading`)
	}
})

test('the locale catalogues stay small, valid and non-empty', async () => {
	for (const locale of ['zh', 'en']) {
		const catalogue = JSON.parse(await read(`locale/${locale}.json`))
		assert.equal(typeof catalogue.meta.title, 'string')
		assert.ok(catalogue.meta.title.length > 0)
		assert.equal(typeof catalogue.meta.description, 'string')
		assert.ok(catalogue.meta.description.length > 0)
	}
})
