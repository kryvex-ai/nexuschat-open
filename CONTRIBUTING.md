# Contributing to NexusChat Open

Thanks for helping. This is a small, dependency-light Electron app, so a good PR
usually stays small too.

## Getting set up

```bash
git clone https://github.com/your-org/nexuschat-open.git
cd nexuschat-open
npm install
npm test          # should be green before you change anything
npm start         # then click around
```

Node.js 22 or newer. The only dev dependencies are Electron and electron-builder;
the app itself ships **zero runtime dependencies**.

## The loop we ask for

1. Open an issue first for anything larger than a bug fix, so we do not duplicate
   work — a two-line PR is fine without one.
2. Branch from `main`.
3. Make the change, and add or update tests with it (`npm test`).
4. If the change touches the UI, run `npm run ui:check` too (it boots the real
   window and asserts what a user would see).
5. Open the PR with a short "what and why", and a note on how you tested it.

## House rules

- **No new runtime dependencies without a good reason.** Everything today is Node
  builtins. A dependency needs a paragraph in the PR explaining why the standard
  library cannot do it.
- **Logic goes in a pure module** (`src/main/*.js`, `src/shared/*.js`) and gets unit
  tests. Electron glue stays thin: the renderer may talk to the main process only
  through `src/preload.js`.
- **A feature usually means four edits**: main logic, the IPC channel in
  `src/main/ipc.js`, the bridge function in `src/preload.js`, and the renderer — plus
  a test that asserts the wiring exists on all sides. A channel that exists on one
  side only is the bug we most want to catch.
- **Renderer code may not touch the file system or the network directly.** Everything
  goes through the bridge; the renderer runs with context isolation on and Node off.
- **Comments explain *why*.** Especially where a workaround exists for a specific
  runtime or library version — name the version, so the next person can check whether
  it still applies.
- **Copy is for the person reading it.** No changelog tone, no exclamation marks, no
  claims a build cannot back up.
- Keep the privacy promise: no network calls anywhere except the provider the user
  configured, and no new telemetry. If a change needs one, say so in the issue first.

## Tests

```bash
npm test           # node --test tests/*.test.js — no display needed
npm run smoke      # boots the real window once (Linux: scripts/run-linux.sh)
npm run ui:check   # boots the window and drives it over CDP
```

`npm test` must pass before you push. It covers the logic, the storage layer, the
IPC/preload contract and the static UI wiring.

## Commits and PRs

- One logical change per commit; write the subject in the imperative
  ("Add pause/resume to the bot menu", not "stuff").
- Rebase rather than merge when updating a branch.
- Draft PRs are welcome if you want feedback on direction.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your OS and
Node version, and the app version from Settings → Data. Security problems do **not**
go in the tracker — see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is licensed under the MIT license of this
project, and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).