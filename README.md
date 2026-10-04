# NexusChat Open

**Your AI, your machine.** A free, open-source desktop chat app for Windows, macOS and
Linux — bring your own provider key, and everything (chats, bots, keys) stays on your
computer. No accounts, no telemetry, no servers, no strings.

[![CI](https://github.com/your-org/nexuschat-open/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/nexuschat-open/actions/workflows/ci.yml)
<!-- ^ Update `your-org/nexuschat-open` in this badge (2 places) to <owner>/<repo> after pushing. -->

## What it does

- **Chat** — streaming replies, Markdown, stop and regenerate, conversation history.
- **Your provider, your key** — OpenAI, xAI (Grok), Anthropic (Claude), Google
  (Gemini), Mistral, Groq, DeepSeek, OpenRouter, Nous Research, local **Ollama**, or
  any OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp…). Every base URL and
  model list is editable, so a provider change never needs a new build.
- **Local models** — install Ollama, pull a model, and chat works with Wi-Fi off.
- **Bots** — a bot is a named task that runs on a schedule (every minute to weekly)
  while the app is open or in the tray. Each bot has its own chat: scheduled results
  land there, and you can tell it "run every 30 minutes" or "pause for now" and it
  applies the change itself. Pause, resume, run now, run history, per-bot skills.
- **Skills & plugins** — prompt-level instruction packs (Writing, Developer,
  Operations, Accuracy). They shape how answers are written; they never run code.
- **Guide window** — a `Help` chip, a `?` on every page and `F1` anywhere open one
  window with the full explanations, so the screens stay clean.
- **Stays out of the way** — system tray with optional run-in-background, dark/light
  theme, export/import of your chats, one portable data folder.

## Privacy

- No account, no sign-in, no server: the app has **no backend at all**.
- Your API keys are encrypted at rest with the OS keyring (Electron `safeStorage`)
  and are never sent anywhere except the provider you pasted them into.
- No telemetry, no analytics, no crash reporting, no update checks.
- Uninstalling leaves one folder behind (your data) — delete it and you are done.

## Install

### Download a build

Grab the Windows installer or the portable `.exe` from the
[Releases page](../../releases). macOS and Linux users can run it from source —
Electron runs on all three, and nothing in the app is platform-specific.

### From source

Requires Node.js 22+.

```bash
git clone https://github.com/your-org/nexuschat-open.git
cd nexuschat-open
npm install
npm start
```

## First run

1. Open **Providers** and paste a key for the provider you want (or point **Ollama**
   at a local model — no key needed).
2. Press **Fetch models**, or just pick a model from the picker above the composer.
3. Type something. If no model is available yet, the app sends you to the Providers
   tab rather than failing silently.

### Bots

Create one with the `+` button in the Bots tab: give it a name, a task, a repeat
interval and the provider/model that should answer. It runs on this machine using
your key; results appear in the bot's own chat. To keep bots running when the window
is closed, switch **Run in background** on (or from Settings → Background).

### Skills

The **Skills** tab switches on instruction packs that apply to every chat and bot.
Skills attached in a bot's edit dialog apply to that bot only. Skills are prompt
text and nothing else — nothing is downloaded and no code ever runs.

## Development

```bash
npm install        # once
npm start          # run the app
npm test           # the whole suite — plain Node, no display needed
npm run smoke      # boot the real window once and print SMOKE_OK
npm run ui:check   # boot the window and assert the live UI over CDP
npm run icon       # regenerate build/icon.png
```

Headless Linux (containers, CI, a remote shell) needs no `sudo`:
`scripts/run-linux.sh` unpacks Electron's GTK 3 into `.electron-deps/`, skips the
setuid sandbox and puts the window on `xvfb-run`. `npm run smoke` and
`npm run ui:check` use it for you.

### Repository layout

```
nexuschat-open/
├── package.json          # electron + electron-builder (Windows NSIS + portable)
├── src/
│   ├── main/             # Electron main: ipc.js (every channel), store.js,
│   │                     #   bots.js (scheduler + store), providers/ (transport),
│   │                     #   secure.js (key encryption at rest)
│   ├── preload.js        # the nexus.* bridge — one function per channel, nothing else
│   ├── renderer/         # app.js (all UI), index.html, theme.css
│   └── shared/           # brand.js (rename the app here), providers.js, skills.js
├── scripts/              # run-linux.sh (headless), ui-check.js (live UI checks)
├── tests/                # node --test — logic, storage, IPC contract, UI wiring
└── build/icon.png
```

Adding a feature usually means all four: main logic (preferably a pure module with
unit tests), the IPC channel, the preload bridge, the renderer — plus a test that
asserts the wiring on every side.

**House rules**: no new runtime dependencies without a good reason (everything is
Node builtins); logic goes in a pure module and gets unit tests; comments explain
*why*, especially where a workaround exists for a specific runtime version.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports go through the process in
[SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). Rename the app in `src/shared/brand.js` and in
`package.json` if you fork it.
