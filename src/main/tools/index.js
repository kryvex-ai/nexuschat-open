'use strict';

/**
 * Tool host — the one path a tool call can take.
 *
 *   model text -> parse -> registry lookup -> argument validation ->
 *   permission gate -> executor -> result, neutralized for the next prompt
 *
 * Anything that is not in the registry stops at step two. Anything that fails
 * validation never reaches the gate, and anything the gate refuses never
 * reaches an executor. Results are neutralized on the way back so that a file
 * the model reads cannot smuggle a directive into the next turn.
 */

const fs = require('node:fs');
const path = require('node:path');
const { toolByName, toolNames, validateArgs, callSummary, signature, LIMITS, RISK } = require('../../shared/tools');
const { extractDirectives, neutralizeDirectives } = require('../../shared/directives');
const fsTools = require('./fs');
const shellTools = require('./shell');
const sshTools = require('../ssh');
const { PermissionGate, DECISION } = require('./permissions');

const FILE_TOOLS = new Set(Object.keys(fsTools.HANDLERS));
const SHELL_TOOLS = new Set(Object.keys(shellTools.HANDLERS));
const SSH_TOOLS = new Set(Object.keys(sshTools.HANDLERS));

/** Pull `[[tool {…}]]` directives out of a model reply. */
function parseToolCalls(text) {
  const { text: clean, actions } = extractDirectives(text, 'tool', a => typeof a.name === 'string');
  const calls = actions.map((a, i) => ({
    id: 'call_' + (i + 1) + '_' + Date.now().toString(36),
    name: String(a.name).slice(0, 64),
    args: a.args
  }));
  return { text: clean, calls };
}

/** What the permission prompt shows under the summary line. */
function describeCall(tool, args, root) {
  const detail = tool.summary;
  let preview = '';
  try {
    if (tool.name === 'run_command') {
      preview = `$ ${args.command}`;
    } else if (tool.name === 'http_fetch') {
      preview = `${String(args.method || 'GET').toUpperCase()} ${args.url}`;
    } else if (tool.name === 'ssh_exec') {
      preview = `${args.host}: $ ${args.command}`;
    } else if (tool.name === 'delete_file') {
      const abs = path.resolve(root, String(args.path || ''));
      preview = fs.existsSync(abs)
        ? fs.readdirSync(abs).slice(0, 40).map(n => '  ' + n).join('\n')
        : 'This path does not exist.';
    } else if (tool.name === 'write_file') {
      preview = String(args.content || '').split('\n').slice(0, 40).join('\n');
    } else if (tool.name === 'edit_file' || tool.name === 'multi_edit') {
      const abs = path.resolve(root, String(args.path || ''));
      if (fs.existsSync(abs)) {
        const edits = tool.name === 'edit_file'
          ? [{ old_string: args.old_string, new_string: args.new_string }]
          : (args.edits || []);
        const parts = [];
        for (const e of edits.slice(0, 3)) {
          parts.push('--- find\n' + String(e.old_string || '').slice(0, 800));
          parts.push('+++ replace with\n' + String(e.new_string || '').slice(0, 800));
        }
        preview = parts.join('\n');
      } else {
        preview = 'This file does not exist yet.';
      }
    } else if (args.path) {
      preview = String(args.path);
    }
  } catch {
    preview = '';
  }
  return { detail, preview: preview.slice(0, 4000) };
}

/** The catalogue the UI shows in Settings → Agent. */
function catalog() {
  return toolNames().map(name => {
    const t = toolByName(name);
    return {
      name: t.name,
      risk: t.risk,
      group: t.group,
      summary: t.summary,
      signature: signature(t),
      needsAsk: t.risk !== RISK.READ
    };
  });
}class ToolHost {
  /**
   * root     — workspace directory (already validated by the caller)
   * gate     — PermissionGate
   * enabled  — (tool) => boolean, so Settings can switch a whole class off
   * sshHosts — () => saved SSH hosts; ssh_exec can only ever reach these
   */
  constructor({ root, gate, enabled = null, sshHosts = null } = {}) {
    this.root = root;
    this.gate = gate || new PermissionGate({ ask: null });
    this.enabled = enabled;
    this.sshHosts = sshHosts;
  }

  allowed(tool) {
    return typeof this.enabled === 'function' ? this.enabled(tool) : true;
  }

  /** Run one already-parsed call. Resolves with an envelope; never throws. */
  async invoke(call) {
    const tool = toolByName(call.name);
    if (!tool) {
      return {
        ok: false, tool: String(call.name || '?'), risk: null,
        error: `There is no tool called "${call.name}". Available: ${toolNames().join(', ')}.`
      };
    }
    const summary = callSummary(tool, call.args && typeof call.args === 'object' ? call.args : {});
    const base = { tool: tool.name, risk: tool.risk, summary };

    if (!this.allowed(tool)) {
      return { ...base, ok: false, denied: true, error: `${tool.name} is switched off in Settings.` };
    }
    if (!this.root) {
      return { ...base, ok: false, denied: true, error: 'No workspace folder is set — choose one in Settings → Agent.' };
    }

    const v = validateArgs(tool, call.args);
    if (!v.ok) return { ...base, ok: false, error: v.error };

    const { detail, preview } = describeCall(tool, v.args, this.root);
    const decision = await this.gate.decide({ id: call.id, tool, args: v.args, summary, detail, preview });
    if (decision.decision === DECISION.DENY) {
      return {
        ...base,
        ok: false,
        denied: true,
        error: decision.reason || 'The user declined this action. Find another way, or explain what you wanted.',
        askedBy: decision.source
      };
    }

    try {
      const ctx = { root: this.root, sshHosts: this.sshHosts };
      const handler = FILE_TOOLS.has(tool.name) ? fsTools
        : SSH_TOOLS.has(tool.name) ? sshTools
          : shellTools;
      const raw = await handler.run(tool.name, v.args, ctx);
      return {
        ...base,
        ok: true,
        result: neutralizeDirectives(String(raw == null ? '' : raw)).slice(0, LIMITS.OUTPUT_MAX)
      };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 500);
      return { ...base, ok: false, error: msg };
    }
  }

  /** Run a batch in order, stopping early if the user asks to stop. */
  async invokeMany(calls, { shouldStop = () => false } = {}) {
    const out = [];
    for (const call of calls) {
      if (shouldStop()) break;
      out.push(await this.invoke(call));
    }
    return out;
  }
}

/** Turn results into the text block handed back to the model. */
function resultsToPrompt(results) {
  return results.map(r => {
    const head = r.ok ? `${r.tool} — ok` : r.denied ? `${r.tool} — declined` : `${r.tool} — failed`;
    return `## ${head}\n${r.ok ? r.result : (r.error || 'Unknown failure')}`;
  }).join('\n\n');
}

module.exports = {
  ToolHost, PermissionGate, DECISION, parseToolCalls, describeCall, catalog,
  resultsToPrompt, FILE_TOOLS, SHELL_TOOLS
};