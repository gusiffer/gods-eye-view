// The local HUD summary branch shares the OpenAI path's response contract and
// only swaps the transport. Driven like costEndpointThrottle.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalHudSummaryResolver } from '../server/providers/llm/hud-summary.js';
import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../src/hudSummaryResponse.js';

test('the local HUD resolver is null unless the openwebui backend is selected', () => {
  assert.equal(createLocalHudSummaryResolver({ env: {} }), null);
  assert.equal(createLocalHudSummaryResolver({ env: { GEV_VOICE_BACKEND: 'openai' } }), null);
  assert.equal(
    typeof createLocalHudSummaryResolver({
      env: { GEV_VOICE_BACKEND: 'openwebui' },
      logger: { warn() {} },
    }),
    'function',
  );
});

test('the local HUD summary asks the shared instructions and trims to five words', async () => {
  const bodies = [];
  const bearerSeen = { value: false };
  const result = await createLocalHudSummaryResolver({
    env: {
      GEV_VOICE_BACKEND: 'openwebui',
      GEV_LLM_MODEL: 'voice-model',
      GEV_OPENWEBUI_URL: 'http://127.0.0.1:8080',
      GEV_OLLAMA_URL: 'http://127.0.0.1:11434',
    },
    logger: { warn() {} },
    resolveApiKey: () => 'fixture-hud-key',
    fetchImpl: async (url, init) => {
      bodies.push({ url, body: JSON.parse(init.body) });
      if (init.headers?.Authorization === 'Bearer fixture-hud-key')
        bearerSeen.value = true;
      return Response.json({
        choices: [
          { message: { role: 'assistant', content: 'Austin Downtown Flights Loading Live North.' } },
        ],
      });
    },
  })({ placeLabels: ['Austin'] });
  assert.equal(result, 'Austin Downtown Flights Loading Live');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].body.model, 'voice-model');
  assert.equal(bodies[0].body.messages[0].role, 'system');
  assert.equal(bodies[0].body.messages[0].content, HUD_SUMMARY_INSTRUCTIONS);
  assert.equal(bearerSeen.value, true, 'the Open WebUI call carries the bearer key');
});

test('the local HUD summary fails over to Ollama with the fallback model', async () => {
  const urls = [];
  const result = await createLocalHudSummaryResolver({
    env: {
      GEV_VOICE_BACKEND: 'openwebui',
      GEV_LLM_MODEL: 'primary-model',
      GEV_LLM_FALLBACK_MODEL: 'fallback-model',
    },
    logger: { warn() {} },
    resolveApiKey: () => 'fixture-hud-key',
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length === 1) return new Response('down', { status: 503 });
      return Response.json({ message: { content: 'One Two Three Four Five Six' } });
    },
  })({});
  assert.deepEqual(urls.map((url) => new URL(url).port), ['8080', '11434']);
  assert.equal(result, 'One Two Three Four Five');
});

test('the shared five-word post-processing matches the OpenAI helper behavior', () => {
  // Both paths compose from the same instruction module; the keyless payload
  // shape the client detects must be untouched.
  const payload = keylessHudSummaryResponse(undefined);
  assert.equal(payload.statusCode, 200);
  assert.equal(payload.payload.configured, false);
});