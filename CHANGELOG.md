# Changelog

## Unreleased

### Documentation

- **README rewritten for users**: `README.md` now follows the repo's
  `github-readme` skill structure (status, quick start with the release asset,
  other install routes, notes, features, dragging, shared state, known
  limitations, FAQ, compatibility, repository layout, roadmap, disclaimer,
  license).
- **English mirror**: `README.en.md` mirrors the Chinese README heading for
  heading and is shipped in the package; `test/package.test.js` now pins the
  mirror structure, the table-of-contents anchors and the release-asset version
  in both READMEs.

## 0.8.3 — 2026-11-12

### Fixed

- **Drag cancelling immediately on Windows**: Chrome aborts a native drag whose
  `dragstart` handler mutates the DOM — `dragend` fires a few pixels later and
  no `drop` ever follows, so workspace and session rows could not be dragged at
  all (categories only sometimes). `dragstart` now records the drag payload and
  schedules the fold / drop bar on the next task (`armDrag` + `setTimeout(0)`),
  cancelled by token when the drag ends first.
- **Drops released right after entering a row**: rows and drop-bar zones now
  also cancel `dragenter`, so a fast release still lands even when no
  `dragover` reached the freshly entered target.
- `test/drag.test.js`: fake timers, plus regression tests pinning that
  `dragstart` itself leaves the tree untouched and that an early `dragend`
  discards a stale arming; 86 tests pass on Node 20 and 24.

## 0.8.2 — 2026-11-11

### Added

- **Drag drop bar**: while any row is dragged, a bar at the top of the tree
  offers two drop exits. Dropping on 取消 ends the drag with no change at all
  (the previous order stays exactly as it was); dropping on 删除 runs the row's
  existing destructive action — `deleteCategory` / `deleteWorkspace` with their
  confirmation, and `archiveSession` for sessions (DSH has no delete-session
  API; the existing undo strip covers it). Both zones reuse the row handlers
  rather than re-implementing the operations, and the bar is only rendered
  while a drag is live, so hovering it never triggers edge autoscroll.
- `test/drag.test.js`: four more cases for the bar (visibility, cancel keeping
  the order, delete for each row kind); 84 tests pass on Node 20 and 24.

## 0.8.1 — 2026-11-11

### Added

- **Drag assist — automatic folding**: while a row is dragged the tree folds
  everything below its level, so only peers are on screen — a category drag
  folds every workspace away, a workspace drag folds every session away, and a
  session drag (the deepest level) folds nothing. The fold is derived from the
  live drag object and never written to the saved state, so drop, cancel and a
  lost `dragend` all restore the previous open/closed layout.
- **Drag assist — edge autoscroll**: holding a dragged row in the top or bottom
  band of the list scrolls it, with the speed ramping towards the edge, so rows
  outside the viewport stay reachable. The frame loop stops on drop/cancel, when
  the pointer leaves the list or the window, and once the list cannot move.

### Changed

- `test-harness/bundle.js`: the VM/React harness shared by the client tests,
  plus `test/drag.test.js` (drag folds, fold restoration, edge autoscroll) with
  a stateful React stand-in so the real row handlers are exercised.

## 0.8.0 — 2026-11-11

First public release of the fork, as **`dsh-mahiros-workspace-categories`**.

### Added

- **Cross-device shared state**: categories, workspace assignments and manual
  session order are owned by the Host
  (`$DSH_HOME/workspace-categories/state.json`) and served over the
  authenticated `/api/workspace-categories.state` route; desktop and
  `dsh-pocket` show the same tree.
- **Host half** (`lib/index.js`, `lib/state-store.js`, `lib/state-routes.js`)
  with operation batches, `rev` polling and corruption-safe atomic writes.
- **Work status aggregation**: session status dots (`运行中` / `等待处理` /
  `已完成`) are summarized into folded workspace and category rows.
- **Empty-Session cleanup**: blank sessions (no messages, no composer draft)
  are hidden from the tree unless they are open in the main view, carry a
  draft, are less than two minutes old, are running or were renamed.
- **Inline Session rename**: writes the title to the Host session log through
  `session/rename`, so desktop and phone agree.
- **Drag sorting**: categories, workspaces and sessions can be reordered by
  dragging; order is Host-shared.
- **New-workspace flow**: consumes the optional `workspaceDefaultDirectory`
  client service (official in-app directory dialog) and falls back to the
  official native directory chooser; the new workspace gets its first Session
  created and opened.
- `test/package.test.js`: publish-readiness guard (identity consistency,
  portability, patch guard, attribution).

### Changed

- Fork identity: package `dsh-mahiros-workspace-categories`, loader row
  `mahiro-workspace-tree`; storage keys and the Host route path are unchanged
  so an upstream installation keeps its data.
- The Cordis patch `disabled` guard also recognizes the upstream package name,
  so both bundles can be installed without ever registering two
  `sidebar.workspaces` entries at `priority: -100`.
- New-workspace buttons are only disabled while the flow runs; nothing spins.
- **Compatibility window capped**: `engines.dsh` is
  `>=0.2.0-rc.2 <0.2.3-0` (0.2.2 final included). DSH throws at profile boot on an
  unmet `engines.dsh`, and an open-ended range would also claim unverified
  0.2.3-rc.1 / 0.3.0-rc.1.
- Peer dependencies now only name packages the plugin really consumes
  (`@deepseek-ai/dsh-client-ui-slots` removed — never installed by any DSH
  release and never imported here).
- The tree degrades to stable empty snapshot stores when the `workspaces` /
  `sessions` controllers are absent, instead of throwing on first render (a
  single-slot entry that throws is abdicated until reload).

### Removed

- Fixtures that tied the tree to one machine or deployment: no absolute paths,
  loopback origins or fixed ports in published files or tests.

## 0.2.x — upstream base

Fork base: `dsh-workspace-categories` by knight (MIT),
<https://github.com/Knight-Zjy/dsh-workspace-categories>. Its features —
category management, drag-to-categorize, folding, session archiving filter,
inline workspace rename/delete and the `sidebar.workspaces` priority contract —
are inherited and retained.
