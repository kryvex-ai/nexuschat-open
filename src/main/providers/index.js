'use strict';

const { iterateSSE, iterateNDJSON, withStallTimeout } = require('./streaming');
const brand = require('../../shared/brand');

/* ------------------------------------------------------------------ */
/* Resilient transport: every request gets a timeout, and idempotent   */
/* reads/retries ride out 429s + 5xx + dropped connections.            */
/* ------------------------------------------------------------------ */

/** Total time a single HTTP round-trip may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 30000;
/** Time a model-listing / connection-test fetch may take. */
const LIST_TIMEOUT_MS = 15000;

/** Combine the caller's abort signal with a timeout into one signal.
 *  Returns { signal, done } — call done() once headers arrive (streaming) or
 *  the body is fully read, so the timer can't kill a healthy long stream. */
function combinedSignal(signal, ms) {
  if (!signal) return { signal: AbortSignal.timeout(ms), done() {} };
  if (signal.aborted) return { signal, done() {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(
    Object.assign(new Error('Request timed out after ' + Math.round(ms / 1000) + 's'), { name: 'TimeoutError' })
  ), ms);
  if (timer.unref) timer.unref();
  const onAbort = () => { clearTimeout(timer); ctrl.abort(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done() { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function retryAfterMs(res, attempt) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 60000);
  const d = h ? Date.parse(h) : NaN;
  if (Number.isFinite(d)) return Math.min(Math.max(d - Date.now(), 0), 60000);
  return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

function retryableError(e) {
  const msg = String((e && e.message) || e);
  return e && (e.name === 'TimeoutError' || /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network/i.test(msg));
}

/**
 * fetch() with a timeout and retries on 429/5xx + network blips.
 * The timeout bounds time-to-headers; streaming callers then own the body
 * (guarded by withStallTimeout), small-JSON callers should use fetchJson.
 * opts: { timeoutMs, retries, signal, ...fetchOpts }
 */
async function fetchResilient(url, opts = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, retries = 2, signal, ...rest } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const link = combinedSignal(signal, timeoutMs);
    let res = null;
    try {
      res = await fetch(url, { ...rest, signal: link.signal });
    } catch (e) {
      link.done();
      lastErr = e;
      if (signal && signal.aborted) throw e; // user cancelled — never retry
      if (attempt < retries && retryableError(e)) { await sleep(Math.min(500 * 2 ** attempt, 4000)); continue; }
      throw e;
    }
    link.done(); // headers arrived — the stream/body is governed from here on
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      try { await res.arrayBuffer(); } catch { /* release the socket */ }
      await sleep(retryAfterMs(res, attempt));
      continue;
    }
    return res;
  }
  throw lastErr;
}

/**
 * fetchResilient for small JSON APIs (model listings, info probes): the SAME
 * timeout bounds connect + headers + body, so a trickling response can't
 * hang a connection test forever. Returns the parsed JSON (assertOk applied).
 */
async function fetchJson(url, opts = {}) {
  const { timeoutMs = LIST_TIMEOUT_MS, retries = 2, signal, ...rest } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const link = combinedSignal(signal, timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: link.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        try { await res.arrayBuffer(); } catch { /* release the socket */ }
        link.done();
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      await assertOk(res);
      const data = await res.json();
      link.done();
      return data;
    } catch (e) {
      link.done();
      lastErr = e;
      if (signal && signal.aborted) throw e; // user cancelled — never retry
      const statusRetry = e && (e.status === 429 || (typeof e.status === 'number' && e.status >= 500));
      if (attempt < retries && (statusRetry || retryableError(e))) {
        await sleep(Math.min(500 * 2 ** attempt, 4000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Merge provider config from settings with registry defaults. */
function resolveConfig(provider, pcfg) {
  const base = ((pcfg && pcfg.baseUrl) || '').trim() || provider.base || '';
  return {
    base: base.replace(/\/+$/, ''),
    apiKey: ((pcfg && pcfg.apiKey) || '').trim()
  };
}

async function assertOk(res) {
  if (res.ok) return;
  let detail = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = (j.error && (j.error.message || (typeof j.error === 'string' && j.error))) || j.message || t;
    } catch { detail = t; }
  } catch { /* ignore */ }
  // Sanitize provider echo (keys/tokens) but keep the HTTP prefix intact.
  let suffix = '';
  if (detail) {
    const clean = sanitizeError(String(detail).slice(0, 400));
    suffix = ': ' + (typeof clean === 'string' ? clean : String((clean && clean.message) || ''));
  }
  const e = new Error(`HTTP ${res.status} ${res.statusText}${suffix}`);
  e.status = res.status;
  throw e;
}

/* Redact key-like material from provider error text. */
function sanitizeText(s) {
  let out = String(s);
  out = out.replace(/sk-[A-Za-z0-9_-]{4,}/g, '[redacted]');
  out = out.replace(/xox[bap]-[A-Za-z0-9_-]{4,}/g, '[redacted]');
  out = out.replace(/ghp_[A-Za-z0-9_-]{4,}/g, '[redacted]');
  out = out.replace(/gsk_[A-Za-z0-9_-]{4,}/g, '[redacted]');
  out = out.replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
  out = out.replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1[redacted]');
  out = out.replace(/(key\s*[:=]\s*['"]?)[A-Za-z0-9_-]{8,}/gi, '$1[redacted]');
  return out;
}

/* Sanitize an error or string, preserving shape (status/code/name). */
function sanitizeError(err) {
  if (typeof err === 'string') return sanitizeText(err);
  if (err instanceof Error) {
    const out = new Error(sanitizeText(err.message));
    out.name = err.name;
    if (err.status !== undefined) out.status = err.status;
    if (err.code !== undefined) out.code = err.code;
    for (const k of Object.keys(err)) {
      if (!(k in out)) { try { out[k] = err[k]; } catch { /* ignore */ } }
    }
    return out;
  }
  if (err && typeof err.message === 'string') {
    return { ...err, message: sanitizeText(err.message) };
  }
  return err;
}

/* ------------------------------------------------------------------ */
/* Message format converters (pure, unit-testable)                     */
/* ------------------------------------------------------------------ */

function toOpenAI(messages) {
  return messages.map(m => ({ role: m.role, content: m.content }));
}

function mergeSameRole(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toAnthropic(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  let msgs = mergeSameRole(
    messages.filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  );
  if (msgs.length && msgs[0].role !== 'user') msgs = [{ role: 'user', content: '(continue)' }, ...msgs];
  return { system: system || undefined, messages: msgs };
}

function toGoogle(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = mergeSameRole(
    messages.filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  );
  if (contents.length && contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
  return { systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, contents };
}

/* ------------------------------------------------------------------ */
/* Stream adapters                                                     */
/* ------------------------------------------------------------------ */

async function post(url, headers, body, signal) {
  const res = await fetchResilient(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
    // Chat POSTs are safe to retry while no response arrived yet: a 429/5xx
    // means the provider rejected the request, nothing was generated.
    retries: 2
  });
  await assertOk(res);
  return res;
}

/** OpenAI-compatible SSE (OpenAI, xAI/Grok, Mistral, Groq, DeepSeek, OpenRouter, custom, our server). */
async function* openAICompatStream(url, headers, body, signal) {
  const res = await post(url, headers, body, signal);
  for await (const { data } of iterateSSE(withStallTimeout(res.body))) {
    if (data === '[DONE]') return;
    if (!data) continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error((j.error && j.error.message) || 'stream error');
    const c = j.choices && j.choices[0];
    const delta = c && ((c.delta && (c.delta.content !== undefined ? c.delta.content : c.delta.reasoning_content)) || c.text);
    if (delta) yield delta;
  }
}

/** Anthropic Messages SSE. */
async function* anthropicStream(url, headers, body, signal) {
  const res = await post(url, headers, body, signal);
  for await (const { event, data } of iterateSSE(withStallTimeout(res.body))) {
    if (!data) continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.type === 'error') throw new Error((j.error && j.error.message) || 'anthropic stream error');
    if (event === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') yield j.delta.text;
    else if (event === 'message_stop') return;
  }
}

/** Google Gemini streamGenerateContent SSE. */
async function* googleStream(url, headers, body, signal) {
  const res = await post(url, headers, body, signal);
  for await (const { data } of iterateSSE(withStallTimeout(res.body))) {
    if (!data) continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error(j.error.message || 'gemini stream error');
    const cand = j.candidates && j.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    if (parts) {
      const t = parts.map(p => p.text || '').join('');
      if (t) yield t;
    }
  }
}

/** Ollama local NDJSON streaming (works fully offline). */
async function* ollamaStream(url, body, signal) {
  const res = await post(url, {}, body, signal);
  for await (const j of iterateNDJSON(withStallTimeout(res.body))) {
    if (j.error) throw new Error(j.error);
    if (j.message && j.message.content) yield j.message.content;
    if (j.done) return;
  }
}

/* ------------------------------------------------------------------ */
/* Unified chat dispatch                                               */
/* ------------------------------------------------------------------ */

/**
 * Yields text deltas for a chat request.
 * req: { messages, model, temperature, maxTokens, signal }
 * pcfg: { apiKey, baseUrl }
 */
async function* streamChat(provider, pcfg, req) {
  const { base, apiKey } = resolveConfig(provider, pcfg);
  const signal = req.signal;
  const temperature = typeof req.temperature === 'number' ? req.temperature : undefined;

  switch (provider.kind) {
    case 'openai': {
      if (provider.requiresBaseUrl && !base) throw new Error(`"${provider.name}" needs a base URL — set it in the Providers tab.`);
      if (!apiKey && !provider.offline && !provider.requiresBaseUrl) throw new Error(`Add your ${provider.name} API key in the Providers tab (or use Ollama / a local custom endpoint — they answer from your own machine and need no key).`);
      const headers = {};
      if (apiKey) headers.authorization = 'Bearer ' + apiKey;
      if (provider.id === 'openrouter') {
        headers['HTTP-Referer'] = 'https://nexuschat.local';
        headers['X-Title'] = brand.APP_NAME;
      }
      yield* openAICompatStream(
        base + '/chat/completions',
        headers,
        { model: req.model, messages: toOpenAI(req.messages), stream: true, temperature, max_tokens: req.maxTokens || undefined },
        signal
      );
      return;
    }
    case 'anthropic': {
      if (!apiKey) throw new Error('Add your Anthropic API key in the Providers tab.');
      const { system, messages } = toAnthropic(req.messages);
      yield* anthropicStream(
        base + '/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        { model: req.model, max_tokens: req.maxTokens || 4096, stream: true, temperature, system, messages },
        signal
      );
      return;
    }
    case 'google': {
      if (!apiKey) throw new Error('Add your Google AI (Gemini) API key in the Providers tab.');
      const { systemInstruction, contents } = toGoogle(req.messages);
      yield* googleStream(
        `${base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
        { 'x-goog-api-key': apiKey },
        { contents, systemInstruction, generationConfig: { temperature, maxOutputTokens: req.maxTokens || undefined } },
        signal
      );
      return;
    }
    case 'ollama': {
      const options = {};
      if (typeof temperature === 'number') options.temperature = temperature;
      if (typeof req.maxTokens === 'number' && req.maxTokens > 0) options.num_predict = Math.floor(req.maxTokens);
      yield* ollamaStream(
        base + '/api/chat',
        { model: req.model, messages: toOpenAI(req.messages), stream: true, options },
        signal
      );
      return;
    }
    default:
      throw new Error(`Unknown provider kind: ${provider.kind}`);
  }
}

/* ------------------------------------------------------------------ */
/* Model listing / connection tests                                    */
/* ------------------------------------------------------------------ */

async function listModels(provider, pcfg) {
  const { base, apiKey } = resolveConfig(provider, pcfg);
  const get = (url, headers) => fetchJson(url, { headers, timeoutMs: LIST_TIMEOUT_MS, retries: 2 });
  if (provider.kind === 'ollama') {
    const j = await get(base + '/api/tags');
    return (j.models || []).map(m => m.name);
  }
  if (provider.kind === 'google') {
    const j = await get(base + '/v1beta/models?pageSize=200', { 'x-goog-api-key': apiKey });
    return (j.models || [])
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(n => n && !/embedding|aqa/i.test(n));
  }
  if (provider.kind === 'anthropic') {
    const j = await get(base + '/v1/models?limit=100', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
    return (j.data || []).map(m => m.id);
  }
  // openai-compatible
  const j = await get(base + '/models', apiKey ? { authorization: 'Bearer ' + apiKey } : {});
  return ((j.data || []).map(m => m.id).filter(Boolean)).sort();
}

/** Connection test: never throws, returns { ok, detail }. */
async function testProvider(provider, pcfg) {
  try {
    const models = await listModels(provider, pcfg);
    return { ok: true, detail: `OK — ${models.length} model(s) available` };
  } catch (e) {
    return { ok: false, detail: e.message || String(e) };
  }
}

module.exports = {
  resolveConfig, toOpenAI, toAnthropic, toGoogle,
  streamChat, listModels, testProvider, assertOk, sanitizeError,
  fetchResilient, fetchJson, combinedSignal, REQUEST_TIMEOUT_MS, LIST_TIMEOUT_MS
};
