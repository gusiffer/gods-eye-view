// Local voice adapter + prompt tests. The adapter is driven through a stubbed
// fetch and a stubbed audio owner, mirroring session.test.mjs's style: the
// adapter must implement the same contract and emit the same provider-neutral
// events the voice card consumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalVoiceSession,
  createLocalActionTools,
  extractInlineToolCalls,
  MAX_TOOL_ROUNDS,
} from './voice/localVoiceSession.js';
import {
  LOCAL_TOOL_HINTS,
  LOCAL_VOICE_INSTRUCTIONS,
} from './voice/localVoicePrompt.js';
import { GEV_ACTION_SCHEMAS } from './voice/actionSchemas.js';
import {
  vadStep,
  computeRms,
  encodeWav,
  downsampleTo16k,
  RECORD_SAMPLE_RATE,
} from './voice/localVoiceAudio.js';

function okReply(content, toolCalls) {
  return {
    message: {
      role: 'assistant',
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    },
    backend: 'openwebui',
    model: 'fixture',
  };
}

function adapterFixture({
  status = { enabled: true, backend: 'openwebui', model: 'fixture' },
  replies,
  audioOwner = null,
  runActionImpl,
} = {}) {
  const events = [];
  const actions = [];
  const fetchCalls = [];
  let replyIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    if (url.includes('/status'))
      return Response.json(status);
    const reply = replies[Math.min(replyIndex, replies.length - 1)];
    replyIndex += 1;
    if (typeof reply === 'number')
      return Response.json({ error: 'upstream down' }, { status: reply });
    return Response.json(reply);
  };
  const adapter = createLocalVoiceSession({
    emit: (event) => events.push(event),
    runAction: runActionImpl || (async (name, args, options = {}) => {
      actions.push({ name, args, options });
      return { ok: true, action: name, say: 'Done.' };
    }),
    signal: new AbortController().signal,
    runner: async () => ({}),
    ui: { root: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } },
    radioLayer: null,
    dataManager: null,
    debugSink: null,
    pointer: null,
    fetchImpl,
    audio: audioOwner ? () => audioOwner : undefined,
  });
  return { adapter, events, actions, fetchCalls };
}

function fakeAudio(t) {
  const spoken = [];
  let speakResolver;
  return {
    spoken,
    speakStarted: new Promise((resolve) => (speakResolver = resolve)),
    start: async () => true,
    transcribe: async () => 'take me to Austin',
    speak: async (text) => {
      spoken.push(text);
      return speakResolver ? (speakResolver(), await Promise.resolve()) : undefined;
    },
    stopTts() {},
    stop() {},
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('the local tool list mirrors the action schemas with hints for every tool', () => {
  const tools = createLocalActionTools();
  assert.equal(tools.length, GEV_ACTION_SCHEMAS.length);
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, tool.name);
    assert.equal(tool.description, LOCAL_TOOL_HINTS[tool.name]);
    const keys = Object.keys(tool.parameters).sort();
    assert.ok(
      keys.includes('type') && keys.includes('properties'),
      `${tool.name} parameters stay schema-shaped: ${keys.join(',')}`,
    );
  }
});

test('the local instruction prompt keeps the shared behavioral contracts', () => {
  for (const phrase of [
    'WHERE, for every tool',
    'COUNTS:',
    'AFTER TOOLS:',
    'Radio playback uses control_radio',
    'track_entity',
    'zoom_to_globe',
    'annotate_map',
    'Only control the app by calling the provided tools',
  ]) {
    assert.ok(LOCAL_VOICE_INSTRUCTIONS.includes(phrase), phrase);
  }
  assert.ok(
    LOCAL_VOICE_INSTRUCTIONS.length < 4500,
    `stay sized for small-context models (${LOCAL_VOICE_INSTRUCTIONS.length} chars)`,
  );
});

/** The tag halves built from char codes, so the fixtures cannot drift. */
const TAG_OPEN = String.fromCharCode(
  60, 116, 111, 111, 108, 95, 99, 97, 108, 108, 62,
);
const TAG_CLOSE = String.fromCharCode(
  60, 47, 116, 111, 111, 108, 95, 99, 97, 108, 108, 62,
);

test('inline Hermes-style tool tags become calls and are stripped from speech', () => {
  const { toolCalls, text } = extractInlineToolCalls(
    `Let me look. ${TAG_OPEN}${JSON.stringify({
      name: 'fly_to_location',
      arguments: { query: 'Austin' },
    })}${TAG_CLOSE}`,
  );
  assert.deepEqual(toolCalls, [
    { id: 'inline_1', name: 'fly_to_location', arguments: '{"query":"Austin"}' },
  ]);
  assert.equal(text, 'Let me look.');
  assert.deepEqual(extractInlineToolCalls('no tags').toolCalls, []);
});

test('malformed tool tags vanish instead of reaching the model or TTS', () => {
  const { toolCalls, text } = extractInlineToolCalls(
    `${TAG_OPEN}{"name broken json${TAG_CLOSE} answer`,
  );
  assert.deepEqual(toolCalls, []);
  assert.ok(text.includes('answer'));
});

test('status failure fails loudly and the error state carries the reason', async () => {
  const { adapter, events } = adapterFixture({ status: { enabled: false } });
  await assert.rejects(adapter.start(), /No local LLM/);
  const error = events.find((event) => event.type === 'state' && event.state === 'error');
  assert.ok(error, 'an error state event was emitted');
  assert.match(error.detail, /No local LLM/);
});

test('a full turn: transcript, tool round, spoken reply and completion', async (t) => {
  const audio = fakeAudio(t);
  const { adapter, events, actions, fetchCalls } = adapterFixture({
    replies: [
      okReply('', [
        {
          id: 'call_1',
          function: { name: 'fly_to_location', arguments: '{"query":"Austin"}' },
        },
      ]),
      okReply('Flying you to Austin.'),
    ],
    audioOwner: audio,
  });
  await adapter.start();
  assert.ok(events.some((event) => event.type === 'state' && event.state === 'listening'), 'session listening after start');
  await adapter.sendText('take me to Austin');
  await settle();

  const transcripts = events.filter((event) => event.type === 'transcript');
  assert.deepEqual(
    transcripts.map((event) => [event.role, event.final]),
    [
      ['user', true],
      ['assistant', true],
    ],
  );
  assert.equal(transcripts[1].text, 'Flying you to Austin.');
  assert.deepEqual(
    actions.map((action) => action.name),
    ['fly_to_location'],
  );
  assert.deepEqual(actions[0].args, { query: 'Austin' });
  assert.deepEqual(audio.spoken, ['Flying you to Austin.']);
  assert.ok(events.some((event) => event.type === 'completion'));
  assert.ok(
    events.some((event) => event.type === 'state' && event.state === 'listening'),
    'back to listening after the turn',
  );
  // The chat requests carry the tools and the bounded history; the tool
  // result reaches the model in the SECOND request of the turn.
  const chatCalls = fetchCalls.filter((call) => String(call.url).includes('/chat'));
  const first = JSON.parse(chatCalls[0].init.body);
  const followUp = JSON.parse(chatCalls.at(-1).init.body);
  assert.equal(first.temperature, 0.3);
  assert.ok(Array.isArray(first.tools) && first.tools.length > 20);
  assert.ok(
    followUp.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_1',
    ),
    'the tool result reaches the model as a tool message',
  );
});

test('multi-tool rounds keep executing until the model answers', async (t) => {
  const audio = fakeAudio(t);
  const { adapter, actions } = adapterFixture({
    replies: [
      okReply('', [
        { id: 'c1', function: { name: 'set_layer_visibility', arguments: '{"layerId":"flights","enabled":true}' } },
      ]),
      okReply('', [
        { id: 'c2', function: { name: 'zoom_to_globe', arguments: '{}' } },
      ]),
      okReply('Flights on, globe view.'),
    ],
    audioOwner: audio,
  });
  await adapter.start();
  await adapter.sendText('turn on flights and zoom out');
  await settle();
  assert.deepEqual(
    actions.map((action) => action.name),
    ['set_layer_visibility', 'zoom_to_globe'],
  );
});

test('the tool loop stops at the round cap and says so instead of hanging', async (t) => {
  const audio = fakeAudio(t);
  const toolCall = [{ id: 'c', function: { name: 'zoom_to_globe', arguments: '{}' } }];
  const { adapter, events } = adapterFixture({
    replies: Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => okReply('', toolCall)),
    audioOwner: audio,
  });
  await adapter.start();
  await adapter.sendText('loop forever');
  await settle();
  const finalTranscript = events
    .filter((event) => event.type === 'transcript' && event.role === 'assistant')
    .at(-1);
  assert.match(finalTranscript.text, /more steps/);
});

test('a failing tool result still reaches the model as ok:false', async (t) => {
  const audio = fakeAudio(t);
  let failingCalls = 0;
  const { adapter, fetchCalls } = adapterFixture({
    replies: [
      okReply('', [{ id: 'c1', function: { name: 'fly_to_location', arguments: '{}' } }]),
      okReply('That did not work.'),
    ],
    audioOwner: audio,
    runActionImpl: async () => {
      failingCalls += 1;
      throw new Error('geocoding failed');
    },
  });
  await adapter.start();
  await adapter.sendText('go somewhere');
  await settle();
  assert.equal(failingCalls, 1, 'the tool ran once');
  const chatCalls = fetchCalls.filter((call) => String(call.url).includes('/chat'));
  const afterTool = JSON.parse(chatCalls[1].init.body).messages.find(
    (message) => message.role === 'tool',
  );
  assert.deepEqual(JSON.parse(afterTool.content), {
    ok: false,
    error: 'geocoding failed',
  });
});

test('stop clears history and the next turn starts fresh', async (t) => {
  const audio = fakeAudio(t);
  const { adapter, fetchCalls } = adapterFixture({
    replies: [okReply('Done.'), okReply('Done again.')],
    audioOwner: audio,
  });
  await adapter.start();
  await adapter.sendText('first turn');
  await settle();
  adapter.stop();
  await adapter.start();
  await adapter.sendText('second turn');
  await settle();
  const chatCalls = fetchCalls.filter((call) => String(call.url).includes('/chat'));
  const secondMessages = JSON.parse(chatCalls[1].init.body).messages;
  assert.ok(
    !secondMessages.some((message) => message.role === 'user' && message.content === 'first turn'),
    'history reset on stop',
  );
});

test('session contract implements the adapter interface', () => {
  const { adapter } = adapterFixture({});
  for (const key of ['start', 'stop', 'sendText', 'sendMapEvent'])
    assert.equal(typeof adapter[key], 'function');
  assert.deepEqual(adapter.capabilities, { costControls: false, pushToTalk: false });
  assert.equal(typeof adapter.sendMapEvent, 'function');
  assert.equal(typeof adapter.controller, 'object');
});

test('vadStep: calibration is silent, quiet room tone stays idle, speech fires end and re-arms', () => {
  const idle = vadStep({ rms: 0.001, gate: 0.01, state: 'speaking', speechStart: null, now: 0 });
  assert.deepEqual(idle, { state: 'speaking', speechStart: null, event: 'none', rms: 0.001 });
  const calibrating = vadStep({ rms: 1, gate: 0.01, state: 'calibrating', speechStart: null, now: 0 });
  assert.equal(calibrating.event, 'none', 'audio during calibration emits nothing');

  let state = 'speaking';
  let speechStart = null;
  let now = 1000;
  // Loud sample re-arms after the previous utterance and starts a new one.
  let step = vadStep({ rms: 0.2, gate: 0.01, state, speechStart, now });
  ({ state, speechStart } = step);
  assert.equal(step.event, 'speech_start', 'speaking re-arms into listening');
  assert.equal(state, 'listening');
  // Speech continues briefly then goes quiet; hangover ends the utterance.
  now += 300;
  step = vadStep({ rms: 0.0, gate: 0.01, state, speechStart, now });
  ({ state, speechStart } = step);
  assert.equal(step.event, 'none', 'below hangover keeps the utterance open');
  now += 500;
  step = vadStep({ rms: 0.0, gate: 0.01, state, speechStart, now });
  assert.equal(step.event, 'speech_end');
  assert.equal(step.state, 'speaking');
  // And the machine re-arms for the next utterance immediately after.
  now += 2000;
  step = vadStep({ rms: 0.2, gate: 0.01, state: step.state, speechStart: null, now });
  assert.equal(step.event, 'speech_start', 'a second utterance can start');
  // A 100 ms cough: hangs over 700 ms of silence, but the ABOVE-GATE time was
  // only 100 ms, one frame of 85 ms style processing... in a pure frame-step
  // model each call is one frame, so simulate by measuring real speech: the
  // blip armed at 5000 was LOUD for exactly one frame; the guard that decides
  // is duration since ARM (800 ms) — a real cough would also trip it without
  // an accumulated-speech counter. The gate therefore treats a sustained
  // below-hangover quiet after ANY armed speech as an utterance; short blips
  // are pruned by the transcriber returning empty text (Whisper on noise
  // returns ''), not by the VAD. Pin that contract here.
  const blip = vadStep({ rms: 0.2, gate: 0.01, state: 'speaking', speechStart: null, now: 5000 });
  assert.equal(blip.event, 'speech_start');
  const blipQuiet = vadStep({ rms: 0.0, gate: 0.01, state: blip.state, speechStart: blip.speechStart, now: 5100 });
  assert.equal(blipQuiet.event, 'none', 'still inside hangover');
  const blipEnd = vadStep({ rms: 0.0, gate: 0.01, state: blipQuiet.state, speechStart: blipQuiet.speechStart, now: 5800 });
  assert.equal(blipEnd.event, 'speech_end', 'hangover resolves every armed utterance');
  // MAX utterance forces a stop even under continuous speech.
  const forced = vadStep({ rms: 0.5, gate: 0.01, state: 'listening', speechStart: 0, now: 20_000 });
  assert.equal(forced.event, 'speech_end');
});

test('wav encode and downsample produce valid clips', () => {
  const samples = new Float32Array(1600).fill(0.25);
  const buffer = encodeWav(samples, RECORD_SAMPLE_RATE);
  const view = new DataView(buffer);
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), RECORD_SAMPLE_RATE);
  assert.equal(view.getUint32(40, true), 1600 * 2);
  // Clipping clamps both ways.
  const loud = encodeWav(new Float32Array([1.5, -1.5, 0]), 16000);
  const loudView = new DataView(loud);
  assert.equal(loudView.getInt16(44, true), 32767);
  assert.equal(loudView.getInt16(46, true), -32768);

  const down = downsampleTo16k([new Float32Array([0, 1, 0, 1]), new Float32Array([0, 1, 0, 1])], 48_000);
  assert.equal(down.rate, RECORD_SAMPLE_RATE);
  assert.equal(down.samples.length, 2, '8 samples at 48 kHz ÷ factor 3 = 2');
  const passthrough = downsampleTo16k([new Float32Array(100)], RECORD_SAMPLE_RATE);
  assert.equal(passthrough.samples.length, 100);
});

test('computeRms measures honest levels', () => {
  assert.equal(computeRms(new Float32Array(0)), 0);
  const constant = new Float32Array(100).fill(0.5);
  assert.ok(Math.abs(computeRms(constant) - 0.5) < 1e-9);
  const sine = new Float32Array(1000);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((i / 1000) * Math.PI * 2);
  assert.ok(Math.abs(computeRms(sine) - Math.SQRT1_2) < 1e-2);
});