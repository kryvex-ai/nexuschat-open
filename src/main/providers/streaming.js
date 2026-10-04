'use strict';

/**
 * Streaming response parsers (pure, no Electron imports — unit-testable).
 * Operate on WHATWG ReadableStream bodies (global fetch in Node >= 18 / Electron main).
 */

/** How long a stream may go without a single byte before it counts as stalled. */
const STREAM_STALL_MS = 90000;

/**
 * Async-iterate `body`'s chunks, throwing if no chunk arrives within `ms`.
 * Resets the timer on every chunk. Releases the reader on stall/exit so the
 * underlying socket can be cleaned up (the fetch abort signal, when present,
 * closes it outright). Pass the result into iterateSSE/NDJSON.
 */
async function* withStallTimeout(body, ms = STREAM_STALL_MS, onStall) {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error('Stream stalled: no data for ' + Math.round(ms / 1000) + 's — the provider may be overloaded. Try again.');
          e.code = 'ESTALL';
          if (typeof onStall === 'function') { try { onStall(); } catch { /* ignore */ } }
          reject(e);
        }, ms);
        if (timer.unref) timer.unref();
      });
      let read;
      try {
        read = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (read.done) return;
      yield read.value;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }
}

/** Split one raw SSE block into { event, data }; null when it carries no data. */
function parseSSEBlock(rawEvent) {
  let event = null;
  const dataLines = [];
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) continue; // SSE comment / keep-alive ping
    if (line.startsWith('event:')) event = line.slice(6).trim();
    // Tolerate CRLF senders: strip a trailing \r so '[DONE]\r' still matches.
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, '').replace(/\r$/, ''));
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

/** Yields { event, data } for each SSE event; events are separated by a blank line. */
async function* iterateSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  // Normalize CRLF senders (Azure-style) up front: event boundaries are
  // detected on '\n\n', which never appears in a pure '\r\n\r\n' stream.
  const normalize = (s) => s.replace(/\r\n/g, '\n');
  for await (const chunk of body) {
    buf = normalize(buf + decoder.decode(chunk, { stream: true }));
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseSSEBlock(rawEvent);
      if (parsed) yield parsed;
    }
  }
  // Flush: some servers end the stream without a trailing blank line.
  const tail = normalize(buf + decoder.decode());
  if (tail.includes('data:')) {
    const parsed = parseSSEBlock(tail);
    if (parsed) yield parsed;
  }
}

/** Yields one parsed JSON object per non-empty line (Ollama NDJSON streaming). */
async function* iterateNDJSON(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* skip malformed line */ }
    }
  }
  // Flush: a final line without a trailing newline is still a full object.
  const tail = (buf + decoder.decode()).trim();
  if (tail) {
    try { yield JSON.parse(tail); } catch { /* skip malformed tail */ }
  }
}

module.exports = { iterateSSE, iterateNDJSON, withStallTimeout, parseSSEBlock, STREAM_STALL_MS };
