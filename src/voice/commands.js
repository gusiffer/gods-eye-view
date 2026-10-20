import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createLocalVoiceSession } from './localVoiceSession.js';

/**
 * Default composition; callers may supply another session adapter factory.
 * `GEV_VOICE_BACKEND=openwebui` (surfaced as `options.voiceMode`) swaps the
 * OpenAI Realtime WebRTC transport for the local pipeline: Open WebUI
 * Whisper STT, an Open WebUI/Ollama tool-calling model and Open WebUI TTS.
 * Everything else — the session harness, voice card, actions and referents —
 * is shared.
 */
export function createVoiceCommands(options) {
  const createSession =
    options.createSession ||
    (options.voiceMode === 'openwebui'
      ? createLocalVoiceSession
      : createRealtimeSession);
import { createGeminiSession } from './geminiSession.js';
import { createProviderCommands } from './providerCommands.js';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options = {}) {
  // Generic hosts retain the existing default; standalone opts in explicitly.
  if (!options.createSession && options.supportedProviders !== undefined)
    return createProviderCommands(options, {
      bind: bindVoiceCommands,
      factories: { openai: createRealtimeSession, gemini: createGeminiSession },
    });
  return bindVoiceCommands({
    ...options,
    createSession,
  });
}
