'use strict';

/**
 * Provider registry shared by main process, renderer and tests.
 * kind: 'openai'    -> OpenAI-compatible /chat/completions + SSE  (covers most providers)
 * kind: 'anthropic' -> Anthropic /v1/messages SSE
 * kind: 'google'    -> Gemini :streamGenerateContent SSE
 * kind: 'ollama'    -> local Ollama /api/chat NDJSON (truly offline)
 *
 * Every provider's base URL and model list is user-editable in the UI,
 * so endpoints can be corrected/extended without shipping a new build.
 */
const PROVIDERS = [
  {
    id: 'openai', name: 'OpenAI', kind: 'openai',
    base: 'https://api.openai.com/v1',
    defaultModels: ['gpt-5-mini', 'gpt-5', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    notes: 'GPT models. Bring your own key.'
  },
  {
    id: 'xai', name: 'xAI — Grok', kind: 'openai',
    base: 'https://api.x.ai/v1',
    defaultModels: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.1-fast-reasoning'],
    notes: 'Grok models. OpenAI-compatible endpoint.'
  },
  {
    id: 'anthropic', name: 'Anthropic — Claude', kind: 'anthropic',
    base: 'https://api.anthropic.com',
    defaultModels: ['claude-sonnet-4-5', 'claude-opus-4-1-20250805', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    notes: 'Native Messages API with SSE streaming.'
  },
  {
    id: 'google', name: 'Google — Gemini', kind: 'google',
    base: 'https://generativelanguage.googleapis.com',
    defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    notes: 'Gemini API (streamGenerateContent).'
  },
  {
    id: 'mistral', name: 'Mistral', kind: 'openai',
    base: 'https://api.mistral.ai/v1',
    defaultModels: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    notes: ''
  },
  {
    id: 'groq', name: 'Groq', kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    notes: 'Very fast open models, generous free tier.'
  },
  {
    id: 'deepseek', name: 'DeepSeek', kind: 'openai',
    base: 'https://api.deepseek.com',
    defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    notes: 'OpenAI-compatible endpoint (no /v1 suffix). deepseek-chat/reasoner are legacy aliases.'
  },
  {
    id: 'openrouter', name: 'OpenRouter', kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    defaultModels: [
      'nousresearch/hermes-3-llama-3.1-405b',
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen-2.5-72b-instruct',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini'
    ],
    notes: '400+ models (incl. Hermes) behind one key.'
  },
  {
    id: 'nous', name: 'Nous Research — Hermes', kind: 'openai',
    base: 'https://inference-api.nousresearch.com/v1',
    defaultModels: ['Hermes-3-Llama-3.1-405B', 'Hermes-3-Llama-3.1-70B'],
    notes: 'Direct Hermes endpoint (beta). Base URL is editable; OpenRouter also carries Hermes.'
  },
  {
    id: 'ollama', name: 'Ollama — Local (offline)', kind: 'ollama',
    base: 'http://localhost:11434', offline: true,
    defaultModels: ['hermes3', 'llama3.2', 'qwen2.5', 'mistral-nemo'],
    notes: 'Runs models on this PC. Truly offline and free — install Ollama, then `ollama pull hermes3`.'
  },
  {
    id: 'custom', name: 'Custom — OpenAI-compatible', kind: 'openai',
    base: '', requiresBaseUrl: true, defaultModels: [],
    notes: 'LM Studio, vLLM, llama.cpp server, Together, Fireworks, Perplexity… set the base URL.'
  }
];

module.exports = { PROVIDERS };
