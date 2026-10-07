# NexusChat Open

**Your AI, your machine.** A free, open-source desktop chat app for Windows, macOS and
Linux — bring your own provider key, and everything (chats, bots, keys) stays on your
computer. No accounts, no telemetry, no servers, no strings.

[![CI](https://github.com/kryvex-ai/nexuschat-open/actions/workflows/ci.yml/badge.svg)](https://github.com/kryvex-ai/nexuschat-open/actions/workflows/ci.yml)

## What it does

- **Chat** — streaming replies, Markdown, stop and regenerate, conversation history,
  and a searchable model picker grouped by provider.
- **Your provider, your key** — OpenAI, xAI (Grok), Anthropic (Claude), Google
  (Gemini), Mistral, Groq, DeepSeek, OpenRouter, Nous Research, local **Ollama**, or
  any OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp…). Every base URL and
  model list is editable, so a provider change never needs a new build.
- **Local models** — install Ollama, pull a model, and chat works with Wi-Fi off.
- **Safe updates** — a pill in the sidebar's bottom-left spots a new official
  GitHub release, downloads the installer, verifies it against the release's own
  SHA-256 checksum and only then runs it — every install is confirmed by you.
- **Bots** — a bot is a named task that runs on a schedule (every minute to weekly)
  while the app is open or in the tray. Each bot has its own chat: scheduled results
  land there, and you can tell it "run every 30 minutes" or "pause for now" and it
  applies the change itself. Pause, resume, run now, run history, per-bot skills.
- **Skills & plugins** — prompt-level instruction packs (Writing, Developer,
  Operations, Accuracy). They shape how answers are written; they never run code.
- **Tools** — let the assistant work in one folder you choose: read, search and
  edit files, run your commands, use git. 24 tools, and every write, delete,
  shell command and network call asks you first.
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
2. Press **Save & connect** — the app fetches that provider's model list and
   switches the composer to it in one step.
3. Type something. If no model is available yet, the picker above the composer
   offers **Set up a provider**, and the app sends you to the Providers tab
   rather than failing silently.

### Bots

Create one with the `+` button in the Bots tab: give it a name, a task, a repeat
interval and the provider/model that should answer. It runs on this machine using
your key; results appear in the bot's own chat. To keep bots running when the window
is closed, switch **Run in background** on (or from Settings → Background).

### Skills

The **Skills** tab switches on instruction packs that apply to every chat and bot.
Skills attached in a bot's edit dialog apply to that bot only. Skills are prompt
text and nothing else — nothing is downloaded and no code ever runs.

### Tools: letting the assistant work in your project

Switch on **Settings → Assistant** and choose one folder. From then on the model
can use 24 tools inside it — and everything it does goes through you.

| What it can do | Tools |
|---|---|
| read and search | `read_file` `list_dir` `search_files` `grep_files` `file_info` `diff_files` `project_info` |
| change files | `write_file` `edit_file` `multi_edit` `append_file` `create_dir` `move_file` `copy_file` |
| work with git | `git_status` `git_diff` `git_log` `git_show` `git_stage` `git_commit` `git_branch` |
| run things | `delete_file` `run_command` `http_fetch` |

**How permission works — nothing is ever accepted automatically:**

- **Reads** run on their own and leave a row in the chat, so you can see exactly
  what was read. (Turn on *Ask before reads* to be asked for those too.)
- **Writes** stop and ask **every time**, showing the change before you answer.
  You can allow one, or remember the answer for that tool in that folder until
  the app closes.
- **Deletes, shell commands and network fetches** ask every time and are
  **never remembered**, whatever you answer. There is no auto-accept switch
  anywhere in the app, by design.
- Pressing Stop, closing the window or quitting answers anything still pending
  with a refusal.
- Paths cannot leave the folder you chose: `..`, absolute paths and symlinks are
  refused, and writes into `.git/` are refused so git stays intact.
- Tool output is text, and it is neutralized before it goes back into the model —
  a file that contains a tool directive cannot act on its own.
- `run_command` starts inside the folder, is killed together with its children
  when it times out, and git arguments that can execute code (`-c`,
  `--upload-pack`, `--ext-diff`, …) are refused outright.
- `http_fetch` is off until you switch on *Network tools*, and asks every time
  when you do. Everything else stays on this machine.
- One message can chain up to **Max tool steps** (default 12) of these rounds.

The **Tools** switch above the composer decides whether a chat may use them at
all; it is off until you turn it on.

## Development

```bash
npm install        # once
npm start          # run the app
npm test           # the whole suite — plain Node, no display needed
npm run smoke      # boot the real window once and print SMOKE_OK
npm run ui:check   # boot the window and assert the live UI over CDP
npm run icon       # regenerate the app logos from brand/kryvex-logo.png
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
│   │                     #   bots.js (scheduler + store), agent.js (the tool
│   │                     #   loop), providers/ (transport), tools/ (executors,
│   │                     #   permission gate, workspace confinement),
│   │                     #   secure.js (key encryption at rest)
│   ├── preload.js        # the nexus.* bridge — one function per channel, nothing else
│   ├── renderer/         # app.js (all UI), index.html, theme.css, logo.png
│   │                     #   (generated — npm run icon)
│   └── shared/           # brand.js (rename the app here), providers.js,
│                         #   skills.js, tools.js (the tool registry),
│                         #   directives.js (the [[tool …]] scanner)
├── brand/                # kryvex-logo.png — the source of every app logo
├── scripts/              # run-linux.sh (headless), ui-check.js (live UI checks),
│                         #   gen-icon.js + png.js (logo generation)
├── tests/                # node --test — logic, storage, IPC contract, UI
│                         #   wiring, and the agent layer (agent*.test.js)
└── build/icon.png        # window/tray/installer icon (npm run icon)
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
