# dsh-mahiros-workspace-categories

English · [中文](./README.md)

**Status**: stable (0.8.x) · **Tested with**: DeepSeek Harness `>= 0.2.0-rc.2 < 0.2.3`, Node `>= 20`, Linux / macOS / Windows

**Overview**: replaces the DSH sidebar workspace browser with a three-level **Category > Workspace > Session** tree.  
Categories, assignments and the manual session order live in a Host-side shared document, so the desktop browser and a `dsh-pocket` phone render the same tree.  
Categories, workspaces and sessions can be reordered by dragging and renamed in place; dragging folds the levels below, scrolls at the list edges, and a drop bar at the top of the tree offers cancel / delete exits.  
The official plugin is not modified: this one shadows the `sidebar.workspaces` slot at `priority: -100`, and disabling it brings the official browser straight back.

```text
Category A                     ← user category, drag-sortable
  └ Workspace A-1   +  ·  3    ← session count / new session / folded status
      └ Session 1
      └ Session 2
Uncategorized                  ← unassigned workspaces, always a drop target
  └ Workspace B
```

**Contents**:
- [Quick start](#quick-start)
- [Other options](#other-options)
- [Notes](#notes)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Compatibility](#compatibility)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)
- [Disclaimer](#disclaimer)
- [License](#license)

## Quick start

| Step | Action |
| --- | --- |
| 1 | Confirm DSH `>= 0.2.0-rc.2` and Node `>= 20` |
| 2 | Install the plugin (command below) |
| 3 | Enable it in Settings → Plugins, then restart DSH once |
| 4 | Open the sidebar; the workspace browser is now the category tree |

```bash
dsh plugin --profile <profile> add \
  https://github.com/MineMahiro/dsh-mahiros-workspace-categories/releases/download/v0.8.3/dsh-mahiros-workspace-categories-0.8.3.tgz
```

Replace `<profile>` with your profile name (commonly `web` or `desktop`). This is equivalent to adding the package name `dsh-mahiros-workspace-categories` to that profile's `dsh.profile.bundles`; you can also check or disable it under Settings → Plugins.  
The first activation needs one DSH restart; later upgrades only need a page refresh (a Host-half change still needs a Host restart).  
The tree becomes the only workspace browser — the official list is not shown — and disabling or uninstalling the plugin brings the official browser back immediately.

## Other options

**Install from source**: clone the repository and install it locally when you want to modify code or track `main`.

```bash
git clone https://github.com/MineMahiro/dsh-mahiros-workspace-categories.git
dsh plugin --profile <profile> add ./dsh-mahiros-workspace-categories
```

**Install from the tgz by hand**: download the release asset first, then install from the local path (useful offline or for pinning a version).

```bash
curl -L -o dsh-mahiros-workspace-categories-0.8.3.tgz \
  https://github.com/MineMahiro/dsh-mahiros-workspace-categories/releases/download/v0.8.3/dsh-mahiros-workspace-categories-0.8.3.tgz
dsh plugin --profile <profile> add ./dsh-mahiros-workspace-categories-0.8.3.tgz
```

Both routes end the same way: enable the plugin under Settings → Plugins and restart DSH once.

## Notes

1. **Mutually exclusive with the upstream plugin**  
   Do not enable `dsh-workspace-categories` alongside this one: both register the single `sidebar.workspaces` slot at `priority: -100`, and this plugin's patch guard steps aside when it sees the upstream package name (so there is no double registration), but only one should be kept.
2. **Host-half changes need a Host restart**  
   The browser half takes effect on a page refresh; a Host-half change (the shared-state route) needs one Host restart. Never restart the Host from inside the DSH session it serves — leave that to the user.
3. **Keep the official plugin installed**  
   The official `ui-workspace` stays installed and enabled; this plugin only shadows its slot, so disabling or uninstalling restores the official browser.
4. **Back up the shared document**  
   Categories and assignments live in `$DSH_HOME/workspace-categories/state.json`; if the file is damaged it is renamed to `state.json.bad-<timestamp>` and rebuilt. Include it in your backups.
5. **No dragging on phones**  
   Touch browsers do not dispatch HTML5 drag events; a phone shows the order arranged on the desktop but cannot reorder it.
6. **Blank sessions are hidden, not deleted**  
   This is a view filter: DSH has no delete-session API, so the session logs stay on disk.

## How it works

### Features

| Capability | Description |
| --- | --- |
| Category management | Categories can be created, renamed, deleted and drag-sorted; dropping a workspace on a category row assigns it, dropping it back on Uncategorized clears the assignment |
| One tree everywhere | Categories, assignments and session order live in the Host shared document, so desktop and phone see the same tree; fold state and other preferences stay local |
| Session work status | Running / waiting / completed; aggregated upward into folded workspace or category rows |
| Blank-session cleanup | Sessions with no messages and no composer draft are hidden from the tree (open in the main view, has a draft, updated within the last 2 minutes, running or renamed ones stay), hidden only, never deleted |
| Inline editing | Categories, workspaces and sessions can be renamed in place; deleting a workspace only removes it from the list, the folder and session logs are kept |
| Session archiving | Row action plus a tri-state filter (hide archived / include archived / archived only), matching the official browser semantics |
| Drag assist | Folds the levels below while dragging, restores the previous expansion on drop, and scrolls at the list edges (next section) |
| Drag drop bar | While any row is dragged, a bar with cancel / delete zones appears at the top of the tree (next section) |
| New workspace | After picking a directory the workspace joins the category that started the flow, a first session is created and opened; running flows disable their triggers instead of spinning |
| Takeover | Shadows the single `sidebar.workspaces` slot at `priority: -100` without modifying the official plugin; disabling it restores the official browser |

### Dragging

- **Dragging a category**: folds every category's workspaces, leaving only category rows on screen.
- **Dragging a workspace**: folds every workspace's sessions.
- **Dragging a session**: folds nothing.
- **Restoring on drop**: the fold is a view-only overlay; nothing is persisted, so the tree returns to its pre-drag expansion as soon as the drag ends.
- **Edge autoscroll**: entering the 36 px band at the top or bottom scrolls the list, at most 16 px per frame; it stops when the pointer leaves the band, the drag ends or the list reaches an end, and does not scroll while the pointer is outside the list's horizontal range.
- **Drop bar**: while any row is dragged, a bar at the top of the tree offers 取消 (cancel) and 删除 (delete). Dropping on cancel keeps the previous order exactly; dropping on delete runs the row's existing destructive action — categories and workspaces ask for confirmation, sessions are archived (recoverable from the undo strip).

### Shared state and data

- Categories, assignments and manual session order: `$DSH_HOME/workspace-categories/state.json`, read and written by the Host through the authenticated `/api/workspace-categories.state` route.
- Fold / expand, visible counts and archive filter: local `localStorage`, not shared across devices.
- Synchronisation is eventually consistent: another device sees a change within about 4 seconds, and immediately when the page becomes visible again.
- No network calls and no telemetry; uninstalling never deletes workspace folders or session logs.

### Known limitations

- Touch browsers cannot drag; a phone only displays the order arranged on the desktop.
- Blank sessions are filtered from the view only; their logs are never deleted.
- Shared state is eventually consistent, so a cross-device change can take about 4 seconds.

## FAQ

Q1: **The sidebar still shows the official browser after installing.**  
A1: Check that the package name is in the profile's `dsh.profile.bundles` and that the plugin is enabled, then restart DSH once. The first activation always needs a restart.

Q2: **Can it be installed together with the upstream `dsh-workspace-categories`?**  
A2: No. Both claim the same slot at the same priority; this plugin's patch guard detects the upstream package and steps aside, but keep only one of them.

Q3: **Which data is shared and which stays on one machine?**  
A3: Categories, assignments and manual session order are shared; fold state, visible counts and the archive filter are local preferences.

Q4: **Can I reorder by dragging on a phone?**  
A4: No. Touch browsers have no HTML5 drag events; a phone shows the order arranged on the desktop.

Q5: **Does removing a workspace delete its folder on disk?**  
A5: No. Deleting only removes the workspace from the list; the folder and session logs are kept, and the tree stops showing its sessions.

Q6: **Do upgrades need a reinstall?**  
A6: Overwrite with `dsh plugin --profile <profile> add <new tgz>`; a browser-half-only change needs just a page refresh, a Host-half change needs a Host restart.

Q7: **Which DSH versions are supported?**  
A7: `engines.dsh` declares `>= 0.2.0-rc.2 < 0.2.3`; anything outside that window is rejected by app-boot. See the [compatibility notes](./docs/COMPATIBILITY.md).

## Compatibility

| Tested version | Result |
| --- | --- |
| DSH 0.2.1-rc.2 (Linux Host) | Real deployment, full feature walkthrough passed |
| DSH 0.2.1-rc.5 (Windows DSH Desktop) | Installed and running, dragging and other UI verified |
| DSH 0.2.0-rc.2, 0.2.1-rc.1 ~ rc.5, 0.2.2-rc.1 | Static check: every interface and field used exists with unchanged semantics |
| DSH 0.1.x / 0.2.3+ / 0.3.x | Not verified, blocked by `engines.dsh` |
| Node 20 / 22 / 24 (Linux and Windows CI) | `npm test` green |

Interface inventory, degradation behaviour and the verification method are in [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).

## Repository layout

```text
dsh-mahiros-workspace-categories/
├─ lib/
│  ├─ index.js            # Host entry: authenticated /api route
│  ├─ state-store.js      # shared document: validation, operations, atomic write, rev
│  ├─ state-routes.js     # GET|POST /api/workspace-categories.state
│  └─ client.js           # browser half: tree UI + sync engine (hand-written bundle)
├─ locale/                # plugin-marketplace copy (zh / en)
├─ test/                  # node --test cases: model, drag, Host, publish guard
├─ test-harness/          # shared VM + React stand-in for unit tests
├─ docs/COMPATIBILITY.md  # compatibility evidence
├─ AGENTS.md              # repo conventions for agents
├─ CHANGELOG.md / NOTICE / LICENSE
└─ README.md / README.en.md  # human docs (Chinese / English mirror)
```

Development and release flow live in [AGENTS.md](./AGENTS.md); `npm test` (bare `node --test`) needs no installed dependencies.

## Roadmap

- [ ] Touch dragging on phones: limited by HTML5 `DragEvent`; an alternative interaction has to be chosen first.
- [ ] Real deletion of blank sessions: depends on a delete-session API from DSH.
- [ ] Widen the DSH version window: re-check with the [compatibility notes](./docs/COMPATIBILITY.md) method first.
- Feedback: GitHub [Issues](https://github.com/MineMahiro/dsh-mahiros-workspace-categories/issues).

## Disclaimer

- This is an unofficial community plugin, not affiliated with DeepSeek or DeepSeek Harness.
- The repository contains no DSH build, no closed-source artefacts and no credentials.
- No network calls and no telemetry; uninstalling never deletes workspace folders or session logs.
- Back up `$DSH_HOME/workspace-categories/state.json` before making changes.
- Provided "as is" under the MIT license, with no liability for data loss.

## License

Scripts and documentation are under the [MIT License](./LICENSE).

This project is a modified fork of [knight](https://github.com/Knight-Zjy)'s [`dsh-workspace-categories`](https://github.com/Knight-Zjy/dsh-workspace-categories) (MIT). The upstream copyright notice is kept verbatim in [LICENSE](./LICENSE), and the fork's changes are described in [NOTICE](./NOTICE) and [CHANGELOG.md](./CHANGELOG.md).
