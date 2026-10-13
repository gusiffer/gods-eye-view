# Local voice control — Open WebUI + Ollama

Voice control without an OpenAI key: the GEV MIC panel runs its whole loop
against your own Open WebUI / Ollama stack. Selected with
`GEV_VOICE_BACKEND=openwebui` in `.env` (see `.env.example` for the full
block). The OpenAI Realtime path is untouched — unset the variable and
everything behaves exactly as documented in the README.

## What runs where

| Step | OpenAI path (default) | Local path (`GEV_VOICE_BACKEND=openwebui`) |
| --- | --- | --- |
| Speech input | Realtime API, server-side semantic VAD | Browser energy VAD → WAV clip |
| Transcription | Realtime API (same session) | Open WebUI Whisper — `/api/llm/transcribe` |
| Agent + ~30 tools | OpenAI Realtime tool calls | `GEV_LLM_MODEL` through Open WebUI `/api/chat/completions` — `/api/llm/chat` |
| Reply speech | Realtime API audio | Open WebUI TTS — `/api/llm/speech` |
| Failover | — | Ollama native `/api/chat` with `GEV_LLM_FALLBACK_MODEL` |
| HUD summary line | OpenAI `gpt-5-nano` | The same local model, same five-word contract |

The browser never sees the Open WebUI key; all three `/api/llm/*` routes are
same-site-gated and per-IP throttled (`GEV_RATELIMIT_LLM_PER_MIN`, default
60/min) like every other brokered proxy. Upstream URLs must be
loopback/RFC1918/`localhost`/`*.local` — mistyped values are refused at
startup, logged, and the route fails closed.

## The adapter

`src/voice/localVoiceSession.js` implements the same adapter contract as the
Realtime controller (`src/voice/session.js`), so the voice card, captions,
plan steps, referents, pointer context (`pointer_context` items), Radio
handoff and the whole `~30` action-tool catalog are shared. `GEV_MIC`
behavior: click toggles; speak; pause to end a turn; the reply plays through
Open WebUI's TTS; speak while it talks to barge in.

**Push-to-talk (hold Space) is OpenAI-path only** — the local session is
open-mic. The tier/cost controls hide (local compute has no token bill).

## Deliberate differences

- No viewport screenshots in context (small local models are text-only
  here); `get_entity_context`'s structured labels still ground the view.
- No retention_ratio/truncation machinery: the adapter keeps the last 40
  messages and the system prompt, which is sized for small-context models.
- Inline `<tool_call>` blocks some models emit are parsed as tool calls
  and stripped from speech, defensively.
- Errors fail loudly: a down Open WebUI surfaces one clear sentence in the
  voice error tray, then chat fails over to Ollama automatically.

## Model choice

A tool-calling model is required. Measured on the workstation this config
was written for (one `get_weather` tool round):

| Model | Tool-call round |
| --- | --- |
| `glm-5.3-flash:cloud` (Ollama, via your signed-in account) | **0.6 s** |
| `qwen3:8b` (local Ollama) | fast, local failover |
| `hermes3:latest` through Open WebUI, warm | **8–10 s** (small schemas) |
| `hermes3:latest` local Ollama, `~30` tool schemas | **171 s cold / >240 s warm** |

The fork's default is `glm-5.3-flash:cloud` for voice with a `qwen3:8b`
local failover — both set in `.env` (`GEV_LLM_MODEL`,
`GEV_LLM_FALLBACK_MODEL`) and baked in as code defaults. Large open-weight
text models (Hermes 3 class) spend minutes reasoning over the ~30 tool
schemas; that is a model and schema cost, not an endpoint cost, so keep them
off the voice path — the same model is fine for chat and MCP work where
there is no tool schema in front. Plain small chat models (llama3.2-class)
are fine for navigation commands but weaker at the analyst tool schema.

## Disk health (why nothing grows)

- The mic clip exists only in browser memory: Float32 slices → one WAV
  `ArrayBuffer` → POST → released. Nothing is written.
- The server proxy buffers requests/responses in memory and persists
  nothing.
- The one artifact is the pre-existing debug log
  `.gev-logs/realtime-conversations.jsonl`: rotated at 32 MB (never
  expired), and transcripts/tool payloads stay omitted unless
  `GEV_VOICE_LOG_CONTENT=1`.
- Open WebUI does not persist API-key chat completions as chats and Whisper
  transcriptions are processed in memory. GLM cloud routing stores nothing
  locally.

## Requirements checklist

1. Open WebUI ≥ 0.6 reachable at `GEV_OPENWEBUI_URL` (default
   `http://127.0.0.1:8080`).
2. An Open WebUI **API key** — Settings ▸ Account ▸ API keys — saved as
   `OPENWEBUI_API_KEY` (or POWER UP ▸ OPEN WEBUI in the app).
3. Open WebUI **audio engines** configured for Whisper STT and a TTS engine
   (Admin Settings ▸ Audio). Verified 2026-10-11 on the authoring box: chat
   completions with tools worked out of the box, but `/api/v1/audio/speech`
   answered 404 and transcriptions returned `{text: ""}` until an STT/TTS
   engine is configured — the endpoints respond regardless, so GEV surfaces
   "speech engine unavailable" in the card instead of a hard error. Use
   Admin Settings ▸ Audio: set local Whisper for STT and any engine (Built-in,
   OpenAI-compatible endpoint, Azure…) for TTS.
4. For the failover, Ollama at `GEV_OLLAMA_URL` (default
   `http://127.0.0.1:11434`) with the fallback model pulled (`qwen3:8b` by
   default — a plain local model, no account needed; a `:cloud` fallback
   model instead would need your Ollama account signed in). The failover
   uses Ollama's native `/api/chat`, which returns the same tool-call shape
   as the proxy's Open WebUI route.

## Testing it

- `GET /api/llm/status` — what the adapter sees
  (`{"enabled":true,"backend":"openwebui",...}`).
- `curl -s -X POST http://localhost:4173/api/llm/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Say OK"}]}'`
  should answer through Open WebUI (or the Ollama failover, with
  `"fallback":true`).
- `curl -s -X POST http://localhost:4173/api/llm/speech -H 'Content-Type: application/json' -d '{"input":"Radio check"}' --output check.mp3`
  must be playable audio.
- Then click GEV MIC and say "take me to Austin".

Unit tests for the shared pieces live beside the modules
(`src/voice/localVoice*` and the `src/*llm*` proxy tests), run with
`npm test`.