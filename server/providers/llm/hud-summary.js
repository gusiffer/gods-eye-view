/**
 * HUD summary through the local LLM.
 *
 * The five-word contract lives in `HUD_SUMMARY_INSTRUCTIONS` (one shared
 * definition with the OpenAI path). The local pipeline swaps only the
 * transport: a chat-completions turn against Open WebUI, with the same
 * five-word post-processing (strip punctuation, keep the first five words).
 * Feed-state tokens are enforced downstream by `hudSummaryMatchesProvenance`
 * on the client, exactly as for the OpenAI path.
 */

import { HUD_SUMMARY_INSTRUCTIONS } from '../../../src/hudSummaryResponse.js';
import {
  resolveLlmConfig,
  VOICE_BACKEND_OPENWEBUI,
  LLM_CHAT_TIMEOUT_MS,
} from './config.js';

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/**
 * The local HUD resolver, or null when the selected backend is not the local
 * pipeline. The caller falls back to the OpenAI branch, which stays
 * byte-for-byte unchanged when the local backend is not selected.
 */
export function createLocalHudSummaryResolver({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  resolveApiKey = () => String(process.env.OPENWEBUI_API_KEY ?? '').trim(),
  timeoutMs = LLM_CHAT_TIMEOUT_MS,
} = {}) {
  const config = resolveLlmConfig(env);
  if (config.backend !== VOICE_BACKEND_OPENWEBUI) return null;
  if (!config.openwebui.configured || !config.ollama.configured) {
    logger.warn(
      '[hud-summary] local backend selected but no reachable upstream is configured; HUD summaries will fail closed.',
    );
  }

  async function callChat(body) {
    let response;
    try {
      response = await fetchImpl(
        `${config.openwebui.url}/api/chat/completions`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${resolveApiKey()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    } catch (primaryError) {
      // Same failover chain as voice: Ollama native with the fallback model.
      // Covers network rejection AND a non-OK primary answer alike.
      const fallback = await fetchImpl(`${config.ollama.url}/api/chat`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          model: config.fallbackModel,
          stream: false,
        }),
      }).catch(() => {
        throw primaryError;
      });
      if (!fallback.ok)
        throw Object.assign(new Error(`HTTP ${fallback.status}`), {
          status: fallback.status,
        });
      const data = await fallback.json().catch(() => ({}));
      // Normalize the Ollama-native shape into the chat-completions shape the
      // resolver reads below.
      return { choices: [{ message: data?.message || {} }] };
    }
    return response.json();
  }

  return async function resolveLocalHudSummary(context) {
    // Local HUD costs nothing upstream: it is "keyless" in the same sense the
    // OpenAI path's free path is, so no paid-endpoint quota logic applies.
    const data = await callChat({
      model: config.model,
      stream: false,
      messages: [
        { role: 'system', content: HUD_SUMMARY_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify(context) },
      ],
      max_tokens: 32,
      temperature: 0,
    });
    const message = data?.choices?.[0]?.message;
    const text =
      typeof message?.content === 'string'
        ? message.content
        : String(data?.message?.content ?? '');
    return toFiveWordHudSummary(text);
  };
}