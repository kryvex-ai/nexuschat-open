'use strict';

/**
 * The model picker's logic, kept out of app.js so it can be unit-tested on
 * plain Node: which providers are offered, how the list narrows, and which
 * "providerId::model" value survives a provider disappearing.
 *
 * The UMD shim is because there are two hosts and no bundler: the renderer
 * loads this as a plain <script> (it never gets Node), and the test suite
 * requires it. One implementation, no copy that can drift.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexusModels = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * A provider the picker may offer: switched on, and carrying what it needs
   * to answer — a saved key, a local runtime, or a self-hosted base URL.
   */
  function isUsable(p) {
    if (!p) return false;
    const cfg = p.config || {};
    if (cfg.enabled === false) return false;
    return !!(cfg.hasKey || p.offline || (p.requiresBaseUrl && cfg.baseUrl));
  }

  /**
   * [{ id, label, models }] — one entry per ready provider, in registry order.
   * A fetched list wins over the shipped defaults; a provider with neither is
   * left out entirely rather than shown as an empty group.
   */
  function modelGroups(providers) {
    const out = [];
    for (const p of providers || []) {
      if (!isUsable(p)) continue;
      const cfg = p.config || {};
      const models = (cfg.models && cfg.models.length) ? cfg.models : (p.defaultModels || []);
      if (models.length) out.push({ id: p.id, label: p.name, models: models.slice() });
    }
    return out;
  }

  /**
   * Narrow the list as the user types: every whitespace-separated term must
   * appear in the model name, so "gpt", "LLAMA 3" and "mistral nemo" all land
   * where a person would expect them. Only when no model name matches at all
   * do the terms get a second chance against the provider's name — that is
   * what makes "ollama" or "anthropic" show a whole group. Without the two
   * passes in this order, searching "llama" would keep every model under
   * "Ollama" and the filter would look broken.
   */
  function filterGroups(groups, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return groups || [];
    const terms = q.split(/\s+/);
    const keep = (haystackFn) => {
      const out = [];
      for (const g of groups || []) {
        const models = g.models.filter(m => terms.every(t => haystackFn(m, g, t)));
        if (models.length) out.push({ id: g.id, label: g.label, models });
      }
      return out;
    };
    const byName = keep((m, g, t) => m.toLowerCase().includes(t));
    if (byName.length) return byName;
    return keep((m, g, t) => (m + ' ' + g.label).toLowerCase().includes(t));
  }

  /** 'openai::gpt-5' -> { providerId: 'openai', model: 'gpt-5' }. */
  function splitSelection(value) {
    const v = String(value == null ? '' : value);
    const i = v.indexOf('::');
    return i < 0 ? { providerId: '', model: '' } : { providerId: v.slice(0, i), model: v.slice(i + 2) };
  }

  /**
   * Keep the saved choice while it still exists on the list; otherwise fall
   * back to the first model there is — never to an empty composer.
   */
  function resolveSelection(groups, wanted) {
    const w = String(wanted == null ? '' : wanted);
    if (w) {
      for (const g of groups || []) {
        for (const m of g.models) if (g.id + '::' + m === w) return w;
      }
    }
    const first = (groups || [])[0];
    return first ? first.id + '::' + first.models[0] : '';
  }

  /**
   * The value a freshly connected provider should be activated to: its own
   * first model, or '' when that provider brought no models with it.
   */
  function firstModelOf(groups, providerId) {
    const g = (groups || []).find(x => x.id === providerId);
    return g && g.models.length ? g.id + '::' + g.models[0] : '';
  }

  return { isUsable, modelGroups, filterGroups, splitSelection, resolveSelection, firstModelOf };
});
