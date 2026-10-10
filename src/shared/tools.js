'use strict';

/**
 * Tools — the registry behind the coding-agent layer.
 *
 * A tool is a named operation the model may ask the app to perform. Three
 * things matter here and they are deliberately boring:
 *
 *  1. RISK decides permission, not the UI. `read` has no side effects and runs
 *     without asking (it is logged). `write` changes files inside the
 *     workspace and always asks. `danger` deletes, runs a shell command or
 *     talks to the network: it always asks and is never remembered, even if
 *     the user said "always allow" for something else.
 *  2. Every argument is declared here and validated here, in the main
 *     process, before any executor sees it. The model writes text; the model
 *     never gets to name a function that is not in this file.
 *  3. The same registry renders the manual that is appended to the system
 *     prompt, so a tool cannot exist in the prompt but be missing at runtime
 *     (or the other way round).
 *
 * Paths are always relative to the workspace root chosen in Settings; the
 * executors refuse anything that resolves outside it.
 */

const RISK = {
  READ: 'read',      // no side effects -> runs without asking
  WRITE: 'write',    // changes files in the workspace -> always asks
  DANGER: 'danger'   // deletes, runs a command, uses the network -> always asks, never remembered
};

const RISK_ORDER = [RISK.READ, RISK.WRITE, RISK.DANGER];

/** Caps that keep one runaway call from eating the machine. */
const LIMITS = {
  ARG_STRING: 20000,        // longest single string argument
  ARG_LINES: 5000,          // longest text argument, in lines
  EDITS_PER_CALL: 50,       // multi_edit batch size
  PATHS_PER_CALL: 200,      // longest path list
  PATH_CHARS: 1024,
  TIMEOUT_MIN_MS: 1000,
  TIMEOUT_MAX_MS: 600000,
  OUTPUT_MAX: 200000        // command/diff output handed back to the model
};

const TOOLS = [
  /* ---------------- read: no side effects ---------------- */
  {
    name: 'read_file',
    risk: RISK.READ,
    group: 'files',
    summary: 'Read a UTF-8 text file from the workspace.',
    args: {
      path: 'string — file path, relative to the workspace root',
      start_line: 'number? — 1-based first line to return (default: whole file)',
      end_line: 'number? — 1-based last line, inclusive',
      max_bytes: 'number? — refuse anything larger (default 400000)'
    },
    returns: 'The text, one line per row, prefixed with its line number. Errors come back as text.'
  },
  {
    name: 'list_dir',
    risk: RISK.READ,
    group: 'files',
    summary: 'List a directory. Use it to orient before reading or editing anything.',
    args: {
      path: 'string? — directory to list (default: workspace root)',
      recursive: 'boolean? — walk sub-directories (default false)',
      depth: 'number? — how deep to walk when recursive (default 2, max 8)',
      pattern: 'string? — only entries matching this suffix, e.g. ".ts"'
    },
    returns: 'One entry per line: type, size and path.'
  },
  {
    name: 'search_files',
    risk: RISK.READ,
    group: 'search',
    summary: 'Find a literal string across the workspace.',
    args: {
      query: 'string — text to look for (case-insensitive)',
      path: 'string? — directory to search (default: root)',
      include: 'string? — only files whose name ends with this, e.g. ".ts"',
      max_results: 'number? — stop after this many hits (default 100)'
    },
    returns: 'One hit per line as path:line: text.'
  },
  {
    name: 'grep_files',
    risk: RISK.READ,
    group: 'search',
    summary: 'Find lines matching a regular expression.',
    args: {
      pattern: 'string — JavaScript regular expression (no flags)',
      path: 'string? — directory to search (default: root)',
      include: 'string? — only files whose name ends with this',
      ignore_case: 'boolean? — default false',
      max_results: 'number? — default 100'
    },
    returns: 'One match per line as path:line: text.'
  },
  {
    name: 'find_paths',
    risk: RISK.READ,
    group: 'search',
    summary: 'Find files and directories by name. Use it to locate something before reading or editing it.',
    args: {
      query: 'string — file or folder name to look for (case-insensitive substring)',
      path: 'string? — directory to search under (default: workspace root)',
      include_dirs: 'boolean? — list matching directories too (default true)',
      max_results: 'number? — stop after this many hits (default 100)'
    },
    returns: 'Matching directories, then files, one per line with its type.'
  },
  {
    name: 'file_info',
    risk: RISK.READ,
    group: 'files',
    summary: 'Check whether a path exists and what it is, without reading it.',
    args: { path: 'string — path to inspect' },
    returns: 'exists: yes/no, plus type, size and modified time for a file.'
  },
  {
    name: 'diff_files',
    risk: RISK.READ,
    group: 'files',
    summary: 'Compare two files line by line — useful to check your own edit.',
    args: {
      path: 'string — left file',
      other_path: 'string — right file',
      max_lines: 'number? — cap the output (default 400)'
    },
    returns: 'A unified-style diff with +/- lines.'
  },
  {
    name: 'project_info',
    risk: RISK.READ,
    group: 'project',
    summary: 'Describe the workspace: git root and branch, plus the manifests it can find.',
    args: {},
    returns: 'Git branch, then a summary of package.json / pyproject.toml / Cargo.toml / go.mod when present.'
  },/* ---------------- write: changes files in the workspace ---------------- */
  {
    name: 'write_file',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Create a file, or replace its whole contents.',
    args: {
      path: 'string — file path to write',
      content: 'string — full new contents'
    },
    returns: 'Bytes written and the path.'
  },
  {
    name: 'edit_file',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Replace an exact snippet in a file. Prefer this over write_file for changes.',
    args: {
      path: 'string — file to edit',
      old_string: 'string — exact text to find (must be unique unless replace_all)',
      new_string: 'string — replacement text ("" deletes it)',
      replace_all: 'boolean? — replace every occurrence (default false)'
    },
    returns: 'How many replacements were made.'
  },
  {
    name: 'multi_edit',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Apply several exact replacements to one file in a single pass.',
    args: {
      path: 'string — file to edit',
      edits: 'array of { old_string, new_string, replace_all? }'
    },
    returns: 'How many edits were applied.'
  },
  {
    name: 'append_file',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Append text to the end of a file.',
    args: {
      path: 'string — file to append to',
      content: 'string — text to add'
    },
    returns: 'Bytes appended.'
  },
  {
    name: 'create_dir',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Create a directory (with parents).',
    args: { path: 'string — directory to create' },
    returns: 'The directory path, and whether it already existed.'
  },
  {
    name: 'move_file',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Move or rename a file or directory.',
    args: {
      path: 'string — existing path',
      to: 'string — new path'
    },
    returns: 'Both paths.'
  },
  {
    name: 'copy_file',
    risk: RISK.WRITE,
    group: 'files',
    summary: 'Copy a file or directory tree.',
    args: {
      path: 'string — existing path',
      to: 'string — destination path'
    },
    returns: 'Both paths.'
  },/* ---------------- git ---------------- */
  {
    name: 'git_status',
    risk: RISK.READ,
    group: 'git',
    summary: 'Working-tree status and current branch.',
    args: { path: 'string? — repository directory (default: root)' },
    returns: 'Branch plus porcelain status lines.'
  },
  {
    name: 'git_diff',
    risk: RISK.READ,
    group: 'git',
    summary: 'Show a diff.',
    args: {
      path: 'string? — restrict to this path',
      staged: 'boolean? — diff the index instead of the working tree',
      ref: 'string? — compare against this ref, e.g. "HEAD~1"'
    },
    returns: 'The diff text.'
  },
  {
    name: 'git_log',
    risk: RISK.READ,
    group: 'git',
    summary: 'Recent commits.',
    args: {
      limit: 'number? — how many (default 20, max 200)',
      path: 'string? — only commits touching this path'
    },
    returns: 'One line per commit: hash, date, subject.'
  },
  {
    name: 'git_show',
    risk: RISK.READ,
    group: 'git',
    summary: 'Show one commit or file at a ref.',
    args: { ref: 'string — e.g. "HEAD", "HEAD~2" or "abc1234"' },
    returns: 'Commit metadata and its diff.'
  },
  {
    name: 'git_stage',
    risk: RISK.WRITE,
    group: 'git',
    summary: 'Stage files for the next commit.',
    args: {
      paths: 'array of strings — files to stage (use ["."] for everything)',
      unstage: 'boolean? — remove from the index instead'
    },
    returns: 'What was staged.'
  },
  {
    name: 'git_commit',
    risk: RISK.WRITE,
    group: 'git',
    summary: 'Commit what is staged.',
    args: {
      message: 'string — commit message (imperative, one line)',
      amend: 'boolean? — amend the previous commit'
    },
    returns: 'The new commit hash.'
  },
  {
    name: 'git_branch',
    risk: RISK.WRITE,
    group: 'git',
    summary: 'List branches, create one, or switch to one.',
    args: {
      action: 'string — "list", "create" or "switch"',
      name: 'string? — branch name (required for create/switch)'
    },
    returns: 'The branch list, or the branch that was created/switched to.'
  },

  /* ---------------- danger: deletes, commands, network ---------------- */
  {
    name: 'delete_file',
    risk: RISK.DANGER,
    group: 'files',
    summary: 'Delete a file, or a whole directory tree. This cannot be undone from here.',
    args: {
      path: 'string — what to delete',
      recursive: 'boolean? — required true to delete a non-empty directory'
    },
    returns: 'What was removed.'
  },
  {
    name: 'run_command',
    risk: RISK.DANGER,
    group: 'shell',
    summary: 'Run a shell command — build, test, git, npm, or a search anywhere on this PC. The working directory stays in the project root, the command itself does not, and it always asks first.',
    args: {
      command: 'string — the command line, run through the system shell',
      cwd: 'string? — working directory (default: root)',
      timeout_ms: 'number? — kill it after this long (default 120000, max 600000)'
    },
    returns: 'Exit code, stdout and stderr (truncated).'
  },
  {
    name: 'http_fetch',
    risk: RISK.DANGER,
    group: 'net',
    summary: 'Fetch a URL. Useful for docs — but note this is the one tool that leaves your machine.',
    args: {
      url: 'string — http(s) URL',
      method: 'string? — GET, HEAD, POST, PUT or PATCH (default GET)',
      body: 'string? — request body',
      headers: 'object? — extra headers, e.g. { "accept": "application/json" }'
    },
    returns: 'Status line, then the response body (truncated).'
  },
  {
    name: 'ssh_exec',
    risk: RISK.DANGER,
    group: 'ssh',
    summary: 'Run a command on a remote machine over SSH, through a host saved in Settings → SSH. Passwords are never involved — keys or your agent, as in a terminal.',
    args: {
      host: 'string — the saved host: its id or its label, from Settings → SSH',
      command: 'string — the command line, run on the remote machine',
      timeout_ms: 'number? — kill it after this long (default 60000, max 600000)'
    },
    returns: 'Exit code, stdout and stderr (truncated).'
  }
];/* ---------------- helpers ---------------- */

function toolByName(name) {
  return TOOLS.find(t => t.name === name) || null;
}

function toolNames() {
  return TOOLS.map(t => t.name);
}

function toolsByRisk(risk) {
  return TOOLS.filter(t => t.risk === risk);
}

/**
 * Parse a declared argument like "string — file path" or "number? — cap".
 * Returns { type, optional }; anything the model sends that does not match
 * the declaration is rejected rather than coerced.
 */
function parseArgType(decl) {
  const head = String(decl).trim().split(/\s*—\s*/)[0];
  const optional = head.endsWith('?');
  const base = (optional ? head.slice(0, -1) : head).trim();
  const type = base.startsWith('array') ? 'array'
    : base.startsWith('object') ? 'object'
      : base;
  return { type, optional };
}

/** Render one tool as a call signature, e.g. edit_file(path: string, old_string: string…). */
function signature(tool) {
  const parts = Object.entries(tool.args).map(([k, d]) => {
    const { type, optional } = parseArgType(d);
    return k + (optional ? '?' : '') + ': ' + type;
  });
  return tool.name + '(' + parts.join(', ') + ')';
}

/**
 * One-line description of a call, used in the permission prompt and in the
 * chat activity log. Purely descriptive: it must never be mistaken for the
 * result, and the executors never parse it back.
 */
function callSummary(tool, args = {}) {
  const a = args || {};
  switch (tool.name) {
    case 'read_file': return `Read ${a.path}`;
    case 'list_dir': return `List ${a.path || 'the workspace'}${a.recursive ? ' recursively' : ''}`;
    case 'search_files': return `Search for “${a.query}”`;
    case 'grep_files': return `Grep /${a.pattern}/`;
    case 'find_paths': return `Find paths matching “${a.query}”`;
    case 'file_info': return `Inspect ${a.path}`;
    case 'diff_files': return `Diff ${a.path} against ${a.other_path}`;
    case 'project_info': return 'Describe the project';
    case 'write_file': return `Write ${a.path}`;
    case 'edit_file': return `Edit ${a.path}`;
    case 'multi_edit': return `Apply ${(a.edits || []).length} edits to ${a.path}`;
    case 'append_file': return `Append to ${a.path}`;
    case 'create_dir': return `Create ${a.path}`;
    case 'move_file': return `Move ${a.path} → ${a.to}`;
    case 'copy_file': return `Copy ${a.path} → ${a.to}`;
    case 'git_status': return 'Show git status';
    case 'git_diff': return `Show the diff${a.staged ? ' (staged)' : ''}`;
    case 'git_log': return 'Show recent commits';
    case 'git_show': return `Show ${a.ref}`;
    case 'git_stage': return `Stage ${(a.paths || []).join(', ') || 'files'}`;
    case 'git_commit': return `Commit: ${(a.message || '').slice(0, 60)}`;
    case 'git_branch': return `git branch ${a.action || 'list'}${a.name ? ' ' + a.name : ''}`;
    case 'delete_file': return `Delete ${a.path}`;
    case 'run_command': return `Run: ${a.command}`;
    case 'ssh_exec': return `On ${a.host || '?'}: ${a.command || ''}`;
    case 'http_fetch': return `Fetch ${a.url}`;
    default: return tool.name;
  }
}/**
 * Validate one call against the registry. This is the security boundary: the
 * model supplies plain text, and nothing reaches an executor until it has
 * passed through here. Unknown tools, unknown arguments, wrong types and
 * oversized strings are all rejected with a message the model can act on.
 */
function validateArgs(tool, raw) {
  if (!tool) return { ok: false, error: 'Unknown tool.' };
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'Tool arguments must be an object.' };
  }

  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(tool.args, key)) {
      return { ok: false, error: `Unknown argument "${key}" for ${tool.name}. Allowed: ${Object.keys(tool.args).join(', ') || 'none'}.` };
    }
  }

  const out = {};
  for (const [key, decl] of Object.entries(tool.args)) {
    const { type, optional } = parseArgType(decl);
    const v = args[key];

    if (v === undefined || v === null || v === '') {
      if (optional) continue;
      return { ok: false, error: `Missing required argument "${key}" for ${tool.name}.` };
    }

    switch (type) {
      case 'string': {
        if (typeof v !== 'string') return { ok: false, error: `Argument "${key}" must be a string.` };
        if (v.includes('\0')) return { ok: false, error: `Argument "${key}" must not contain NUL bytes.` };
        if (v.length > LIMITS.ARG_STRING) {
          return { ok: false, error: `Argument "${key}" is too long (max ${LIMITS.ARG_STRING} characters).` };
        }
        if (/^(path|to|other_path)$/.test(key) && v.length > LIMITS.PATH_CHARS) {
          return { ok: false, error: `Argument "${key}" is too long to be a path.` };
        }
        if (key === 'content' || key === 'body' || key === 'new_string') {
          if (v.split('\n').length > LIMITS.ARG_LINES) {
            return { ok: false, error: `Argument "${key}" has too many lines (max ${LIMITS.ARG_LINES}).` };
          }
        }
        out[key] = v;
        break;
      }
      case 'number': {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          return { ok: false, error: `Argument "${key}" must be a finite number.` };
        }
        out[key] = n;
        break;
      }
      case 'boolean': {
        if (typeof v !== 'boolean') return { ok: false, error: `Argument "${key}" must be true or false.` };
        out[key] = v;
        break;
      }
      case 'array': {
        if (!Array.isArray(v)) return { ok: false, error: `Argument "${key}" must be an array.` };
        if (v.length > LIMITS.PATHS_PER_CALL) {
          return { ok: false, error: `Argument "${key}" has too many entries (max ${LIMITS.PATHS_PER_CALL}).` };
        }
        if (key === 'edits') {
          const bad = v.find(e => !e || typeof e !== 'object' || Array.isArray(e));
          if (bad !== undefined) return { ok: false, error: 'Each entry in "edits" must be { old_string, new_string }.' };
          if (v.find(e => typeof e.old_string !== 'string' || e.old_string === '')) {
            return { ok: false, error: 'Each entry in "edits" needs a non-empty "old_string".' };
          }
          if (v.find(e => typeof e.new_string !== 'string')) {
            return { ok: false, error: 'Each entry in "edits" needs a "new_string" (use "" to delete).' };
          }
          if (v.length > LIMITS.EDITS_PER_CALL) {
            return { ok: false, error: `At most ${LIMITS.EDITS_PER_CALL} edits per call.` };
          }
        }
        if (v.find(x => typeof x !== 'string' || x.length > LIMITS.PATH_CHARS)) {
          return { ok: false, error: `Argument "${key}" must be a list of short strings.` };
        }
        out[key] = v.slice();
        break;
      }
      case 'object': {
        if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `Argument "${key}" must be an object.` };
        if (Object.keys(v).length > 20) return { ok: false, error: `Argument "${key}" has too many keys.` };
        out[key] = v;
        break;
      }
      default:
        return { ok: false, error: `Argument "${key}" has an unsupported declared type (${type}).` };
    }
  }

  return { ok: true, args: out };
}/**
 * The manual appended to the system prompt when tools are on. Rendered from
 * the registry itself, so it cannot drift from what the main process accepts.
 */
function manual() {
  const titles = {
    files: 'Files', search: 'Search', project: 'Project',
    git: 'Version control', shell: 'Shell', net: 'Network', ssh: 'SSH'
  };
  const byGroup = new Map();
  for (const t of TOOLS) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(t);
  }
  const groups = [...byGroup].map(([group, tools]) => {
    const lines = tools.map(t => `- ${signature(t)} — ${t.summary} Returns: ${t.returns}`);
    return (titles[group] || group) + ':\n' + lines.join('\n');
  });

  return [
    '',
    '## Tools',
    '',
    'You can act on this machine. To do it, write one directive per line in your',
    'reply, each on its own line, exactly in this shape:',
    '',
    '[[tool {"name":"read_file","args":{"path":"README.md"}}]]',
    '[[tool {"name":"edit_file","args":{"path":"src/app.js","old_string":"foo","new_string":"bar"}}]]',
    '',
    'Rules:',
    '- One directive per line. Text outside a directive line is your normal reply.',
    '- Only the tools listed below exist. Never invent a tool name.',
    '- Results come back as tool messages: read them before your next step, and adapt when one failed.',
    '- Work in parallel with no per-reply limit: put every independent call in the same reply — reads and searches run together instead of one round-trip each. Run as many as the task needs; only split across replies when one call needs the result of another.',
    '- Never re-read a file you just wrote, edited, or created — the result already confirms it. Re-read only after something else changed it (a command run, a git operation).',
    '- Read cheaply: pass start_line/end_line for large files, find_paths locates files and folders by name, and search (search_files/grep_files) reads contents instead of opening every file in a folder.',
    '- Use the dedicated file tools instead of run_command for reads and writes — they are capped, show diffs in the approval prompt, and cost fewer rounds.',
    '- Prefer edit_file over write_file — an exact snippet beats rewriting a whole file.',
    '- Look before you leap: read a file before editing it, and run the project tests or build when they exist.',
    '- Do it yourself: when the user asks you to find, read, run, check, build or search for something, call a tool and report the result — never answer with commands or steps for the user to run instead.',
    '- Anything that writes, deletes, runs a command or uses the network asks the user first. Say what you are about to do, and explain what changed when the results arrive.',
    '- Paths are relative to the project root. Never guess a path you have not listed or read.',
    '- SSH runs only on hosts saved in Settings → SSH: pass the host id or label in `host`. You cannot type an address, a user or a password yourself.',
    '- The file and search tools stay inside the project root. For anything outside it — another folder or the whole machine — use run_command: only its working directory is pinned to the root, the command itself can go anywhere, and the user approves it first.',
    '',
    ...groups
  ].join('\n');
}

/**
 * Appended to the system prompt of a chat that has NO tools. Without it the
 * model doesn't know it is tool-less: it answers "here is how you find a
 * file" tutorials instead of saying it cannot act.
 */
function toolsOffNote() {
  return 'Tools are off in this chat: you cannot read files, search or run anything on this machine. When the user asks you to do just that, say so plainly and tell them to turn on the Tools switch above the composer and pick a workspace folder in Settings → Assistant.';
}

module.exports = {
  RISK, RISK_ORDER, LIMITS, TOOLS,
  toolByName, toolNames, toolsByRisk,
  parseArgType, signature, callSummary, validateArgs, manual, toolsOffNote
};