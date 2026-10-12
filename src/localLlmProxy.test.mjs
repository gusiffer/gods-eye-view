// Unit tests for the local LLM voice proxy (chat, audio, status).
// Drives the real handlers with injected transports, mirroring
// costEndpointThrottle.test.mjs's harness style.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createLlmChatHandler } from '../server/providers/llm/chat.js';
import {
  createLlmStatusHandler,
  createLlmTranscribeHandler,
} from '../server/providers/llm/audio.js';
import {
  isLocalUpstreamHost,
  parseUpstreamUrl,
  resolveLlmConfig,
} from '../server/providers/llm/config.js';
import { normalizeChatReply } from '../server/providers/llm/chat.js';

function request(
  handler,
  { method = 'POST', body, headers = {}, remoteAddress = '127.0.0.1' } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url: '/',
      headers: {
        host: 'localhost:4173',
        ...('content-type' in headers
          ? { 'content-type': headers['content-type'] }
          : {}),
        ...(contentTypeOverride(headers)),
      },
      socket: { remoteAddress },
      destroyed: false,
    });
    const responseHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders[name.toLowerCase()] = value;
      },
      end(bodyText = '') {
        resolve({
          status: this.statusCode,
          headers: responseHeaders,
          body: String(bodyText),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function contentTypeOverride(headers) {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  );
  return entry ? { [entry[0]]: entry[1] } : {};
}

test('upstream URLs must stay on the local network', () => {
  assert.equal(isLocalUpstreamHost('127.0.0.1'), true);
  assert.equal(isLocalUpstreamHost('192.168.1.40'), true);
  assert.equal(isLocalUpstreamHost('10.1.2.3'), true);
  assert.equal(isLocalUpstreamHost('172.16.9.9'), true);
  assert.equal(isLocalUpstreamHost('localhost'), true);
  assert.equal(isLocalUpstreamHost('box.local'), true);
  assert.equal(isLocalUpstreamHost('::1'), true);
  assert.equal(isLocalUpstreamHost('example.com'), false);
  assert.equal(isLocalUpstreamHost('169.254.169.254'), false);
  assert.equal(isLocalUpstreamHost('172.32.0.1'), false);

  assert.equal(parseUpstreamUrl('X', 'http://127.0.0.1:8080/').url, 'http://127.0.0.1:8080');
  assert.ok(parseUpstreamUrl('X', 'https://example.com').reason);
  assert.ok(parseUpstreamUrl('X', 'ftp://127.0.0.1:8080').reason);
  assert.ok(parseUpstreamUrl('X', 'http://127.0.0.1:8080/ollama/x').reason);
  assert.ok(parseUpstreamUrl('X', 'http://admin:pw@127.0.0.1:8080').reason);
});

test('resolveLlmConfig defaults to the OpenAI backend and documented models', () => {
  const config = resolveLlmConfig({});
  assert.equal(config.backend, 'openai');
  assert.equal(config.openwebui.url, 'http://127.0.0.1:8080');
  assert.equal(config.ollama.url, 'http://127.0.0.1:11434');
  assert.equal(config.model, 'glm-5.3-flash:cloud');
  assert.equal(config.fallbackModel, 'qwen3:8b');
});

test('chat prefers Open WebUI with the API key, then fails over to Ollama', async () => {
  const env = {
    GEV_VOICE_BACKEND: 'openwebui',
    GEV_OPENWEBUI_URL: 'http://127.0.0.1:8080',
    GEV_OLLAMA_URL: 'http://127.0.0.1:11434',
    GEV_LLM_MODEL: 'model-a',
    GEV_LLM_FALLBACK_MODEL: 'model-b',
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 1)
      return new Response('upstream down', { status: 503 });
    return Response.json({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'fly_to_location', arguments: { query: 'Austin' } } },
        ],
      },
      model: 'model-b',
    });
  };
  const handler = createLlmChatHandler({
    env,
    fetchImpl,
    resolveApiKey: () => 'fixture-webui-key',
  });
  const reply = await request(handler, {
    body: JSON.stringify({ messages: [{ role: 'user', content: 'fly to Austin' }] }),
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(calls.map((call) => new URL(call.url).port), ['8080', '11434']);
  const payload = JSON.parse(reply.body);
  assert.equal(payload.backend, 'ollama');
  assert.equal(payload.model, 'model-b');
  assert.equal(payload.fallback, true);
  assert.deepEqual(payload.message.tool_calls, [
    {
      id: 'call_1',
      name: 'fly_to_location',
      arguments: '{"query":"Austin"}',
    },
  ]);
});

test('chat request bodies keep tools and never leak the bearer key', async () => {
  const env = {
    GEV_VOICE_BACKEND: 'openwebui',
    GEV_OPENWEBUI_URL: 'http://127.0.0.1:8080',
    GEV_OLLAMA_URL: 'http://127.0.0.1:11434',
  };
  let keySeen = false;
  const seenBodies = [];
  const fetchImpl = async (url, init) => {
    seenBodies.push({ url, init });
    if (init?.headers?.Authorization === 'Bearer fixture-webui-key')
      keySeen = true;
    if (seenBodies.length === 1)
      return new Response('refused', { status: 401 });
    return Response.json({ message: { role: 'assistant', content: 'OK' } });
  };
  const handler = createLlmChatHandler({
    env,
    fetchImpl,
    resolveApiKey: () => 'fixture-webui-key',
    logger: { warn() {} },
  });
  const reply = await request(handler, {
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'zoom in' }],
      tools: [{ type: 'function', function: { name: 'noop_tool', parameters: {} } }],
    }),
  });
  assert.equal(reply.status, 200);
  assert.equal(keySeen, true, 'the Open WebUI call carries the bearer key');
  const forwarded = JSON.parse(seenBodies[0].init.body);
  assert.equal(forwarded.model, 'glm-5.3-flash:cloud');
  assert.equal(forwarded.tool_choice, 'auto');
  assert.deepEqual(forwarded.tools, [
    { type: 'function', function: { name: 'noop_tool', parameters: {} } },
  ]);
  const failover = JSON.parse(seenBodies[1].init.body);
  assert.equal(failover.model, 'qwen3:8b');
  assert.equal(failover.stream, false);
  assert.equal(reply.body.includes('fixture-webui-key'), false);
  assert.equal(reply.body.includes('127.0.0.1:8080'), false, 'upstream wording stays server-side');
});

test('without an Open WebUI key the chat goes straight to Ollama and says why', async () => {
  const warnings = [];
  const handler = createLlmChatHandler({
    env: { GEV_VOICE_BACKEND: 'openwebui' },
    fetchImpl: async () =>
      Response.json({ message: { role: 'assistant', content: 'OK' } }),
    logger: { warn: (line) => warnings.push(line) },
    resolveApiKey: () => '',
  });
  const reply = await request(handler, {
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(reply.status, 200);
  const payload = JSON.parse(reply.body);
  assert.equal(payload.backend, 'ollama');
  assert.equal(payload.fallback, undefined, 'the first successful route is not a fallback');
  assert.ok(warnings.some((line) => line.includes('OPENWEBUI_API_KEY')));
});

test('both upstreams failing answers 502 with a sanitized error', async () => {
  const handler = createLlmChatHandler({
    env: { GEV_VOICE_BACKEND: 'openwebui' },
    fetchImpl: async () => new Response('nope', { status: 500 }),
    logger: { warn() {} },
    resolveApiKey: () => 'fixture-webui-key',
  });
  const reply = await request(handler, {
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(reply.status, 502);
  assert.deepEqual(JSON.parse(reply.body), { error: 'Local LLM request failed' });
});

test('malformed request bodies are refused before any upstream call', async () => {
  let upstreamCalls = 0;
  const handler = createLlmChatHandler({
    env: { GEV_VOICE_BACKEND: 'openwebui' },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return Response.json({});
    },
    resolveApiKey: () => 'k',
    logger: { warn() {} },
  });
  assert.equal((await request(handler, { body: 'not json' })).status, 400);
  assert.equal(
    (await request(handler, { body: JSON.stringify({}) })).status,
    400,
    'messages are required',
  );
  const empty = await request(handler, {
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(empty.status, 400);
  assert.equal(upstreamCalls, 0);
});

test('normalizeChatReply accepts both upstream shapes', () => {
  const openAi = normalizeChatReply(
    { choices: [{ message: { role: 'assistant', content: 'Hi', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'zoom_in', arguments: '{}' } },
    ] } }], model: 'm1' },
    { backend: 'openwebui', model: 'm1' },
  );
  assert.equal(openAi.backend, 'openwebui');
  assert.deepEqual(openAi.message.tool_calls, [
    { id: 'c1', name: 'zoom_in', arguments: '{}' },
  ]);
  const ollama = normalizeChatReply(
    { message: { role: 'assistant', content: '', tool_calls: [
      { id: 'c2', function: { name: 'stop_tracking', arguments: {} } },
    ] } },
    { backend: 'ollama', model: 'm2', fallback: true },
  );
  assert.equal(ollama.fallback, true);
  assert.deepEqual(ollama.message.tool_calls, [
    { id: 'c2', name: 'stop_tracking', arguments: '{}' },
  ]);
  assert.throws(() => normalizeChatReply({}, { backend: 'ollama', model: 'x' }));
});

test('status reports the local backend and openwebui key presence', async () => {
  const fakeReq = {
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    destroyed: false,
  };
  function drive(handler, env) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end(body = '') {
          resolve({ status: this.statusCode, body });
        },
      };
      Promise.resolve(handler(fakeReq, res)).catch(() => resolve({ status: 500, body: '' }));
    });
  }
  const previous = process.env.OPENWEBUI_API_KEY;
  delete process.env.OPENWEBUI_API_KEY;
  try {
    const localWithKey = createLlmStatusHandler({
      env: {
        GEV_VOICE_BACKEND: 'openwebui',
        OPENWEBUI_API_KEY: undefined,
      },
      logger: { warn() {} },
    });
    const result = await drive(localWithKey, null);
    const data = JSON.parse(result.body);
    assert.equal(data.backend, 'openwebui');
    assert.equal(data.enabled, true, 'Ollama failover alone still answers chat');
    assert.equal(data.chat.openwebui, false, 'no key means Open WebUI chat is off');
    assert.equal(data.model, null, 'without the webui key the primary model is moot');
    assert.equal(data.fallbackModel, 'qwen3:8b');

    const withKey = createLlmStatusHandler({
      env: {
        GEV_VOICE_BACKEND: 'openwebui',
        OPENWEBUI_API_KEY: 'fixture-status-key',
        GEV_LLM_MODEL: 'voice-model',
      },
      logger: { warn() {} },
    });
    const keyed = JSON.parse((await drive(withKey, null)).body);
    assert.equal(keyed.enabled, true);
    assert.equal(keyed.chat.openwebui, true);
    assert.equal(keyed.stt.openwebui, true);
    assert.equal(keyed.tts.openwebui, true);
    assert.equal(keyed.model, 'voice-model');

    const openaiBackend = createLlmStatusHandler({
      env: { GEV_VOICE_BACKEND: 'openai' },
      logger: { warn() {} },
    });
    const cloud = JSON.parse((await drive(openaiBackend, null)).body);
    assert.equal(cloud.enabled, true, 'Ollama failover stays reachable');
    assert.equal(cloud.backend, 'openai', 'the selected backend is reported, not assumed');
    assert.equal(cloud.model, null);
  } finally {
    if (previous !== undefined) process.env.OPENWEBUI_API_KEY = previous;
  }
});

test('transcribe refuses non-multipart uploads and reports key problems clearly', async () => {
  const warnings = [];
  const handler = createLlmTranscribeHandler({
    env: { GEV_VOICE_BACKEND: 'openwebui' },
    fetchImpl: () => assert.fail('must not reach upstream'),
    logger: { warn: (line) => warnings.push(line) },
  });
  const jsonReply = await request(handler, {
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(jsonReply.status, 400);

  const noUpstream = createLlmTranscribeHandler({
    env: {
      GEV_VOICE_BACKEND: 'openwebui',
      GEV_OPENWEBUI_URL: 'not-a-url',
    },
    fetchImpl: () => assert.fail('must not reach upstream'),
    logger: { warn: (line) => warnings.push(line) },
  });
  const refused = await request(noUpstream, {
    headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
    body: 'irrelevant',
  });
  assert.equal(refused.status, 503, 'an invalid upstream fails closed');
  assert.ok(warnings.some((line) => line.includes('GEV_OPENWEBUI_URL')));
});
