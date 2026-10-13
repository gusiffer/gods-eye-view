/**
 * Local LLM voice configuration — the one place operator env is resolved.
 *
 * Voice can run without OpenAI: `GEV_VOICE_BACKEND=openwebui` points the
 * session at a local Open WebUI instance (OpenAI-compatible chat completions,
 * Whisper STT, TTS) with Ollama as the tool-calling failover. The OpenAI
 * Realtime path is untouched; this module is only read by the local pipeline
 * and by the HUD summary when the local backend is selected.
 *
 * Upstream safety: both URLs come from operator env (`GEV_OPENWEBUI_URL`,
 * `GEV_OLLAMA_URL`), never from the browser, so they carry operator-level
 * trust like `LOCAL_RECEIVER_FEEDS`. They are still validated to an
 * http(s) origin on a loopback / RFC1918 / `localhost` / `*.local` host so a
 * mistyped value cannot quietly turn the dev server into a relay to a public
 * host. Only an origin (scheme, host, optional port) is accepted.
 */

import { isLocalIpv4 } from '../../../src/data/tapAddress.js';

export const VOICE_BACKEND_OPENAI = 'openai';
export const VOICE_BACKEND_OPENWEBUI = 'openwebui';

export const VOICE_BACKENDS = Object.freeze([
  VOICE_BACKEND_OPENAI,
  VOICE_BACKEND_OPENWEBUI,
]);

export const DEFAULT_OPENWEBUI_URL = 'http://127.0.0.1:8080';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
/**
 * Defaults chosen on the authoring box after latency measurement
 * (2026-10-11): glm-5.3-flash:cloud answers GEV tool calls in well under a
 * second, while large open-weight text models (Hermes 3 class) spend
 * minutes reasoning over the ~30 tool schemas. Override with GEV_LLM_MODEL.
 */
export const DEFAULT_LLM_MODEL = 'glm-5.3-flash:cloud';
export const DEFAULT_LLM_FALLBACK_MODEL = 'qwen3:8b';

/** Per-IP, per-minute cap for the local LLM routes when env leaves it unset. */
export const LLM_DEFAULT_PER_MIN = 60;

/** Hard byte ceilings for proxied payloads. */
export const LLM_CHAT_MAX_BODY_BYTES = 512 * 1024;
export const LLM_CHAT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LLM_TRANSCRIBE_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const LLM_SPEECH_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Upstream deadlines: local generation can be slow on purpose. */
export const LLM_CHAT_TIMEOUT_MS = 90_000;
export const LLM_TRANSCRIBE_TIMEOUT_MS = 30_000;
export const LLM_SPEECH_TIMEOUT_MS = 60_000;

const MDNS_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*\.local$/;

/**
 * Whether a URL host is allowed as a local LLM upstream:
 * loopback IPv4, the IPv6 loopback, RFC1918 ranges, `localhost` and `*.local`.
 */
export function isLocalUpstreamHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (value === 'localhost' || value === '::1') return true;
  if (MDNS_RE.test(value)) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return isLocalIpv4(mapped ? mapped[1] : value);
}

/**
 * Parse one operator-supplied upstream URL. Returns `{ url }` or `{ reason }`;
 * never throws, so a bad `GEV_OPENWEBUI_URL` is a logged configuration error,
 * not a crash at import time.
 *
 * @param {string} name Env var name, for error messages.
 * @param {unknown} value Raw env value.
 */
export function parseUpstreamUrl(name, value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return { name, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { name, reason: 'scheme must be http or https' };
  if (url.username || url.password)
    return { name, reason: 'credentials are not allowed in the URL' };
  if (!isLocalUpstreamHost(url.hostname))
    return {
      name,
      reason: 'host must be loopback, RFC1918, localhost or *.local',
    };
  if (url.pathname && url.pathname !== '/')
    return { name, reason: 'only an origin is accepted (no path)' };
  if (url.search || url.hash)
    return { name, reason: 'query and fragment are not allowed' };
  return { name, url: url.origin };
}

/**
 * Resolve the local-voice configuration once per handler construction (the
 * same cadence as OPENAI_API_KEY reads: .env values are on process.env by the
 * time the Vite config hook constructs the plugins).
 *
 * @param {Record<string, string|undefined>} [env] Defaults to process.env.
 * @returns {{
 *   backend: 'openai'|'openwebui',
 *   openwebui: {configured: boolean, url?: string, reason?: string},
 *   ollama: {configured: boolean, url?: string, reason?: string},
 *   model: string,
 *   fallbackModel: string,
 * }}
 */
export function resolveLlmConfig(env = process.env) {
  const backendRaw = String(env.GEV_VOICE_BACKEND ?? '')
    .trim()
    .toLowerCase();
  const backend = VOICE_BACKENDS.includes(backendRaw)
    ? backendRaw
    : VOICE_BACKEND_OPENAI;

  const webuiValue = String(env.GEV_OPENWEBUI_URL ?? '').trim();
  const openwebui = webuiValue
    ? parseUpstreamUrl('GEV_OPENWEBUI_URL', webuiValue)
    : { name: 'GEV_OPENWEBUI_URL', url: DEFAULT_OPENWEBUI_URL };
  const ollamaValue = String(env.GEV_OLLAMA_URL ?? '').trim();
  const ollama = ollamaValue
    ? parseUpstreamUrl('GEV_OLLAMA_URL', ollamaValue)
    : { name: 'GEV_OLLAMA_URL', url: DEFAULT_OLLAMA_URL };

  return {
    backend,
    openwebui: {
      configured: Boolean(openwebui.url),
      ...(openwebui.url ? { url: openwebui.url } : { reason: openwebui.reason }),
    },
    ollama: {
      configured: Boolean(ollama.url),
      ...(ollama.url ? { url: ollama.url } : { reason: ollama.reason }),
    },
    model: String(env.GEV_LLM_MODEL ?? '').trim() || DEFAULT_LLM_MODEL,
    fallbackModel:
      String(env.GEV_LLM_FALLBACK_MODEL ?? '').trim() ||
      DEFAULT_LLM_FALLBACK_MODEL,
  };
}

/**
 * Whether the selected voice backend is the local pipeline. Useful for
 * diagnostics and tests; the client decides its transport from
 * `/api/llm/status`, and the HUD module resolves via its factory instead.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function localVoiceSelected(env = process.env) {
  return resolveLlmConfig(env).backend === VOICE_BACKEND_OPENWEBUI;
}