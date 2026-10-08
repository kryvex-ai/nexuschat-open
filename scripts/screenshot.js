'use strict';
/**
 * Screenshot tour — walks a live NexusChat window through every redesigned
 * surface and writes one PNG per step to /tmp/opencode/shots/, then prints a
 * manifest of what was captured and what was skipped (and why).
 *
 * It boots nothing by default: it attaches to a window that already exposes
 * CDP, using the same discovery and the same minimal WebSocket client as
 * scripts/ui-check.js (node builtins only — no npm dependencies).
 *
 *   NEXUS_CDP_PORT=9222 node scripts/screenshot.js   # an already-running instance
 *   node scripts/screenshot.js --boot                # boots the app the way
 *                                                    # run-linux.sh ui does (throwaway
 *                                                    # profile, --remote-debugging-port,
 *                                                    # xvfb) and tears it down again
 *
 * The app is driven only the way a person drives it: clicks, key events,
 * typed input (setting .value + an input event, like ui-check.js) and real
 * nexus.* bridge calls. No markup is ever injected into the page under test.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = '/tmp/opencode/shots';
const BOOT = process.argv.includes('--boot');
// Boot mode defaults to 9333 so it cannot collide with an instance you are
// already running on the usual 9222.
const PORT = Number(process.env.NEXUS_CDP_PORT || (BOOT ? 9333 : 9222));
const BASE = 'http://127.0.0.1:' + PORT;
const SETTLE = 350;              // animations repaint within this after a click
const BLANK = 20 * 1024;         // a PNG below this is a blank frame, not a UI
// Last-resort deadline for the whole run: ref'd on purpose, so even a wedge
// with no live handle left (every promise parked on a dead socket) still
// wakes up, tears the booted app down and exits non-zero. Overridable so a
// slow machine can be given more room.
const WATCHDOG_MS = Number(process.env.NEXUS_SHOT_WATCHDOG_MS || 15 * 60 * 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let images = [];   // { file, desc, bytes }
let skips = [];    // { step, why }
let notes = [];    // problems that did not stop a capture
let crashes = [];  // Runtime.exceptionThrown seen during the tour
let bootApp = null; // set by --boot, checked while waiting for the page

/** Wait for the app's window to announce itself on CDP. */
async function waitForPage(timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (bootApp && bootApp.exited) return null; // it died, do not spin out the clock
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page;
    } catch { /* still booting, or not up yet */ }
    if (Date.now() > until) return null;
    await sleep(400);
  }
}

/** One CDP round trip may not take longer than this before it is abandoned. */
const CALL_TIMEOUT = 30000;

/**
 * A minimal CDP client: send commands, collect events, evaluate in the page.
 *
 * A session that dies while a command is in flight used to leave that
 * promise parked forever: `tour()` never returned, `stopApp()` never ran and
 * `--boot` walked away from an orphan Electron plus its `nexus-shot-*`
 * profile (AGENTS.md trap #3). So the socket's close/error now fail every
 * waiter, and every call carries a deadline. `opts` ({ WebSocket, timeoutMs })
 * exists for the tests — production passes nothing and gets the global
 * WebSocket and CALL_TIMEOUT.
 */
async function attach(wsUrl, opts) {
  const WS = (opts && opts.WebSocket) || WebSocket;
  const defaultTimeout = (opts && opts.timeoutMs) || CALL_TIMEOUT;
  const ws = new WS(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    const dead = () => rej(new Error('cannot reach the renderer'));
    ws.onerror = dead;
    ws.onclose = dead;
  });
  let seq = 0;
  let closed = false;
  const waiting = new Map();   // id -> { resolve, reject, timer }
  const listeners = new Map();
  /** Nothing will ever reply now, so reject everyone waiting and forget them. */
  const failAll = (why) => {
    closed = true;
    for (const [, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new Error(why));
    }
    waiting.clear();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const entry = waiting.get(msg.id);
      waiting.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
      return;
    }
    for (const fn of listeners.get(msg.method) || []) fn(msg.params);
  };
  ws.onclose = () => failAll('CDP session closed');
  ws.onerror = () => failAll('CDP session closed');
  const call = (method, params, timeoutMs) => new Promise((res, rej) => {
    if (closed) { rej(new Error('CDP session closed')); return; }
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      rej(new Error('CDP timeout: ' + method));
    }, timeoutMs || defaultTimeout);
    waiting.set(id, { resolve: res, reject: rej, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn]);
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const r = reply.result || {};
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception || {};
      throw new Error(String(ex.description || r.exceptionDetails.text || 'evaluate failed').split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  };
  return {
    call, evaluate, on,
    close: () => ws.close(),
    get pending() { return waiting.size; }
  };
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                       */
/* ------------------------------------------------------------------ */

const isShown = (client, id) => client.evaluate(
  `(() => { const el = document.getElementById(${JSON.stringify(id)}); return !!el && !el.classList.contains('hidden'); })()`);

async function clickTab(client, name) {
  const ok = await client.evaluate(`(() => {
    const b = document.querySelector('[data-tab=' + ${JSON.stringify(name)} + ']');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error('no [data-tab="' + name + '"] control');
}

/** One capture: let the view settle, grab the whole viewport as a PNG. */
async function shot(client, name, desc) {
  await sleep(SETTLE);
  const grab = async (fromSurface) => {
    const r = await client.call('Page.captureScreenshot', { format: 'png', fromSurface });
    const data = r && r.result && r.result.data;
    if (!data) throw new Error('Page.captureScreenshot returned no data' + (r && r.error ? ': ' + r.error.message : ''));
    return Buffer.from(data, 'base64');
  };
  let buf = await grab(true);
  if (buf.length < BLANK) {
    // A blank frame means the compositor surface was empty (window not yet
    // painted, no GPU); reading the renderer directly still yields the page.
    try {
      const alt = await grab(false);
      if (alt.length > buf.length) buf = alt;
    } catch { /* keep the first frame */ }
  }
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), buf);
  images.push({ file: name + '.png', desc, bytes: buf.length });
  if (buf.length < BLANK) notes.push(name + '.png is only ' + buf.length + ' bytes — the capture looks blank');
}

/** The theme dropdown persists through saveSetting and repaints on change. */
async function setTheme(client, value) {
  await client.evaluate(`(() => {
    const s = document.getElementById('themeSelect');
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const until = Date.now() + 3000;
  for (;;) {
    const applied = await client.evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(value)}`);
    if (applied) return true;
    if (Date.now() > until) return false;
    await sleep(150);
  }
}

/** run-boot: app.js has parsed and boot() has painted the empty state. */
async function waitBoot(client, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try {
      ready = await client.evaluate(`(() => {
        const t = document.getElementById('emptyTitle');
        return document.readyState === 'complete'
          && typeof activateTab === 'function'
          && typeof sendMessage === 'function'
          && typeof nexus === 'object'
          && !!(t && t.textContent);
      })()`);
    } catch { /* renderer still parsing, or mid-reload */ }
    if (ready) return;
    if (Date.now() > until) throw new Error('the renderer never finished booting (app.js broken?)');
    await sleep(400);
  }
}

/** A local OpenAI-compatible SSE server — the one ui-check.js streams from. */
function startFakeProvider() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      if (!/\/chat\/completions/.test(req.url || '')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = ['Hello ', 'streaming ', 'works ', 'token by ', 'token!'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] }) + '\n\n');
        } else {
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
        }
      }, 300);
      res.on('close', () => clearInterval(timer));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* The tour                                                           */
/* ------------------------------------------------------------------ */

async function tour() {
  images = []; skips = []; notes = []; crashes = [];

  const page = await waitForPage(BOOT ? 60000 : 30000);
  if (!page) throw new Error('the app never appeared on CDP :' + PORT);
  const client = await attach(page.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  client.on('Runtime.exceptionThrown', (p) => {
    const d = (p && p.exceptionDetails) || {};
    const ex = (d.exception && d.exception.description) || d.text || 'renderer exception';
    crashes.push(String(ex).split('\n')[0]);
  });

  const step = async (name, desc, fn) => {
    try {
      await fn();
    } catch (e) {
      skips.push({ step: name, why: String((e && e.message) || e) });
    }
  };

  try {
    await waitBoot(client, 45000);

    // A throwaway profile boots with settings.introDone false and
    // runInBackground unset, so the intro owns the screen first and the
    // background-mode prompt waits behind it. Both must go before the tour
    // can click anything else — but the intro is captured before it is
    // dismissed, because it is part of the design under review.
    const overlayState = () => client.evaluate(`(() => {
      const shown = id => { const el = document.getElementById(id); return !!(el && !el.classList.contains('hidden')); };
      return JSON.stringify({ intro: shown('intro'), bg: shown('bgModal'), update: shown('updateModal') });
    })()`);
    const before = JSON.parse(await overlayState());
    if (before.intro) {
      await shot(client, '00-intro', 'first-run intro overlay on the fresh profile (settings.introDone is false)');
      await client.evaluate(`document.getElementById('introSkipBtn').click()`);
      await sleep(SETTLE);
    } else {
      skips.push({ step: '00-intro', why: 'the intro overlay was not visible at boot (#intro hidden)' });
    }
    const afterIntro = JSON.parse(await overlayState());
    if (afterIntro.bg) {
      await client.evaluate(`document.getElementById('bgNoBtn').click()`);
      await sleep(SETTLE);
    }
    if (afterIntro.update) {
      await client.evaluate(`document.getElementById('updateLaterBtn').click()`);
      await sleep(SETTLE);
    }
    const left = JSON.parse(await overlayState());
    if (left.intro || left.bg || left.update) throw new Error('a first-run overlay would not close: ' + JSON.stringify(left));

    await step('01-chat-empty', 'chat tab at rest: empty state with the starter chips', async () => {
      await clickTab(client, 'chat');
      await shot(client, '01-chat-empty', 'chat tab at rest: empty state with the starter chips');
    });

    // Step 2 — a real send, exactly the way ui-check.js does its "Live
    // streaming" check: a local SSE provider serves five chunks with gaps,
    // so the bubble on screen is caught growing and then finished.
    const fake = await startFakeProvider();
    try {
      let kicked = false;
      try {
        await clickTab(client, 'chat');
        const kick = JSON.parse(await client.evaluate(`(async () => {
          const saved = await nexus.saveProvider('custom', { baseUrl: ${JSON.stringify(fake.base)}, apiKey: 'test', models: ['fakemodel'] });
          try { state = await nexus.getState(); } catch { /* keep the boot state */ }
          state.settings.activeChatModel = 'custom::fakemodel';
          const input = document.getElementById('input');
          input.value = 'How does token streaming work?';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('sendBtn').click();
          return JSON.stringify({ saved: !!(saved && saved.ok) });
        })()`));
        if (!kick.saved) throw new Error('saveProvider refused the fake provider');
        kicked = true;
        await sleep(500);
        await shot(client, '02a-chat-streaming',
          'chat mid-stream: reply growing token by token from the local fake provider');
      } catch (e) {
        skips.push({ step: '02a-chat-streaming', why: String((e && e.message) || e) });
      }
      if (kicked) {
        try {
          const FULL = 'Hello streaming works token by token!';
          const until = Date.now() + 8000;
          let text = '';
          while (Date.now() < until) {
            text = await client.evaluate(`(() => {
              const msgs = [...document.querySelectorAll('#messages .msg.assistant')];
              const last = msgs[msgs.length - 1];
              return last ? last.textContent : '';
            })()`);
            if (text === FULL) break;
            await sleep(120);
          }
          if (text !== FULL) {
            throw new Error('the reply never reached the end of the stream (saw: ' + JSON.stringify(String(text).slice(0, 60)) + ')');
          }
          await shot(client, '02b-chat-done',
            'conversation complete: user + assistant bubbles, the chat now listed in the sidebar');
        } catch (e) {
          skips.push({ step: '02b-chat-done', why: String((e && e.message) || e) });
        }
      } else {
        skips.push({ step: '02b-chat-done', why: 'the send never started (02a-chat-streaming failed)' });
      }
    } finally {
      if (typeof fake.srv.closeAllConnections === 'function') fake.srv.closeAllConnections();
      fake.srv.close();
    }

    const tabs = [
      ['03-bots', 'bots', 'bots tab: bot list, filters and the bot toolbar'],
      ['04-skills', 'skills', 'skills tab: the skill registry and search'],
      ['05-providers', 'providers', 'providers tab: provider list (the harness\u2019 fake SSE provider included)'],
      ['06-settings', 'settings', 'settings tab: the redesigned panel layout'],
    ];
    for (const [name, tab, desc] of tabs) {
      await step(name, desc, async () => {
        await clickTab(client, tab);
        await shot(client, name, desc);
      });
    }

    await step('07-help', 'guide & help window opened with F1', async () => {
      await client.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', code: 'F1', bubbles: true }))`);
      await sleep(SETTLE);
      let open = await isShown(client, 'helpModal');
      if (!open) {
        await client.evaluate(`document.getElementById('helpBtn').click()`);
        await sleep(SETTLE);
        open = await isShown(client, 'helpModal');
      }
      if (!open) throw new Error('the guide window opened on neither F1 nor #helpBtn');
      await shot(client, '07-help', 'guide & help window opened with F1');
      await client.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(150);
      if (await isShown(client, 'helpModal')) {
        await client.evaluate(`document.getElementById('helpCloseBtn').click()`);
        await sleep(150);
      }
      if (await isShown(client, 'helpModal')) notes.push('07-help: the guide window would not close (Escape or #helpCloseBtn)');
    });

    await step('08-model-picker', 'model picker popup over the composer, grouped by provider', async () => {
      await clickTab(client, 'chat');
      await client.evaluate(`document.getElementById('modelBtn').click()`);
      await sleep(SETTLE);
      if (!(await isShown(client, 'modelPop'))) throw new Error('#modelBtn did not open the model popup');
      await shot(client, '08-model-picker', 'model picker popup over the composer, grouped by provider');
      await client.evaluate(`(() => {
        document.getElementById('modelSearch')
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      })()`);
      await sleep(150);
      if (await isShown(client, 'modelPop')) {
        notes.push('08-model-picker: Escape did not close the popup — clicking the trigger again');
        await client.evaluate(`document.getElementById('modelBtn').click()`);
      }
    });

    await step('09a-chat-light', 'chat view in the light theme', async () => {
      await clickTab(client, 'chat');
      if (!(await setTheme(client, 'light'))) throw new Error('#themeSelect change did not switch the page theme');
      await shot(client, '09a-chat-light', 'chat view in the light theme');
    });
    await step('09b-settings-light', 'settings view in the light theme', async () => {
      const light = await client.evaluate(`document.documentElement.dataset.theme === 'light'`);
      if (!light) throw new Error('the page was not in the light theme (09a failed)');
      await clickTab(client, 'settings');
      await shot(client, '09b-settings-light', 'settings view in the light theme');
    });
    // Back to the shipped default so nothing after this is tinted.
    if (!(await setTheme(client, 'dark'))) notes.push('the theme select did not switch back to dark');
    await clickTab(client, 'chat');

    await step('10-tool-modal', 'tool permission prompt (the assistant wants to act on your machine)', async () => {
      const reachable = await client.evaluate(`typeof window.showToolAsk === 'function'`);
      if (!reachable) {
        throw new Error('showToolAsk is not reachable as a page global — no way to trigger the prompt without faking DOM');
      }
      await clickTab(client, 'chat');
      await sleep(SETTLE);
      const shown = await client.evaluate(`(() => {
        showToolAsk({
          id: 'screenshot-probe',
          name: 'write_file',
          risk: 'write',
          summary: 'Write src/notes.md',
          detail: 'Replace the whole file in the workspace with the new content.',
          preview: 'src/notes.md  \u00b7  12 lines',
          scope: 'workspace',
          canRemember: true
        });
        return !document.getElementById('toolModal').classList.contains('hidden');
      })()`);
      if (!shown) throw new Error('showToolAsk ran but #toolModal stayed hidden');
      await shot(client, '10-tool-modal', 'tool permission prompt (the assistant wants to act on your machine)');
      await client.evaluate(`document.getElementById('toolDenyBtn').click()`);
      await sleep(150);
      if (await isShown(client, 'toolModal')) notes.push('10-tool-modal: the prompt would not close on Deny');
    });

    await sleep(200);
  } finally {
    client.close();
  }
}

/* ------------------------------------------------------------------ */
/* --boot: the run-linux.sh ui launch, done here                      */
/* ------------------------------------------------------------------ */

function launchApp() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shot-'));
  const logPath = path.join(profile, 'boot.log');
  const fd = fs.openSync(logPath, 'a');
  const child = spawn('bash', [
    path.join(ROOT, 'scripts', 'run-linux.sh'), 'run',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + PORT
  ], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, DISPLAY: process.env.DISPLAY || '' } });
  fs.closeSync(fd);
  const app = { child, profile, logPath, exited: false };
  child.on('exit', () => { app.exited = true; });
  child.unref();
  return app;
}

async function stopApp(app) {
  if (!app) return;
  const kill = (sig) => {
    try { process.kill(-app.child.pid, sig); } catch { try { app.child.kill(sig); } catch { /* gone */ } }
  };
  kill('SIGTERM');
  await sleep(1500);
  kill('SIGKILL');
  await sleep(300);
  try { fs.rmSync(app.profile, { recursive: true, force: true }); } catch { /* keep the log */ }
}

/** Best-effort reload so a half-written app.js is re-read on the retry. */
async function reloadPage() {
  try {
    const page = await waitForPage(5000);
    if (!page) return;
    const c = await attach(page.webSocketDebuggerUrl);
    try {
      await c.call('Page.enable');
      await c.call('Page.reload', { ignoreCache: true });
    } finally {
      c.close();   // a rejected call here must not leave a socket holding the loop open
    }
    await sleep(1500);
  } catch { /* the retried tour re-discovers the page anyway */ }
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

function report() {
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log('\nmanifest — ' + OUT_DIR);
  for (const im of images) {
    console.log('  ' + pad(im.file, 26) + String(Math.round(im.bytes / 1024)).padStart(5) + ' KB   ' + im.desc);
  }
  console.log('\nskipped:');
  if (!skips.length) console.log('  (nothing)');
  for (const s of skips) console.log('  ' + pad(s.step, 26) + s.why);
  if (notes.length) {
    console.log('\nnotes:');
    for (const n of notes) console.log('  ' + n);
  }
  console.log('\nrenderer exceptions: ' + (crashes.length ? crashes.join(' | ') : 'none'));
  const blank = images.filter(i => i.bytes < BLANK);
  console.log('images produced: ' + images.length + (blank.length ? ' (' + blank.length + ' below ' + BLANK + ' bytes!)' : ''));
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.png')) fs.rmSync(path.join(OUT_DIR, f), { force: true });
  }

  if (BOOT) bootApp = launchApp();
  console.log('screenshot tour — CDP :' + PORT + (bootApp ? ' (booted by this script)' : ' (attach)'));

  // Armed before the tour, cleared only once the booted app is down: it is
  // the last thing running if the flow below itself wedges, so a dead CDP
  // session can never turn into an orphan Electron (AGENTS.md trap #3).
  const watchdog = setTimeout(() => {
    console.error('watchdog: no result after ' + WATCHDOG_MS + 'ms — tearing down');
    stopApp(bootApp).then(() => process.exit(1), () => process.exit(1));
  }, WATCHDOG_MS);

  let ran = false;
  try {
    try {
      await tour();
      ran = true;
    } catch (e) {
      console.error('tour failed: ' + ((e && e.message) || e));
      console.error('waiting 20s for a half-written renderer to settle, then retrying once\u2026');
      await sleep(20000);
      await reloadPage();
      await tour();
      ran = true;
    }
    report();
  } catch (e) {
    console.error('screenshot tour failed: ' + ((e && e.message) || e));
    if (bootApp) console.error('boot log: ' + bootApp.logPath);
  } finally {
    // Whatever went wrong above — a thrown step, a dead session, a dead
    // renderer — the booted app is torn down before the exit code is read.
    await stopApp(bootApp);
  }

  clearTimeout(watchdog);
  process.exit(ran && images.length >= 6 ? 0 : 1);
}

// Requiring this file (the client tests) must not start a tour; running it
// must, exactly as before.
if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { attach, CALL_TIMEOUT };
