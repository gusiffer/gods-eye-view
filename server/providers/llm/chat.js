/**
 * POST /api/llm/chat — one OpenAI-shaped chat completion against the local
 * pipeline, with a failover chain.
 *
 *   primary:  Open WebUI  `${GEV_OPENWEBUI_URL}/api/chat/completions`
 *             (OpenAI-compatible; brokered by the API key the panel saves)
 *   failover: Ollama      `${GEV_OLLAMA_URL}/api/chat` (native tools format)
 *             with `GEV_LLM_FALLBACK_MODEL` — e.g. an Ollama cloud model, so
 *             voice keeps working even with the GPU stack down.
 *
 * Both upstreams receive the SAME request shape (OpenAI `messages` +
 * `tools`, which Ollama's /api/chat accepts verbatim) and both answers are
 * normalized to one client contract:
 *
 *   { message: {role:'assistant', content: string,
 *               tool_calls?: [{id, name, arguments: string}]},
 *     backend, model, fallback?: true, usage?: object }
 *
 * The browser never touches either upstream: the Open WebUI key and the
 * Ollama URL stay server-side, exactly like every other brokered credential.
 * Errors are sanitized; upstream wording (which carries URLs and quota
 * phrasing) never reaches the client.
 */

import { readRequestBody } from '../common/request.js';
import { readResponseTextCapped } from '../common/http.js';
import {
  LLM_CHAT_TIMEOUT_MS,
  LLM_CHAT_MAX_BODY_BYTES,
  LLM_CHAT_MAX_RESPONSE_BYTES,
  resolveLlmConfig,
  VOICE_BACKEND_OPENWEBUI,
} from './config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_HEADERS['Content-Type']);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Convert Ollama-native tool_call arguments (object) to a JSON string. */
function normalizeToolArgumentString(argumentsValue) {
  if (typeof argumentsValue === 'string') return argumentsValue;
  if (argumentsValue == null) return '{}';
  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return '{}';
  }
}

/** Normalize one message's tool_calls across both upstream shapes. */
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return undefined;
  const calls = toolCalls
    .map((call, index) => {
      const fn = call?.function || {};
      const name = String(fn.name || call?.name || '').trim();
      if (!name) return null;
      return {
        id: String(call?.id || `call_${index}`),
        name,
        arguments: normalizeToolArgumentString(fn.arguments ?? call?.arguments),
      };
    })
    .filter(Boolean);
  return calls.length ? calls : undefined;
}

/**
 * Normalize either upstream's reply to one client contract. Accepts an
 * OpenAI chat-completions body (`choices[0].message`) or an Ollama
 * /api/chat body (`message`). Content may be missing when the model went
 * straight to tools.
 */
export function normalizeChatReply(data, { backend, model, fallback }) {
  const message =
    data?.choices?.[0]?.message || (data?.message ? { ...data.message } : null);
  if (!message || typeof message !== 'object')
    throw new Error('Upstream reply had no assistant message');
  const content =
    typeof message.content === 'string' ? message.content : '';
  const toolCalls = normalizeToolCalls(message.tool_calls);
  return {
    message: {
      role: 'assistant',
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
    backend,
    model: String(data?.model || model || ''),
    ...(fallback ? { fallback: true } : {}),
    ...(data?.usage && typeof data.usage === 'object'
      ? { usage: data.usage }
      : {}),
  };
}

/** One upstream call. Resolves to parsed JSON or throws on any failure. */
async function callUpstream(url, path, { headers, body, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(`${url}${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await readResponseTextCapped(response, 4096).catch(() => '');
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const data = JSON.parse(
    await readResponseTextCapped(
      response,
      LLM_CHAT_MAX_RESPONSE_BYTES,
    ),
  );
  return data;
}

/**
 * Build the POST /api/llm/chat handler.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
 * @param {{warn:Function}} [options.logger]
 * @param {{openwebui?: string, ollama?: string}} [options.keys] Bearer keys;
 *   the Open WebUI key resolved from env by default (never logged, never sent
 *   to the browser).
 */
export function createLlmChatHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  resolveApiKey = () => String(process.env.OPENWEBUI_API_KEY ?? '').trim(),
  timeouts = {},
} = {}) {
  const config = resolveLlmConfig(env);
  if (config.openwebui.reason)
    logger.warn(
      `[llm] GEV_OPENWEBUI_URL rejected (${config.openwebui.reason}); Open WebUI voice is unavailable and Ollama failover only.`,
    );
  if (config.ollama.reason)
    logger.warn(
      `[llm] GEV_OLLAMA_URL rejected (${config.ollama.reason}); Ollama failover is unavailable.`,
    );
  const chatTimeoutMs = timeouts.chat ?? LLM_CHAT_TIMEOUT_MS;

  return async function handleLlmChat(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readRequestBody(req, LLM_CHAT_MAX_BODY_BYTES));
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        json(res, 413, { error: 'Chat request too large' });
        return;
      }
      json(res, 400, { error: 'Invalid chat request body' });
      return;
    }
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages?.length) {
      json(res, 400, { error: 'Chat request requires messages' });
      return;
    }
    const tools = Array.isArray(body?.tools) ? body.tools : undefined;
    const payload = {
      messages,
      ...(tools?.length
        ? { tools, tool_choice: typeof body.tool_choice === 'string' ? body.tool_choice : 'auto' }
        : {}),
      temperature: Number.isFinite(body?.temperature)
        ? Math.min(1.5, Math.max(0, Number(body.temperature)))
        : undefined,
    };

    const attempts = [];
    if (
      config.backend === VOICE_BACKEND_OPENWEBUI &&
      config.openwebui.configured
    ) {
      const key = resolveApiKey();
      if (key) {
        attempts.push({
          backend: VOICE_BACKEND_OPENWEBUI,
          label: 'openwebui',
          url: config.openwebui.url,
          path: '/api/chat/completions',
          model: config.model,
          headers: { Authorization: `Bearer ${key}` },
          body: { ...payload, model: config.model },
        });
      } else {
        logger.warn(
          '[llm] Open WebUI voice selected but OPENWEBUI_API_KEY is not set; using Ollama failover.',
        );
      }
    }
    if (config.ollama.configured) {
      // Failover: Ollama native with the fallback model. Also the only route
      // when Open WebUI is not selected/configured at all.
      attempts.push({
        backend: 'ollama',
        label: 'ollama',
        url: config.ollama.url,
        path: '/api/chat',
        model: config.fallbackModel,
        body: { ...payload, model: config.fallbackModel, stream: false },
      });
    }
    if (!attempts.length) {
      json(res, 503, { error: 'No local LLM upstream is configured' });
      return;
    }

    let lastError = null;
    for (const [index, attempt] of attempts.entries()) {
      try {
        const data = await callUpstream(attempt.url, attempt.path, {
          headers: attempt.headers,
          body: attempt.body,
          timeoutMs: chatTimeoutMs,
          fetchImpl,
        });
        const reply = normalizeChatReply(data, {
          backend: attempt.backend,
          model: attempt.model,
          fallback: index > 0,
        });
        json(res, 200, reply);
        return;
      } catch (error) {
        lastError = error;
        // Client gone mid-upstream? req.destroyed is also true after a NORMAL
        // body read (the stream iterator destroys it), so it cannot carry the
        // cancellation decision — the socket and the response are authoritative.
        if (res.writableEnded || res.socket?.destroyed) return;
        logger.warn(
          `[llm] ${attempt.label} (${attempt.model}) failed: ${error?.message || error}`,
        );
      }
    }
    json(res, 502, { error: 'Local LLM request failed' });
    void lastError;
  };
}