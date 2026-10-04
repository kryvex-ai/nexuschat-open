'use strict';

/**
 * The agent turn.
 *
 * One user message can turn into several model turns: the model asks for a
 * tool, the tool runs (after permission), the result goes back in the prompt,
 * and the model decides what to do next. This module owns that loop and
 * nothing else — every dependency comes in from outside, which is what lets
 * the loop be unit-tested with a fake model and a fake tool host.
 *
 * Hard limits, all of them settings the user can lower:
 *   - maxSteps       — tool rounds per user message (default 12, cap 25)
 *   - one call at a time, in the order the model wrote them
 *   - a stop request (Esc, closing the window) ends the loop at the next step
 *   - the loop ends the moment a reply contains no tool directive
 */

const { manual } = require('../shared/tools');
const { parseToolCalls, resultsToPrompt } = require('./tools');

const DEFAULT_MAX_STEPS = 12;
const MAX_STEPS_CAP = 25;

/** The system prompt when tools are on: the user's prompt, skills, then the tool manual. */
function agentSystemPrompt(basePrompt) {
  return [basePrompt, manual()].filter(Boolean).join('\n');
}

/** Conversation history as prompt messages, tool results included verbatim. */
function historyOf(conv) {
  return (conv.messages || [])
    .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    .map(m => ({ role: m.role, content: m.content }));
}

/** What the renderer needs to draw one activity row. */
function publicResult(r) {
  return {
    tool: r.tool,
    risk: r.risk,
    summary: r.summary,
    ok: r.ok === true,
    denied: r.denied === true,
    error: r.error ? String(r.error).slice(0, 400) : null,
    preview: r.ok ? String(r.result || '').slice(0, 1200) : null
  };
}

/**
 * Run one user turn to completion.
 *
 * store      — the Store (messages are persisted as they happen, so a crash
 *              mid-turn leaves the conversation readable)
 * host       — ToolHost
 * streamText — async ({ messages, signal }) => async iterable of deltas
 * basePrompt — the user's system prompt + skills (already composed)
 */
async function runAgentTurn({
  store,
  host,
  streamText,
  conversationId,
  basePrompt = '',
  temperature = 0.7,
  maxTokens = null,
  maxSteps = DEFAULT_MAX_STEPS,
  signal = null,
  isCurrent = () => true,
  emit = () => {}
}) {
  const steps = Math.min(MAX_STEPS_CAP, Math.max(1, Math.floor(Number(maxSteps) || DEFAULT_MAX_STEPS)));
  const system = agentSystemPrompt(basePrompt);
  let rounds = 0;
  let stopped = false;
  let last = null;

  while (rounds < steps) {
    if (!isCurrent()) { stopped = true; break; }
    if (signal && signal.aborted) { stopped = true; break; }

    const conv = store.getConversation(conversationId);
    if (!conv) break;

    let acc = '';
    try {
      for await (const delta of streamText({
        messages: [{ role: 'system', content: system }, ...historyOf(conv)],
        signal
      })) {
        acc += String(delta || '');
        if (isCurrent()) emit('chat:delta', { conversationId, delta });
      }
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
      if (aborted) {
        stopped = true;
        break;
      }
      emit('chat:error', { conversationId, message: String(err.message || err) });
      return { rounds, stopped: true, error: String(err.message || err) };
    }

    rounds++;
    const { text, calls } = parseToolCalls(acc);

    // Persist what the user should read before anything else happens.
    if (text.trim()) {
      last = store.appendMessage(conversationId, { role: 'assistant', content: text });
    } else if (!calls.length) {
      last = store.appendMessage(conversationId, { role: 'assistant', content: '(no reply)' });
    }

    if (!calls.length) {
      emit('chat:done', { conversationId, message: last, aborted: false });
      return { rounds, stopped: false, message: last };
    }

    emit('tool:plan', {
      conversationId,
      calls: calls.map(c => ({ id: c.id, name: c.name }))
    });

    const results = await host.invokeMany(calls, { shouldStop: () => !isCurrent() || (signal && signal.aborted) });
    for (const r of results) {
      store.appendMessage(conversationId, {
        role: 'tool',
        content: resultsToPrompt([r]),
        meta: { tool: r.tool, ok: r.ok === true, denied: r.denied === true }
      });
    }
    emit('tool:result', { conversationId, results: results.map(publicResult) });

    if (!isCurrent() || (signal && signal.aborted)) { stopped = true; break; }
  }

  // Step cap or a stop: say so rather than ending in silence.
  const reason = stopped
    ? 'Stopped — you asked me to, or the chat was closed.'
    : `That is ${steps} tool steps in one turn (the limit). Ask me to continue if there is more to do.`;
  const note = store.appendMessage(conversationId, { role: 'assistant', content: reason });
  emit('chat:done', { conversationId, message: note, aborted: stopped });
  return { rounds, stopped, message: note };
}

module.exports = {
  runAgentTurn, agentSystemPrompt, historyOf, publicResult,
  DEFAULT_MAX_STEPS, MAX_STEPS_CAP
};