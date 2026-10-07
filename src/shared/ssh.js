'use strict';

/**
 * SSH — pure logic behind Settings → SSH and the ssh_exec tool.
 *
 * Nothing in here spawns a process or touches the network: it validates what
 * the renderer and the model may ask for, builds the argv the main process
 * will spawn, quotes the scripts that run on the far side, and scores a host
 * from the facts an `ssh -G` read and one connection probe produce.
 *
 * Three rules the whole feature leans on:
 *
 *  1. This app never stores or sends a password. Every invocation is
 *     BatchMode, so a password-only host is unreachable by design — the
 *     self-test says so instead of prompting.
 *  2. The renderer only ever sends a host *id*; the argv is built from the
 *     saved, sanitized host record. Host-like strings from the UI are
 *     re-validated here so nothing can smuggle an option (a leading "-")
 *     or a shell metacharacter into the spawn.
 *  3. Remote paths reach the far shell single-quoted (shQuote), and the one
 *     script that needs shell syntax is wrapped in an explicit `sh -c`, so
 *     the user's login shell (fish, csh, …) cannot reinterpret it.
 */

/** Caps that keep one call from eating the machine or the window. */
const SSH_LIMITS = {
  HOSTS_MAX: 50,
  CONNECT_TIMEOUT_S: 8,
  RUN_TIMEOUT_MS: 30000,
  PROBE_TIMEOUT_MS: 12000,
  LIST_TIMEOUT_MS: 15000,
  READ_TIMEOUT_MS: 20000,
  SAVE_TIMEOUT_MS: 60000,
  OUTPUT_MAX: 262144,   // runner output shown in the panel
  READ_MAX: 524288,     // preview cap (head asks for one byte more)
  SAVE_MAX: 10485760,   // download-to-workspace cap
  PATH_MAX: 4096
};

const HOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// No leading "-" (an option in disguise), no spaces, no @ or shell punctuation.
const HOSTNAME_RE = /^[A-Za-z0-9:][A-Za-z0-9.:_-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._\\-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function stripControl(s) {
  return String(s == null ? '' : s).replace(CONTROL_RE, '').trim();
}

/** Stable id for a host that arrived without a usable one. */
function hostIdFor(host, user, i) {
  let h = 2166136261;
  const seed = host + '\n' + (user || '') + '\n' + i;
  for (let k = 0; k < seed.length; k++) {
    h ^= seed.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return 'h' + (h >>> 0).toString(36) + i;
}

/**
 * Validate and normalize the saved host list. Total by design: junk entries
 * are dropped rather than throwing, so a corrupt settings file can never
 * wedge the panel — what survives is always spawn-safe.
 */
function sanitizeHosts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < SSH_LIMITS.HOSTS_MAX; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const host = stripControl(raw.host).toLowerCase();
    if (!HOSTNAME_RE.test(host)) continue;
    let user = stripControl(raw.user || '');
    if (user && !USER_RE.test(user)) user = '';
    let label = stripControl(raw.label || '').slice(0, 64) || host;
    const portNum = Math.floor(Number(raw.port));
    const port = Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 22;
    let keyFile = stripControl(raw.keyFile || '').slice(0, 512);
    const id = String(raw.id || '').match(HOST_ID_RE) ? raw.id : hostIdFor(host, user, i);
    out.push({ id, label, host, user, port, keyFile });
  }
  return out;
}

/** "user@host" or just "host" — the one thing ssh treats as the destination. */
function targetFor(host) {
  return host.user ? host.user + '@' + host.host : host.host;
}

/**
 * Build the full ssh argv. Options come first, the destination last but one,
 * and any command is a single trailing argv — ssh never passes it through a
 * local shell, so there is no local interpretation to inject into.
 */
function buildSshArgs(host, { flag = '', command = null, acceptNew = false, connectTimeoutS = SSH_LIMITS.CONNECT_TIMEOUT_S } = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + Math.max(1, Math.floor(connectTimeoutS))];
  if (acceptNew) args.push('-o', 'StrictHostKeyChecking=accept-new');
  if (host.port && host.port !== 22) args.push('-p', String(host.port));
  if (host.keyFile) args.push('-i', host.keyFile);
  if (flag) args.push(flag);
  args.push(targetFor(host));
  if (command !== null && command !== undefined) args.push(String(command));
  return args;
}

/** POSIX single-quote escaping — the only reliable quoting across shells. */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * A directory listing script that works under any POSIX login shell (it is
 * run via `sh -c`, so fish/csh logins are fine). Emits a "C<TAB>resolved-dir"
 * header, then "d<TAB>path" or "f<TAB>path" per entry. Names containing a
 * tab or newline cannot survive this framing — they are dropped by the
 * parser, which is the standard trade-off for a line protocol.
 * `path` of ''/null lists the login home via "$HOME" (quoted so a home
 * directory with spaces still globs correctly).
 */
function remoteListScript(path) {
  const p = path && String(path).trim() ? shQuote(String(path).trim()) : '"$HOME"';
  return `d=$(cd ${p} 2>/dev/null && pwd) || d=${p}; printf 'C\\t%s\\n' "$d"; for e in ${p}/* ${p}/.[!.]* ${p}/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; if [ -d "$e" ]; then printf 'd\\t%s\\n' "$e"; else printf 'f\\t%s\\n' "$e"; fi; done`;
}

/** The remote command line for a listing: sh is explicit, never the login shell. */
function remoteListCommand(path) {
  return 'sh -c ' + shQuote(remoteListScript(path));
}

/** Parse the listing into { name, dir, path }, directories first, then A→Z. */
function parseRemoteList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (line.length < 3 || line[1] !== '\t') continue;
    const type = line[0];
    if (type !== 'd' && type !== 'f') continue;
    const full = line.slice(2);
    const name = full.slice(full.lastIndexOf('/') + 1);
    if (!name) continue;
    out.push({ name, dir: type === 'd', path: full });
  }
  out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}

/** The resolved directory from the listing's C header (null when absent). */
function parseListDir(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('C\t')) return line.slice(2);
  }
  return null;
}

/** Remote read command; asks for maxBytes + 1 so truncation is detectable. */
function remoteReadCommand(path, maxBytes) {
  const n = Math.max(1, Math.floor(maxBytes)) + 1;
  return 'head -c ' + n + ' ' + shQuote(path);
}

/** Absolute paths only — a leading "-" can never reach head as an option. */
function sanitizeRemotePath(p, { allowHome = false } = {}) {
  const s = String(p == null ? '' : p).trim();
  if (allowHome && (s === '' || s === '~')) return s;
  if (!s.startsWith('/')) return null;
  if (s.length > SSH_LIMITS.PATH_MAX || CONTROL_RE.test(s)) return null;
  return s;
}

/** The command a runner/tool typed: free text by design — it runs remotely. */
function sanitizeCommand(c) {
  const s = String(c == null ? '' : c);
  if (!s.trim()) return null;
  if (s.includes('\0')) return null;
  return s.length > 20000 ? null : s;
}

/** Local file name for a download: basename only, never "." or "..". */
function sanitizeSaveName(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop() || '';
  const clean = stripControl(base).slice(0, 200);
  if (!clean || clean === '.' || clean === '..') return 'download';
  return clean;
}

/** "report (2).txt" style collision avoidance, existence decided by caller. */
function uniqueSaveName(base, exists) {
  if (!exists(base)) return base;
  const i = base.lastIndexOf('.');
  const stem = i > 0 ? base.slice(0, i) : base;
  const ext = i > 0 ? base.slice(i) : '';
  for (let n = 2; n < 1000; n++) {
    const cand = stem + ' (' + n + ')' + ext;
    if (!exists(cand)) return cand;
  }
  return stem + ' (' + Date.now() + ')' + ext;
}

/** Ssh alias for a Host block: free-form labels must become one token. */
function hostAlias(host) {
  const slug = stripControl(host.label || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return slug || host.host;
}

/** known_hosts query: non-default ports use the [host]:port form. */
function knownHostsQuery(host) {
  return host.port && host.port !== 22 ? '[' + host.host + ']:' + host.port : host.host;
}

/**
 * Parse `ssh -G` output. Keys are lower-cased; repeated keys (identityfile
 * and friends) collect into an array, single-valued keys stay strings.
 */
function parseSshG(text) {
  const map = {};
  for (const line of String(text || '').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const key = line.slice(0, sp).toLowerCase();
    const val = line.slice(sp + 1).trim();
    if (map[key] === undefined) map[key] = val;
    else if (Array.isArray(map[key])) map[key].push(val);
    else map[key] = [map[key], val];
  }
  return map;
}

function listVal(eff, key) {
  const v = eff[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * `ssh -G` prints algorithm lists comma-joined on one line ("ciphers a,b,c"),
 * while identity files arrive one per line. Splitting the wrong way makes
 * every anchored pattern silently miss — so the two shapes stay separate.
 */
function csvVal(eff, key) {
  const v = eff[key];
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap(s => String(s).split(',')).map(s => s.trim()).filter(Boolean);
}

function firstLine(s, max = 400) {
  const t = String(s == null ? '' : s).split('\n')[0].trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

const WEAK_CIPHERS = [/^3des/i, /^des/i, /^arcfour/i, /^rc4/i, /^blowfish/i, /^cast/i, /^rijndael/i];
const WEAK_KEX = [/diffie-hellman-group1-sha1$/i, /diffie-hellman-group14-sha1$/i, /diffie-hellman-group-exchange-sha1$/i];
const WEAK_MACS = [/hmac-md5/i, /hmac-sha1-96/i];

function matchesAny(list, patterns) {
  return list.filter(v => patterns.some(re => re.test(v)));
}

/**
 * The self-test rule engine: effective config (`ssh -G`) plus local facts
 * (known_hosts, key permissions) plus one probe result → score, findings
 * and a tuning note. Pure, so every rule is a unit test.
 *
 * facts: { connect: null | { ok, ms?, error? }, knownHosts: bool,
 *          key: null | { path, exists, mode: number|null } }
 */
function auditSsh(eff, facts = {}) {
  const e = eff && typeof eff === 'object' ? eff : {};
  const findings = [];
  const add = (level, title, detail, fix) => findings.push({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), level, title, detail, fix: fix || '' });

  // 1. Reachability, from the one probe.
  const c = facts.connect;
  if (c) {
    if (c.ok) add('good', 'Reachable', 'BatchMode handshake succeeded in ' + Math.round(c.ms || 0) + ' ms — keys and host key are fine.');
    else add('bad', 'Cannot connect', firstLine(c.error || 'The connection failed.'), 'Check the host, port and key. This app never prompts for a password, so the host must accept a key (or your ssh-agent).');
  }

  // 2. Authentication posture.
  if (String(e.pubkeyauthentication).toLowerCase() === 'no') {
    add('bad', 'Public-key authentication is off', 'With PubkeyAuthentication no, nothing this app can do will authenticate.', 'PubkeyAuthentication yes');
  } else {
    add('good', 'Public-key authentication is on', 'Keys (or your agent) are accepted.');
  }
  if (String(e.passwordauthentication).toLowerCase() === 'yes') {
    add('warn', 'Password authentication is offered', 'This app never sends passwords, so a password-only account cannot connect from here — add a key first.', 'PasswordAuthentication no');
  } else {
    add('good', 'Passwords are refused', 'PasswordAuthentication no — only keys can get in.');
  }

  // 3. Root login.
  const root = String(e.permitrootlogin || '').toLowerCase();
  if (root === 'yes' || root === 'ask') {
    add('warn', 'Root login is permitted with credentials', 'PermitRootLogin ' + root + ' keeps the most privileged account in the authentication path.', 'PermitRootLogin prohibit-password');
  } else if (root) {
    add('good', 'Root login is restricted', 'PermitRootLogin ' + root + '.');
  }

  // 4. Agent forwarding — the classic "the remote has my keys now" footgun.
  if (String(e.forwardagent).toLowerCase() === 'yes') {
    add('warn', 'Agent forwarding is on', 'A process on the far side can ask your agent to sign things while you are connected.', 'ForwardAgent no');
  } else {
    add('good', 'Agent forwarding stays off', 'ForwardAgent no.');
  }

  // 5. Host-based auth, if the config turns it on.
  if (String(e.hostbasedauthentication).toLowerCase() === 'yes') {
    add('bad', 'Host-based authentication is on', 'It trusts other hosts to vouch for you — rarely what you want.', 'HostbasedAuthentication no');
  }

  // 6. Crypto the client still offers for this host.
  const ciphers = matchesAny(csvVal(e, 'ciphers'), WEAK_CIPHERS);
  if (ciphers.length) add('warn', 'Weak ciphers are still offered', ciphers.join(', '), 'Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes256-ctr');
  else add('good', 'Modern ciphers only', 'No 3DES/ARCFOUR/Blowfish in the offer.');
  const kex = matchesAny(csvVal(e, 'kexalgorithms'), WEAK_KEX);
  if (kex.length) {
    const fatal = kex.some(v => /group1-sha1$/i.test(v));
    add(fatal ? 'bad' : 'warn', fatal ? 'Broken key exchange is offered' : 'SHA-1 key exchange is offered', kex.join(', '), 'KexAlgorithms sntrup761x25519-sha512,curve25519-sha256,diffie-hellman-group16-sha512');
  } else {
    add('good', 'Modern key exchange', 'No group1 / SHA-1 KEX in the offer.');
  }
  const macs = matchesAny(csvVal(e, 'macs'), WEAK_MACS);
  if (macs.length) add('warn', 'Weak message authentication is offered', macs.join(', '), 'MACs umac-openssh@openssh.com,hmac-sha2-256-etm@openssh.com');
  else add('good', 'Modern MACs', 'No MD5 or truncated SHA-1 in the offer.');

  // 7. known_hosts coverage (trust on first use, or not yet).
  if (facts.knownHosts) add('good', 'Host key is already trusted', 'A saved key in known_hosts will be checked on every connection.');
  else add('warn', 'Host key is not trusted yet', 'The first connection pins the key (trust on first use); until then ssh refuses to connect non-interactively.', 'Connect once from a terminal you trust, or just use the buttons here — they pin it for you.');

  // 8. Local key file hygiene.
  const key = facts.key;
  if (key) {
    if (!key.exists) {
      add('warn', 'Configured key file is missing', key.path, 'ssh-keygen -t ed25519 -f ' + key.path);
    } else if (key.mode !== null && key.mode !== undefined && (key.mode & 0o077) !== 0) {
      add('bad', 'The key file is readable by other users', key.path + ' has mode ' + key.mode.toString(8) + '.', 'chmod 600 ' + key.path);
    } else if (key.mode !== null && key.mode !== undefined) {
      add('good', 'Key file permissions are right', key.path + ' is ' + key.mode.toString(8) + '.');
    } else {
      add('good', 'Key file exists', key.path);
    }
  }

  const bad = findings.filter(f => f.level === 'bad').length;
  const warn = findings.filter(f => f.level === 'warn').length;
  const score = Math.max(0, Math.min(100, 100 - bad * 25 - warn * 10));
  const note = bad + warn === 0
    ? 'This host’s effective setup looks good — nothing to tune.'
    : (bad ? bad + ' problem' + (bad === 1 ? '' : 's') + ' and ' : '') + warn + ' warning' + (warn === 1 ? '' : 's') + ' — the block below carries the fixes; copy it into ~/.ssh/config.';
  return { score, findings, note };
}

/** The ready-to-copy Host block the self-test hands over. */
function sshConfigBlock(host) {
  const lines = ['Host ' + hostAlias(host), '  HostName ' + host.host];
  if (host.user) lines.push('  User ' + host.user);
  if (host.port && host.port !== 22) lines.push('  Port ' + host.port);
  if (host.keyFile) lines.push('  IdentityFile ' + host.keyFile);
  lines.push('  PubkeyAuthentication yes');
  lines.push('  PasswordAuthentication no');
  lines.push('  PermitRootLogin prohibit-password');
  lines.push('  ForwardAgent no');
  return lines.join('\n');
}

/** A NUL byte in the first 8 KB means "not a text file worth previewing". */
function isProbablyText(buf) {
  const n = Math.min(buf && buf.length != null ? buf.length : 0, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

module.exports = {
  SSH_LIMITS,
  sanitizeHosts, targetFor, buildSshArgs, shQuote,
  remoteListScript, remoteListCommand, parseRemoteList, parseListDir, remoteReadCommand,
  sanitizeRemotePath, sanitizeCommand, sanitizeSaveName, uniqueSaveName,
  hostAlias, knownHostsQuery, parseSshG, listVal, csvVal, firstLine,
  auditSsh, sshConfigBlock, isProbablyText
};
