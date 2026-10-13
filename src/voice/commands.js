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
  return bindVoiceCommands({
    ...options,
    createSession,
  });
}
