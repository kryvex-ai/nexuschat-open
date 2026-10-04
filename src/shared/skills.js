'use strict';

/**
 * Skills & Plugins — NexusChat Open's prompt-level capability layer.
 *
 * A SKILL is a named, self-contained instruction block ("lead with the
 * answer", "show your working") that is appended to the system prompt of a
 * chat and of every bot run it is attached to.
 *
 * A PLUGIN is a curated pack that ships with the app. Enabling a plugin
 * enables all of its skills. Packs are bundled here in the source tree —
 * the app never downloads or executes third-party code, so "installing" a
 * skill can't run anything on the PC. Skills are DATA for the model.
 *
 * Untrusted input can never inject prompt text: callers pass skill *ids*,
 * and every id is validated against this registry (unknown ids are dropped),
 * so a hand-edited settings file or a server payload cannot smuggle
 * instructions into a prompt. The composed block is also capped, so the
 * context window can't be blown up by enabling everything.
 */

const SKILL_ID_MAX = 48;          // max length of one skill id
const SKILL_ACTIVE_MAX = 12;      // max skills that actually apply to a prompt
const SKILL_PROMPT_MAX = 1600;    // max total chars of composed instructions

/* --- packs (plugins) ------------------------------------------------- */
const PLUGIN_DEFS = [
  { id: 'writing', name: 'Writing pack', tagline: 'Answers that read like a person wrote them: short, clear, structured.' },
  { id: 'developer', name: 'Developer pack', tagline: 'Code-first answers, honest debugging and explanations that teach.' },
  { id: 'ops', name: 'Operations pack', tagline: 'Built for scheduled bots: summaries, risks and next actions.' },
  { id: 'rigour', name: 'Accuracy pack', tagline: 'Say when you are unsure, show your working, never invent facts.' }
];

/* --- skills ---------------------------------------------------------- */
const SKILLS = [
  {
    id: 'concise', name: 'Concise answers', plugin: 'writing', category: 'Style',
    blurb: 'Lead with the answer; drop filler and hedging.',
    instructions: 'Lead with the answer. Keep replies short: no preamble, no restating the question, no filler or hedging.'
  },
  {
    id: 'plain-english', name: 'Plain English', plugin: 'writing', category: 'Style',
    blurb: 'Short sentences, common words, jargon explained once.',
    instructions: 'Write in plain English with short sentences and common words. If a technical term is unavoidable, explain it once in the same sentence.'
  },
  {
    id: 'structured', name: 'Scannable structure', plugin: 'writing', category: 'Format',
    blurb: 'Short headings and bullets when they help scanning.',
    instructions: 'When a reply has more than one idea, structure it with short Markdown headings or bullets so it can be scanned. Do not add structure to a one-line answer.'
  },

  {
    id: 'code-first', name: 'Code first', plugin: 'developer', category: 'Code',
    blurb: 'Answer with complete, runnable code in fenced blocks.',
    instructions: 'Answer with complete, runnable code in fenced code blocks, then at most a couple of sentences of explanation. Never leave placeholders like "rest of the code here".'
  },
  {
    id: 'explain-code', name: 'Explain the code', plugin: 'developer', category: 'Code',
    blurb: 'Say what the code does, then how to change it.',
    instructions: 'Before giving code, briefly say what the current code does and why the change is needed. Keep the explanation to the parts that are non-obvious.'
  },
  {
    id: 'debug-method', name: 'Debugging method', plugin: 'developer', category: 'Code',
    blurb: 'Symptom, likely causes, smallest fix.',
    instructions: 'For bugs: restate the symptom in one line, list the most likely causes in order, then give the smallest change that tests the most likely cause first.'
  },

  {
    id: 'summarise-first', name: 'Summary first', plugin: 'ops', category: 'Reports',
    blurb: 'Open with a two-line summary, then the detail.',
    instructions: 'Open with a one or two line summary of the outcome, then give the detail underneath. The summary must stand on its own.'
  },
  {
    id: 'flag-risks', name: 'Flag risks', plugin: 'ops', category: 'Reports',
    blurb: 'Call out risks, blockers and anything needing a human.',
    instructions: 'Always call out risks, blockers and anything that needs a human decision, even when nothing has failed yet. If there are none, say "no blockers" explicitly.'
  },
  {
    id: 'next-actions', name: 'End with next actions', plugin: 'ops', category: 'Reports',
    blurb: 'Finish with concrete next steps.',
    instructions: 'End every report with a short "Next" list of concrete actions, each starting with a verb. If nothing needs doing, write "Next: nothing required".'
  },

  {
    id: 'cite-uncertainty', name: 'State uncertainty', plugin: 'rigour', category: 'Accuracy',
    blurb: 'Mark what is known vs. guessed.',
    instructions: 'Distinguish clearly between what you know and what you are inferring. Say "I am not sure" instead of presenting a guess as fact.'
  },
  {
    id: 'show-working', name: 'Show the working', plugin: 'rigour', category: 'Accuracy',
    blurb: 'Show the key steps for sums and reasoning.',
    instructions: 'For calculations and multi-step reasoning, show the key steps so the result can be checked. Do not pad with every trivial step.'
  },
  {
    id: 'no-invention', name: 'Never invent facts', plugin: 'rigour', category: 'Accuracy',
    blurb: 'No made-up numbers, quotes, URLs or sources.',
    instructions: 'Never invent facts, numbers, quotes, URLs, file paths or sources. If the input does not contain what is needed, ask for it or say what is missing.'
  }
];

/** Packs with their member skill ids derived from SKILLS (never drifts). */
const PLUGINS = PLUGIN_DEFS.map(p => ({
  ...p,
  skills: SKILLS.filter(s => s.plugin === p.id).map(s => s.id),
  skillCount: SKILLS.filter(s => s.plugin === p.id).length
}));

function skillById(id) {
  return SKILLS.find(s => s.id === id) || null;
}

function pluginById(id) {
  return PLUGINS.find(p => p.id === id) || null;
}

/** Skill ids provided by one pack ([] for an unknown pack). */
function skillsForPlugin(id) {
  const p = pluginById(id);
  return p ? [...p.skills] : [];
}

/**
 * Keep only known skill ids from an untrusted list: strings, deduped,
 * length-capped, unknown/duplicate ids dropped. This is the security
 * boundary — free text never reaches a prompt through here.
 */
function validSkillIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim().slice(0, SKILL_ID_MAX);
    if (!id || seen.has(id) || !skillById(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The skills active for a scope: enabled packs plus individually enabled ids. */
function resolveSkillIds(settings = {}) {
  const s = (settings && typeof settings === 'object') ? settings : {};
  const packs = Array.isArray(s.enabledPlugins) ? s.enabledPlugins : [];
  const fromPacks = packs.flatMap(id => skillsForPlugin(typeof id === 'string' ? id : ''));
  const picked = Array.isArray(s.enabledSkills) ? s.enabledSkills : [];
  return validSkillIds([...fromPacks, ...picked]);
}

/**
 * Compose the instruction block appended to a system prompt.
 * Returns '' when nothing is active, so callers can cheaply skip it.
 */
function composeSkillPrompt(ids) {
  const active = validSkillIds(ids).slice(0, SKILL_ACTIVE_MAX);
  if (!active.length) return '';
  const lines = [];
  let used = 0;
  for (const id of active) {
    const s = skillById(id);
    const line = '- ' + s.name + ': ' + s.instructions;
    if (used + line.length > SKILL_PROMPT_MAX) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const block = 'Active skills — apply them to every reply:\n' + lines.join('\n');
  // Defence in depth: directive syntax must never survive into a prompt, so a
  // skill can't be crafted to make a bot emit [[bot {...}]] tool calls. The
  // shipped registry contains none of this today.
  return block.replace(/\[\[/g, '[ [');
}

/** Display names of the given skill ids (for UI badges), in registry order. */
function skillNames(ids) {
  return validSkillIds(ids).map(id => skillById(id).name);
}

module.exports = {
  SKILLS, PLUGINS, SKILL_ID_MAX, SKILL_ACTIVE_MAX, SKILL_PROMPT_MAX,
  skillById, pluginById, skillsForPlugin, validSkillIds, resolveSkillIds,
  composeSkillPrompt, skillNames
};
