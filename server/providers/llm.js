/**
 * Vite plugin: local LLM voice routes.
 *
 *   POST /api/llm/chat        — Open WebUI chat completions w/ Ollama failover
 *   POST /api/llm/transcribe  — Open WebUI Whisper STT (multipart passthrough)
 *   POST /api/llm/speech      — Open WebUI TTS (audio bytes passthrough)
 *   GET  /api/llm/status      — adapter capability probe
 *
 * All four are sameSite-gated like the other cost-bearing proxies, and the
 * three POST routes share one per-IP limiter (GEV_RATELIMIT_LLM_PER_MIN,
 * default 60). Nothing here is used by the OpenAI Realtime path.
 */

import { enforceRateLimit } from './openai/rate-limit.js';
import { makeLlmRateLimiter } from './common/rate-limit.js';
import { sameSiteGated } from './common/same-site.js';
import { createLlmChatHandler } from './llm/chat.js';
import {
  createLlmTranscribeHandler,
  createLlmSpeechHandler,
  createLlmStatusHandler,
} from './llm/audio.js';

function createLlmProxy() {
  const chat = createLlmChatHandler();
  const transcribe = createLlmTranscribeHandler();
  const speech = createLlmSpeechHandler();
  const status = createLlmStatusHandler();
  const gated = {
    chat: sameSiteGated((req, res) => {
      if (!enforceRateLimit(makeLlmRateLimiter(), req, res)) return;
      return chat(req, res);
    }),
    transcribe: sameSiteGated((req, res) => {
      if (!enforceRateLimit(makeLlmRateLimiter(), req, res)) return;
      return transcribe(req, res);
    }),
    speech: sameSiteGated((req, res) => {
      if (!enforceRateLimit(makeLlmRateLimiter(), req, res)) return;
      return speech(req, res);
    }),
    status: sameSiteGated(status),
  };
  function install(middlewares) {
    middlewares.use('/api/llm/chat', gated.chat);
    middlewares.use('/api/llm/transcribe', gated.transcribe);
    middlewares.use('/api/llm/speech', gated.speech);
    middlewares.use('/api/llm/status', gated.status);
  }
  return {
    name: 'llm-voice-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export { createLlmProxy };