/**
 * Local voice audio proxy: Whisper STT and TTS through Open WebUI.
 *
 *   POST /api/llm/transcribe — multipart form-data (field `file`, a short
 *     WAV clip recorded in the browser) forwarded to Open WebUI's
 *     `/api/v1/audio/transcriptions`; reply `{ text }`.
 *   POST /api/llm/speech — JSON `{ input, voice? }` forwarded to Open
 *     WebUI's `/api/v1/audio/speech`; the audio bytes are streamed back with
 *     the upstream content type.
 *
 * Both routes exist so the browser never holds the Open WebUI API key and
 * never speaks to the Open WebUI origin cross-origin (CSP `connect-src
 * 'self'` holds). Audio lives in memory only — the proxy persists nothing.
 */

import { readRequestBodyCapped } from '../common/request.js';
import {
  LLM_TRANSCRIBE_MAX_BODY_BYTES,
  LLM_SPEECH_MAX_RESPONSE_BYTES,
  LLM_TRANSCRIBE_TIMEOUT_MS,
  LLM_SPEECH_TIMEOUT_MS,
  resolveLlmConfig,
} from './config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_HEADERS['Content-Type']);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Require an Open WebUI upstream for the audio routes. Ollama has no STT/TTS
 * endpoints of its own, so when Open WebUI is unconfigured these routes fail
 * closed with one clear sentence.
 */
function requireOpenWebui(config, logger) {
  if (!config.openwebui.configured) {
    logger.warn(
      `[llm] GEV_OPENWEBUI_URL rejected (${
        config.openwebui.reason || 'not configured'
      }); local speech transcription/voice is unavailable.`,
    );
    return null;
  }
  return config.openwebui.url;
}

/** Shared auth + upstream call. Returns parsed JSON or throws. */
async function forwardToWebui({
  url,
  path,
  apiKey,
  headers,
  body,
  timeoutMs,
  maxResponseBytes,
  fetchImpl,
}) {
  if (!apiKey)
    throw Object.assign(new Error('OPENWEBUI_API_KEY_MISSING'), {
      clientMessage: 'Open WebUI voice needs OPENWEBUI_API_KEY — add it in Provider Settings',
      status: 503,
    });
  const response = await fetchImpl(`${url}${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${apiKey}`, ...headers },
    body,
  });
  if (!response.ok) {
    await readResponseTextCappedSafe(response);
    if (response.status === 401 || response.status === 403)
      throw Object.assign(new Error('OPENWEBUI_AUTH_FAILED'), {
        clientMessage: 'Open WebUI rejected the API key — update it in Provider Settings',
        status: 502,
      });
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      clientMessage: 'Open WebUI audio request failed',
      status: 502,
    });
  }
  return response;
}

async function readResponseTextCappedSafe(response) {
  try {
    return await readResponseTextCappedSafeBody(response);
  } catch {
    return '';
  }
}

function readResponseTextCappedSafeBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return Promise.resolve('');
  const chunks = [];
  const limited = async () => {
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 4096) {
        void reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  return limited();
}

/** Build the POST /api/llm/transcribe handler (multipart passthrough). */
export function createLlmTranscribeHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  resolveApiKey = () => String(process.env.OPENWEBUI_API_KEY ?? '').trim(),
  timeouts = {},
} = {}) {
  const config = resolveLlmConfig(env);
  const upstreamUrl = requireOpenWebui(config, logger);
  const timeoutMs = timeouts.transcribe ?? LLM_TRANSCRIBE_TIMEOUT_MS;

  return async function handleLlmTranscribe(req, res) {
    if (!upstreamUrl) {
      json(res, 503, {
        error: 'Local speech transcription needs Open WebUI configured',
      });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      json(res, 400, { error: 'Expected a multipart audio upload' });
      return;
    }
    let audio;
    try {
      audio = await readRequestBodyCapped(req, LLM_TRANSCRIBE_MAX_BODY_BYTES);
    } catch (error) {
      json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: error?.code === 'BODY_TOO_LARGE' ? 'Audio clip too large' : 'Audio upload failed',
      });
      return;
    }
    try {
      const response = await forwardToWebui({
        url: upstreamUrl,
        path: '/api/v1/audio/transcriptions',
        apiKey: resolveApiKey(),
        headers: { 'Content-Type': contentType },
        body: audio,
        timeoutMs,
        fetchImpl,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text: String(text || '').trim() };
      }
      json(res, 200, {
        text: String(payload?.text ?? '').trim(),
        ...(payload?.model ? { model: String(payload.model) } : {}),
      });
    } catch (error) {
      // req.destroyed is also true after a normal body read (async-iteration
      // destroy), so the socket/response decide whether the client is gone.
      if (res.writableEnded || res.socket?.destroyed) return;
      logger.warn(`[llm] transcribe failed: ${error?.message || error}`);
      json(res, error?.status || 502, {
        error: error?.clientMessage || 'Open WebUI audio request failed',
      });
    }
  };
}

/** Build the POST /api/llm/speech handler (TTS bytes passthrough). */
export function createLlmSpeechHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  resolveApiKey = () => String(process.env.OPENWEBUI_API_KEY ?? '').trim(),
  timeouts = {},
} = {}) {
  const config = resolveLlmConfig(env);
  const upstreamUrl = requireOpenWebui(config, logger);
  const timeoutMs = timeouts.speech ?? LLM_SPEECH_TIMEOUT_MS;

  return async function handleLlmSpeech(req, res) {
    if (!upstreamUrl) {
      json(res, 503, { error: 'Local speech synthesis needs Open WebUI configured' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readRequestBodyCapped(req, 64 * 1024));
    } catch (error) {
      json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: 'Invalid speech request body',
      });
      return;
    }
    const input = String(body?.input ?? '').trim();
    if (!input) {
      json(res, 400, { error: 'Speech request requires input text' });
      return;
    }
    try {
      const response = await forwardToWebui({
        url: upstreamUrl,
        path: '/api/v1/audio/speech',
        apiKey: resolveApiKey(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: input.slice(0, 2000),
          ...(typeof body?.voice === 'string' && body.voice
            ? { voice: body.voice.slice(0, 80) }
            : {}),
        }),
        timeoutMs,
        fetchImpl,
      });
      const contentType =
        response.headers.get('content-type') || 'audio/mpeg';
      const buffer = await readResponseBytesCappedSafe(
        response,
        LLM_SPEECH_MAX_RESPONSE_BYTES,
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(buffer.byteLength));
      res.end(buffer);
    } catch (error) {
      // req.destroyed is also true after a normal body read (async-iteration
      // destroy), so the socket/response decide whether the client is gone.
      if (res.writableEnded || res.socket?.destroyed) return;
      logger.warn(`[llm] speech failed: ${error?.message || error}`);
      json(res, error?.status || 502, {
        error: error?.clientMessage || 'Open WebUI audio request failed',
      });
    }
  };
}

/** Read capped bytes without the shared helper's error semantics. */
async function readResponseBytesCappedSafe(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error('AUDIO_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** GET /api/llm/status — what the client needs before wiring the adapter. */
export function createLlmStatusHandler({ env = process.env, logger = console } = {}) {
  return function handleLlmStatus(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    const config = resolveLlmConfig(env);
    const webuiUsable = Boolean(
      config.openwebui.configured &&
        String(env?.OPENWEBUI_API_KEY ?? '').trim(),
    );
    const local = webuiUsable || config.ollama.configured;
    if (!local && (config.openwebui.reason || config.ollama.reason))
      logger.warn(
        `[llm] status: no upstream is usable (${
          config.openwebui.reason || config.ollama.reason
        })`,
      );
    json(res, 200, {
      // enabled only when the local pipeline can answer a chat turn somehow.
      enabled: local,
      backend: config.backend,
      chat: {
        openwebui: webuiUsable,
        ollama: config.ollama.configured,
      },
      stt: { openwebui: webuiUsable },
      tts: {
        openwebui: webuiUsable,
        browserFallback: true,
      },
      // The primary model only matters when Open WebUI can actually serve it;
      // without the key the chat traffic fails over to Ollama.
      model: webuiUsable ? config.model : null,
      fallbackModel: config.ollama.configured ? config.fallbackModel : null,
      ...(config.openwebui.reason ? { configError: config.openwebui.reason } : {}),
      ...(config.ollama.reason ? { failoverError: config.ollama.reason } : {}),
    });
  };
}