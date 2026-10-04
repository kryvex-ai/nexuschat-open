# Security Policy

## Supported versions

Security fixes land on the latest release. Older tags are not patched — update to the
newest release.

| Version | Supported |
|---|---|
| latest release | yes |
| anything older | no |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private
reporting: **Security → Report a vulnerability** in this repository (the
"Report a vulnerability" button in the Security tab of the repo). If that is not
available to you, open a public issue that says only "security report — please open
a private channel", with no technical detail.

Please include, as far as you can:

- what an attacker could do, and what they need (local access, a user action, a
  malicious model reply…);
- the steps or the smallest proof of concept;
- the app version, OS and Electron version.

You can expect an acknowledgement within 72 hours and a status update within seven
days. If a fix is needed we will agree a disclosure date with you, and credit you in
the release notes unless you prefer to stay anonymous.

## What is in scope

This app is local-only, so the interesting surface is small:

- **The IPC/preload bridge** — anything that lets the renderer do more than it should
  (file system access, arbitrary commands, reading another app's data).
- **Secret handling** — API keys at rest, in exports, or anywhere they could leak
  (logs, error messages, crash output).
- **Data files** — `settings.json`, `conversations.json` and `bots.json` in the
  userData folder: crafted files that could crash the app on load, escape their
  directory, or inject script into the renderer.
- **Markdown rendering** — content from a model or an imported chat that executes or
  fetches something it should not.
- **Bot prompts** — anything that lets untrusted text (a model reply, an imported
  task) smuggle tool directives past the parsing boundary.

## What is not a vulnerability

- The app sends your prompts and your key to whichever provider you configured. That
  is the design; use Ollama if you want no network at all.
- Anything requiring an attacker to already control your user account or your machine.
- Denial of service by pasting a very large file into your own data folder.
- Findings from automated scanners with no demonstrated path to impact — please say
  so and we will help.