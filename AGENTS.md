# Working on NexusChat Open

Read this before you change anything. It is the short version of what has already
cost time. Public contribution rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

| Command | What it does |
|---|---|
| `npm start` | run the app (needs a display; on a desktop machine) |
| `npm test` | the whole suite (logic, storage, IPC contract, UI wiring) — no display needed |
| `npm run smoke` | boots the real window once and prints `SMOKE_OK` |
| `npm run ui:check` | boots the real window, drives it over CDP, asserts the UI |
| `npm run start:linux` | runs the app headless; extra args go to Electron |
| `npm run icon` | regenerates `build/icon.png` |
| `npm run dist:win` | builds the NSIS installer + portable exe via electron-builder |

Headless Linux (containers, CI, a remote box) needs none of `sudo`:
`scripts/run-linux.sh` unpacks Electron's GTK 3 into `.electron-deps/`, skips
the setuid sandbox and puts the window on `xvfb-run`. It backs the `smoke` and
`ui:check` modes.

## Three traps, all of which have bitten already

1. **The suite is not the app.** Tests run on plain Node; the app runs inside
   Electron, and the two runtimes are not identical (Node's `fetch` in tests is
   not Electron's). Anything touching native capabilities has to be proven in
   Electron too — `npm run smoke` and `npm run ui:check` are that proof.
2. **electron-builder's wine bundle is often broken on Linux hosts.** If the NSIS
   pass dies with `failed to load …/ntdll.dll` / `run_wineboot failed`, the
   extracted toolset has no `lib/wine/<arch>-windows` and no retry helps; the
   release workflow builds on `windows-latest` precisely to avoid it. Locally,
   point `ELECTRON_BUILDER_WINE_TOOLSET_DIR` at a working Wine-Builds tree.
3. **Electron's single-instance lock.** A leftover instance (headless ones from
   previous sessions especially) makes every new launch exit `0` in silence.
   `smoke` and `ui:check` use a throwaway `--user-data-dir` so they cannot
   collide; `pgrep -af electron` before you debug a silent exit.

## Where things live

```
src/main/       Electron main: ipc.js (every channel), store.js (settings +
                chats persistence), bots.js (validation, BotStore, BotRunner
                scheduler), agent.js (the tool loop), providers/ (HTTP
                transport per provider kind), tools/ (executors, the
                permission gate, workspace confinement), secure.js
                (safeStorage adapter for keys at rest)
src/preload.js  the nexus.* bridge — one function per channel, nothing else
src/renderer/   app.js (all UI), index.html, theme.css
src/shared/     brand.js (rename the app here), providers.js (registry),
                skills.js (prompt-level skill registry + composer),
                tools.js (the tool registry — names, args, risk classes),
                directives.js (the [[tool …]] / [[bot …]] scanner)
scripts/        run-linux.sh (headless), ui-check.js (live UI over CDP),
                gen-icon.js
tests/          node --test; pure modules are exercised directly, the
                renderer contract is asserted as text plus a DOM-stub run,
                and tests/agent*.test.js cover the tool layer
```

## The tool layer, in one paragraph

The model asks for a tool by writing one `[[tool {…}]]` directive line in its
reply; `src/shared/directives.js` pulls those out, `src/shared/tools.js` checks
the name and every argument against the registry, `src/main/tools/permissions.js`
decides whether to ask the user, and only then does an executor in
`src/main/tools/` touch anything. `src/main/agent.js` loops: result back into the
prompt, model decides the next step, up to the step cap. Two invariants are worth
keeping in mind when you touch it: **dangerous tools are never remembered**, and
**tool results are neutralized before they go back into a prompt**, so a file
cannot smuggle a directive into the model.

Adding a feature usually means all four layers: main logic (preferably a pure
module with unit tests), the IPC channel in `ipc.js`, the preload bridge, and the
renderer — plus a test that asserts the wiring on every side. `scripts/ui-check.js`
exists to catch a channel or element that exists on one side only.

## House rules

- No new runtime dependencies without a good reason; everything is `node` builtins.
- Logic goes in a pure module and gets unit tests; Electron-only glue stays thin.
- Renderer code never touches the file system or the network directly — it goes
  through the bridge, with context isolation on and Node off.
- Comments explain *why*, especially where a workaround exists for a specific
  runtime or library version — name it, so the next person can check whether it
  still applies.
- Comments and copy in the app are written for the person reading them, not for a
  changelog.
- The privacy promise is a feature: no telemetry, no backend, no network calls
  except to the provider the user configured.

## Shipping

```bash
npm test                                  # always green before a tag
git commit -am 'v1.2.3' && git tag v1.2.3 && git push --tags
```

The `Release` workflow then builds the installer and portable exe on
`windows-latest` and attaches them to the GitHub Release. Bump `version` in
`package.json` in the same commit — the workflow and the in-app about line both
read it from there.
