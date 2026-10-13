/**
 * Local voice session adapter — OpenAI-free voice control.
 *
 * Same adapter contract as the Realtime controller (`start`, `stop`,
 * `sendText`, `sendMapEvent`) and the same provider-neutral session events,
 * so `session.js`, the voice card, the action runner, referents and the
 * pointer flow are reused untouched. Selected by `GEV_VOICE_BACKEND=openwebui`.
 *
 * Pipeline per turn:
 *   mic → VAD utterance → /api/llm/transcribe → transcript(user)
 *   → agent loop against /api/llm/chat (tools from the action schemas)
 *   → transcript(assistant) → /api/llm/speech playback
 *   → Radio handoff when a playback request actually asked for it.
 *
 * Deliberate differences from the cloud path (documented in
 * docs/LOCAL-VOICE.md): no push-to-talk (open mic with VAD), no viewport
 * screenshots (small local models are text-only here), no token-cost meter
 * (local compute is free; the tier/cost controls hide), barge-in by energy
 * VAD rather than server SpeechStarted.
 */

import { createActionTools } from './actionSchemas.js';
import { LOCAL_TOOL_HINTS, LOCAL_VOICE_INSTRUCTIONS } from './localVoicePrompt.js';
import { LocalVoiceAudio } from './localVoiceAudio.js';
import { pointerChip, pointerContextItem } from './pointerContext.js';

/** Tool rounds per user turn before the loop gives up and answers anyway. */
export const MAX_TOOL_ROUNDS = 6;

/** The pointer context is only worth including while it is fresh. */
const POINTER_RECENT_MS = 4000;

/**
 * Convert Hermes-style inline tool tags in the content into calls, and strip
 * them from the spoken text. Tolerant: models wrapped by Open WebUI should
 * already return `tool_calls`, but open models occasionally emit raw tags.
 *
 * @param {string} content Raw assistant content.
 * @returns {{toolCalls: Array<{id: string, name: string, arguments: string}>, text: string}}
 */
export function extractInlineToolCalls(content) {
  const text = String(content || '');
  const toolCalls = [];
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let index = 0;
  let match;
  while ((match = pattern.exec(text))) {
    try {
      const parsed = JSON.parse(match[1]);
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const call of calls) {
        const name = String(call?.name || call?.function?.name || '').trim();
        if (!name) continue;
        const args = call?.arguments ?? call?.function?.arguments ?? {};
        toolCalls.push({
          id: `inline_${++index}`,
          name,
          arguments:
            typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        });
      }
    } catch {
      // Malformed tag: leave it out of the speech, out of the call list.
    }
  }
  return {
    toolCalls,
    text: text.replace(pattern, '').trim(),
  };
}

/** One model-facing tool record with its local one-line hint. */
export function createLocalActionTools() {
  return createActionTools(
    Object.fromEntries(
      Object.entries(LOCAL_TOOL_HINTS).map(([name, hint]) => [
        name,
        { description: hint },
      ]),
    ),
  );
}

/**
 * Build the adapter factory for `createVoiceSession` / `createVoiceCommands`.
 * Receives the same hook bundle as the Realtime adapter.
 */
export function createLocalVoiceSession({
  emit,
  runAction,
  signal,
  runner,
  ui,
  radioLayer = null,
  dataManager = null,
  debugSink = null,
  pointer = null,
  fetchImpl = (...args) => fetch(...args),
  audio: createAudio,
} = {}) {
  const session = { active: false, turning: false, speakingAssistant: false, status: 'idle' };
  const debugLog = (event, payload = {}) => {
    try {
      debugSink?.({
        timestamp: new Date().toISOString(),
        sessionId: 'gev-local',
        event,
        status: session.status,
        payload,
      });
    } catch {
      /* diagnostics never break voice */
    }
  };

  const tools = createLocalActionTools();
  let audio = null;
  let statusCache = null;
  let chatAbort = null;
  let inFlightActions = new Set();
  const history = [];

  const setStatus = (status, detail) => {
    session.status = status;
    emit({ type: 'state', state: status, detail });
    if (ui?.root) ui.root.dataset.status = status;
  };

  const systemHistory = () => [
    { role: 'system', content: LOCAL_VOICE_INSTRUCTIONS },
  ];

  let lastRadioPlayback = null;

  /** Append one conversation item; bounded so context stays small. */
  const remember = (message) => {
    history.push(message);
    while (history.length > 40) history.shift();
  };

  async function readStatus() {
    if (statusCache) return statusCache;
    const response = await fetchImpl('/api/llm/status', {
      cache: 'no-store',
    }).catch(() => null);
    const data = await response?.json?.().catch(() => null);
    if (!response?.ok || !data)
      throw new Error('The dev server offers no local LLM endpoint — is GEV_VOICE_BACKEND set?');
    statusCache = data;
    return data;
  }

  /** Run one chat completion and normalize inline tool tags defensively. */
  async function complete(messages, options = {}) {
    const response = await fetchImpl('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        messages,
        ...(options.tools ? { tools: options.tools } : {}),
        temperature: 0.3,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(data?.error || `Local LLM failed: HTTP ${response.status}`);
    const inline = extractInlineToolCalls(data.message?.content);
    const rawCalls = data.message?.tool_calls?.length
      ? data.message.tool_calls
      : inline.toolCalls;
    const toolCalls = (rawCalls || [])
      .map((call) =>
        call?.function
          ? // Nested upstream shape: flatten here so the client tolerates a
            // proxy hop that skipped normalization.
            flattenToolCall(call)
          : call,
      )
      .filter(Boolean);
    if (!data.message && !toolCalls.length)
      throw new Error('Malformed local LLM reply');
    return {
      ...data,
      message: {
        role: 'assistant',
        content: inline.text,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      },
    };
  }

  /** Parse model tool-call arguments; never throws. */
  const parseArguments = (value) => {
    if (typeof value !== 'string' || !value) return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  };

  /** Flatten both tool-call shapes (OpenAI nested and proxy flat) to one. */
  const flattenToolCall = (call) => {
    const fn = call?.function || {};
    const name = String(fn.name || call?.name || '').trim();
    if (!name) return null;
    const args = fn.arguments ?? call?.arguments ?? {};
    return {
      id: String(call?.id || 'call'),
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    };
  };

  /**
   * One full turn through the model: tool rounds until it answers in text,
   * the cap hits, or the turn is cancelled.
   * @returns {Promise<string>} the assistant's spoken text ('' on give-up).
   */
  async function agentLoop(messages, { signal } = {}) {
    const localMessages = [...messages];
    let lastToolResult = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      abortIfCancelled(signal);
      const reply = await complete(localMessages, { tools, signal });
      const callList = reply.message.tool_calls || [];
      if (!callList.length) {
        return finalizeText(reply.message.content);
      }
      remember({ role: 'assistant', content: reply.message.content, tool_calls: callList });
      localMessages.push({
        role: 'assistant',
        content: reply.message.content || '',
        tool_calls: callList.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const [index, call] of callList.entries()) {
        abortIfCancelled(signal);
        const executed = await executeToolCall(call, `round${round}_${index}`, { signal });
        localMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(executed.resultJson),
        });
        if (executed.radioPlaybackRequested) {
          // Track the prepared playback for the post-speech handoff.
          lastRadioPlayback = executed.result;
          lastToolResult = executed;
          break;
        }
      }
      if (lastToolResult?.radioPlaybackRequested) {
        // Prepared playback: answer with the standard confirmation rather
        // than another model round; the handoff happens after playback.
        const text = 'Turning on the radio.';
        remember({ role: 'assistant', content: text });
        return text;
      }
      // Ask the model to speak the results now (mirrors the cloud follow-up).
      localMessages.push({
        role: 'system',
        content:
          'Respond now to the user about the tool results above. Speak each result say line once, briefly, and never claim anything that did not succeed.',
      });
    }
    return 'That took more steps than I can chain. Try a smaller request.';
  }

  function finalizeText(content) {
    const text = String(content || '').trim();
    remember({ role: 'assistant', content: text });
    return text;
  }

  /**
   * Execute one tool call through the shared action runner, emitting the
   * same action events the voice card and referents consume.
   */
  async function executeToolCall(call, tag, { signal } = {}) {
    const args = parseArguments(call.arguments);
    const callId = `${tag}_${call.name}`;
    const controller = new AbortController();
    inFlightActions.add(controller);
    try {
      const result = await runAction(call.name, args, {
        signal: AbortSignal.any([controller.signal, signal].filter(Boolean)),
        callId,
        isCurrent: () => !controller.signal.aborted,
      });
      debugLog('tool.result', { name: call.name, ok: result?.ok });
      return {
        resultJson: result ?? { ok: false, error: 'No result' },
        result,
        radioPlaybackRequested: Boolean(
          result?.ok && result?.radioPlaybackRequested,
        ),
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const resultJson = { ok: false, error: error?.message || 'Tool failed' };
      // Still report to the model so the loop can continue honestly.
      return { resultJson, result: resultJson, radioPlaybackRequested: false };
    } finally {
      inFlightActions.delete(controller);
    }
  }

  function abortIfCancelled(signal) {
    if (signal?.aborted)
      throw new DOMException('Voice turn cancelled', 'AbortError');
  }

  /** Pointer context injected as a system item, mirroring the cloud path. */
  function pointerContextMessage() {
    if (!pointer) return null;
    let snapshot = null;
    try {
      snapshot = pointer.beginTurn('text', { recentMs: POINTER_RECENT_MS });
    } catch {
      snapshot = null;
    }
    const chip = pointerChip(snapshot);
    const item = chip ? pointerContextItem(snapshot) : { target: 'none' };
    return { role: 'system', content: JSON.stringify(item) };
  }

  function emitPointerEvent(snapshot) {
    const chip = pointerChip(snapshot);
    emit({
      type: 'pointer',
      pointer: chip ? { ...chip, screenPx: snapshot.screenPx } : null,
    });
  }

  /** Handle one recognized user turn: STT text → model → speech. */
  async function runUserTurn(text, { signal } = {}) {
    abortIfCancelled(signal);
    emit({ type: 'interruption', reason: 'user-speech' });
    emitPointerEvent(pointer?.activeSnapshot?.() || null);
    emit({
      type: 'transcript',
      role: 'user',
      text,
      final: true,
      itemId: null,
    });
    debugLog('turn.user', { length: text.length });

    remember({ role: 'user', content: text });
    const pointerMessage = pointerContextMessage();
    const messages = [
      ...systemHistory(),
      ...history.slice(0, -1),
      ...(pointerMessage ? [pointerMessage] : []),
      { role: 'user', content: text },
    ];
    setStatus('executing', 'Running command');
    let spoken = '';
    let radioPending = false;
    try {
      spoken = await agentLoop(messages, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      debugLog('turn.error', { message: error?.message });
      spoken = `The local model failed: ${error?.message || 'unknown error'}`;
    }
    abortIfCancelled(signal);
    radioPending = Boolean(lastRadioPlayback);
    if (spoken) {
      emit({
        type: 'transcript',
        role: 'assistant',
        text: spoken,
        final: true,
        responseId: null,
      });
      setStatus('listening', 'Ask or command');
      emit({ type: 'completion', status: 'completed' });
      if (ui?.root) ui.root.dataset.speaker = 'ai';
      try {
        if (audio) await audio.speak(spoken);
        else await speakThroughFallback(spoken);
      } catch (speechError) {
        debugLog('tts.error', { message: speechError?.message });
        setStatus(
          'listening',
          'Reply shown in the voice card — speech engine unavailable',
        );
      } finally {
        if (ui?.root && ui.root.dataset.speaker === 'ai')
          ui.root.dataset.speaker = 'idle';
      }
    } else {
      setStatus('listening', 'Ask or command');
    }
    // Radio handoff after the spoken confirmation, mirroring the cloud path.
    if (radioPending) {
      lastRadioPlayback = null;
      await handoffToRadio();
    }
  }

  /** Hand the speaker to Radio after playback was prepared. */
  async function handoffToRadio() {
    if (!radioLayer?.playForVoice) return;
    const attemptId = `voice-radio-${Date.now().toString(36)}`;
    setStatus('listening', 'Handing the speaker to Radio');
    let started = false;
    try {
      started = await radioLayer.playForVoice({ attemptId, origin: 'voice' });
    } catch {
      started = false;
    }
    if (!started) {
      radioLayer.stopPlayback?.({ attemptId, origin: 'voice-cleanup' });
      emit({
        type: 'transcript',
        role: 'assistant',
        text: 'Radio could not start.',
        final: true,
      });
      return;
    }
    // Radio owns the speaker: end the session through the normal stop path.
    stop();
  }

  async function speakThroughFallback(text) {
    // No local audio owner (constructor tests): surface text-only.
    debugLog('tts.skipped', { reason: 'no audio owner' });
    void text;
  }

  /**
   * Start the session: verify the local stack, take the microphone, and
   * begin listening. Click-to-toggle; push-to-talk is OpenAI-path only.
   */
  async function start({ pushToTalk = false } = {}) {
    if (session.active) return;
    void pushToTalk;
    setStatus('connecting', 'Checking the local model');
    let status;
    try {
      status = await readStatus();
    } catch (error) {
      setStatus('error', error.message);
      throw error;
    }
    if (!status.enabled) {
      const problem = status.configError
        ? `Local voice disabled: GEV_OPENWEBUI_URL rejected (${status.configError})`
        : 'No local LLM is configured (set GEV_VOICE_BACKEND=openwebui plus OPENWEBUI_API_KEY)';
      setStatus('error', problem);
      throw new Error(problem);
    }
    if (session.active) return;
    try {
      audio =
        createAudio?.() ||
        new LocalVoiceAudio({
          onUtterance: (utterance) => void handleUtterance(utterance),
          onSpeechStart: () => handleSpeechStart(),
          onLevel: (level) => updateMicMeter(level),
          fetchImpl,
          speakVoice: null,
        });
      await audio.start();
    } catch (error) {
      audio?.stop();
      audio = null;
      const message =
        error?.name === 'NotAllowedError'
          ? 'Microphone permission refused — allow it and click again'
          : `Microphone unavailable: ${error?.message || error}`;
      setStatus('error', message);
      throw error;
    }
    session.active = true;
    debugLog('session.start', { backend: status.backend, model: status.model });
    setStatus('listening', 'Ask or command — speak when ready');
  }

  /** Energy barge-in: cut TTS + cancel the model while the user speaks. */
  function handleSpeechStart() {
    if (!session.active) return;
    if (session.speakingAssistant) {
      audio?.stopTts();
      session.speakingAssistant = false;
      chatAbort?.abort();
      emit({ type: 'interruption', reason: 'user-speech' });
      debugLog('barge_in', {});
    }
  }

  async function handleUtterance(utterance) {
    if (!session.active || session.turning) return;
    const text = await audio.transcribe(utterance).catch((error) => {
      debugLog('stt.error', { message: error?.message });
      setStatus('error', `Speech recognition failed: ${error?.message || error}`);
      return '';
    });
    // A cough or door-slam transcribes to nothing: no turn, no TTS.
    if (!text) return;
    session.turning = true;
    chatAbort = new AbortController();
    session.speakingAssistant = true;
    try {
      await runUserTurn(text, { signal: chatAbort.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        debugLog('turn.cancelled', {});
      } else {
        debugLog('stt.error', { message: error?.message });
        setStatus('error', `Speech recognition failed: ${error?.message || error}`);
      }
    } finally {
      session.turning = false;
      session.speakingAssistant = false;
    }
  }

  function updateMicMeter(level) {
    // The voice control's bars read `dataset.speaker` + a CSS custom prop on
    // the root; the mic side mirrors the Realtime meter's input behavior.
    if (!ui?.root) return;
    ui.root.style.setProperty('--gev-local-mic-level', String(level));
  }

  /** Typed command path: same pipeline, no STT. */
  function sendTextCommand(text) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    if (!session.active || session.turning) return false;
    session.speakingAssistant = true;
    session.turning = true;
    chatAbort = new AbortController();
    void runUserTurn(clean, { signal: chatAbort.signal })
      .catch((error) => {
        if (error?.name !== 'AbortError')
          setStatus('error', `Local voice failed: ${error?.message || error}`);
      })
      .finally(() => {
        session.turning = false;
        session.speakingAssistant = false;
      });
    return true;
  }

  /** Annotation outline outcomes reach the model as system notes. */
  function notifyMapEvent(event) {
    if (!session.active) return false;
    remember({ role: 'system', content: JSON.stringify(event) });
    return true;
  }

  function stop(options = {}) {
    const { preserveStatus = false } = options;
    chatAbort?.abort();
    chatAbort = null;
    for (const controller of inFlightActions) controller.abort();
    inFlightActions = new Set();
    audio?.stop();
    audio = null;
    session.active = false;
    session.turning = false;
    session.speakingAssistant = false;
    history.length = 0;
    lastRadioPlayback = null;
    if (!preserveStatus) setStatus('idle', 'Voice off');
  }

  return {
    capabilities: { costControls: false, pushToTalk: false },
    controller: {
      // sessionCommands inspects `adapter.controller || session`; expose the
      // minimum the Realtime card reads, with its own session backreference
      // wired by the caller.
      get active() {
        return Boolean(session?.active);
      },
    },
    runner,
    dataManager,
    start,
    stop,
    sendText: sendTextCommand,
    sendMapEvent: notifyMapEvent,
    ignoreButtonClick: () => false,
    bindControls() {
      /* open-mic only; no push-to-talk binding */
    },
  };
}