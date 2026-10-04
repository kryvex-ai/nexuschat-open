'use strict';

/**
 * Permission — the gate every tool call passes through.
 *
 * The rules are short on purpose, because this is the part of the app that
 * can lose someone's work:
 *
 *   read    runs without asking (it changes nothing) and is written to the log
 *   write   always asks; the user may remember the answer for this session,
 *           per tool and per top-level directory
 *   danger  always asks, every single time, and is never remembered — there
 *           is no "always allow" for a shell command or a delete
 *
 * There is no auto-accept switch anywhere in this file. The closest thing is
 * a session grant the user sets by hand in the prompt, and a denial is a
 * normal outcome: the call is refused, the reason goes back to the model, and
 * the turn continues.
 */

const { RISK } = require('../../shared/tools');

const DECISION = { ALLOW: 'allow', DENY: 'deny', ALWAYS: 'always' };

const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;

function fail(msg) {
  throw new Error(msg);
}

/** The top-level directory a call touches, used to scope a session grant. */
function scopeOf(tool, args) {
  if (!args || typeof args !== 'object') return '';
  const p = args.path || args.to || args.cwd;
  if (typeof p !== 'string' || !p) return '';
  const head = p.split('/').filter(Boolean)[0];
  if (!head || head === '..' || head === '.') return '';
  return /^[A-Za-z0-9._-]{1,64}$/.test(head) ? head : '';
}

class PermissionGate {
  /**
   * ask: async (request) => decision — supplied by the IPC layer, which shows
   * the prompt in the window and waits for the user. `request` carries
   * everything the UI needs and nothing it could misuse.
   */
  constructor({ ask, askBeforeReads = false, allowSessionGrants = true, log = [], timeoutMs = DEFAULT_ASK_TIMEOUT_MS } = {}) {
    this.ask = typeof ask === 'function' ? ask : null;
    this.askBeforeReads = askBeforeReads === true;
    this.allowSessionGrants = allowSessionGrants === true;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.grants = new Map();   // "tool" | "tool:scope" -> true
  }

  grantKey(tool, args) {
    const scope = scopeOf(tool, args);
    return scope ? `${tool.name}:${scope}` : tool.name;
  }

  /** Wipe remembered answers — Settings → Agent → Clear remembered. */
  clearGrants() {
    const n = this.grants.size;
    this.grants.clear();
    return n;
  }

  listGrants() {
    return [...this.grants.keys()].sort();
  }

  /**
   * Decide one call. Returns { decision, source, reason } where source is
   * 'policy' | 'grant' | 'user' | 'timeout'. Never throws.
   */
  async decide(call) {
    const { tool, args } = call;
    const entry = {
      tool: tool.name,
      risk: tool.risk,
      summary: call.summary,
      at: Date.now()
    };

    if (tool.risk === RISK.READ && !this.askBeforeReads) {
      entry.decision = 'allowed';
      entry.source = 'policy';
      this.log.push(entry);
      return { decision: DECISION.ALLOW, source: 'policy' };
    }

    // A remembered answer only ever covers write tools, and only when the
    // settings still allow it.
    if (tool.risk === RISK.WRITE && this.allowSessionGrants && this.grants.has(this.grantKey(tool, args))) {
      entry.decision = 'allowed';
      entry.source = 'grant';
      this.log.push(entry);
      return { decision: DECISION.ALLOW, source: 'grant' };
    }

    if (!this.ask) {
      entry.decision = 'denied';
      entry.source = 'no-ui';
      this.log.push(entry);
      return { decision: DECISION.DENY, source: 'no-ui', reason: 'There is nobody to ask, so nothing was allowed.' };
    }

    let answer;
    try {
      answer = await Promise.race([
        this.ask({
          id: call.id,
          name: tool.name,
          risk: tool.risk,
          summary: call.summary,
          detail: call.detail,
          preview: call.preview,
          scope: scopeOf(tool, args),
          canRemember: tool.risk === RISK.WRITE && this.allowSessionGrants
        }),
        new Promise(resolve => {
          const t = setTimeout(() => resolve({ decision: DECISION.DENY, reason: 'Timed out waiting for an answer.' }), this.timeoutMs);
          if (t.unref) t.unref();
        })
      ]);
    } catch (e) {
      answer = { decision: DECISION.DENY, reason: 'The permission prompt failed: ' + (e && e.message ? e.message : String(e)) };
    }

    const decision = answer && answer.decision === DECISION.ALLOW ? DECISION.ALLOW
      : answer && answer.decision === DECISION.ALWAYS ? DECISION.ALWAYS
        : DECISION.DENY;

    if (decision === DECISION.ALWAYS) {
      if (tool.risk !== RISK.WRITE || !this.allowSessionGrants) {
        // "Always" on something dangerous is not an option we offer, but a
        // hand-rolled answer must not become one either.
        entry.decision = 'denied';
        entry.source = 'policy';
        entry.reason = 'This kind of action is never remembered — it asks every time.';
        this.log.push(entry);
        return { decision: DECISION.DENY, source: 'policy', reason: entry.reason };
      }
      this.grants.set(this.grantKey(tool, args), true);
    }

    entry.decision = decision === DECISION.DENY ? 'denied' : 'allowed';
    entry.source = 'user';
    if (decision === DECISION.DENY && answer && answer.reason) entry.reason = String(answer.reason).slice(0, 200);
    this.log.push(entry);

    if (entry.decision === 'denied' && !entry.reason) {
      return { decision: DECISION.DENY, source: 'user', reason: 'The user declined this action.' };
    }
    return { decision, source: 'user', reason: entry.reason };
  }
}

module.exports = { PermissionGate, DECISION, DEFAULT_ASK_TIMEOUT_MS, scopeOf };