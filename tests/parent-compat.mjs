import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { prepareParentRequest, restoreParentResponse, ParentSseDecoder, WIRE_NAMESPACE as W } from '../codex-parent-compat.mjs';
import { createParentProxy } from '../parent-proxy.mjs';

const tool = name => ({ type: 'function', name, parameters: { type: 'object', properties: {
  message: { type: 'string', encrypted: true }, task_name: { type: 'string' },
} } });
const catalog = () => [{ type: 'namespace', name: 'collaboration', tools: [tool('spawn_agent'), tool('send_message'), tool('followup_task'), tool('wait_agent')] }];
const call = (namespace = W) => ({ type: 'function_call', name: 'spawn_agent', namespace, call_id: 'a', arguments: '{"message":"明文任务"}' });
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';

for (const location of ['tools', 'additional_tools']) {
  test(`rewrite ${location} declarations without mutating caller`, () => {
    const body = location === 'tools' ? { tools: catalog() } : { input: [{ type: 'additional_tools', tools: catalog() }] };
    const original = structuredClone(body);
    const r = prepareParentRequest(body);
    assert.deepEqual(body, original);
    const tools = location === 'tools' ? r.tools : r.input[0].tools;
    assert.equal(tools[0].name, W);
    for (const x of tools[0].tools.slice(0, 3)) assert.equal(x.parameters.properties.message.encrypted, undefined);
    assert.equal(tools[0].tools[3].parameters.properties.message.encrypted, true);
  });
}
test('history and forced selection follow the renamed tool', () => {
  const r = prepareParentRequest({ tools: catalog(), input: [call('collaboration')], tool_choice: { type: 'function', namespace: 'collaboration', name: 'spawn_agent' } });
  assert.equal(r.input[0].namespace, W);
  assert.equal(r.tool_choice.namespace, W);
  assert.equal(r.input[0].arguments, call().arguments);
});
for (const separator of ['.', '__']) {
  test(`qualified root functions ${separator}`, () => {
    const r = prepareParentRequest({ tools: [tool(`collaboration${separator}spawn_agent`)] });
    assert.equal(r.tools[0].name, `${W}${separator}spawn_agent`);
    assert.equal(r.tools[0].parameters.properties.message.encrypted, undefined);
  });
}
test('bare collaboration declarations remove encryption', () => {
  const r = prepareParentRequest({ tools: [tool('spawn_agent')] });
  assert.equal(r.tools[0].parameters.properties.message.encrypted, undefined);
});
test('other namespaces and schemas are untouched', () => {
  const body = { tools: [{ type: 'namespace', name: 'other', tools: [tool('lookup'), tool('spawn_agent')] },
    { type: 'function', name: 'database', parameters: { properties: { sample: { type: 'namespace', name: 'collaboration' } } } }] };
  assert.deepEqual(prepareParentRequest(body), body);
});
test('user text, tool results, encrypted history and arguments are never rewritten', () => {
  const content = [{ type: 'input_text', text: 'collaboration cc_collaboration_plain' }];
  const body = { tools: catalog(), input: [
    { type: 'message', role: 'user', content },
    { type: 'function_call_output', output: { type: 'function_call', namespace: 'collaboration' } },
    { type: 'reasoning', encrypted_content: 'opaque' },
    { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'opaque' }] },
  ] };
  assert.deepEqual(prepareParentRequest(body).input, body.input);
});
test('reserved namespace conflict is explicit', () => {
  assert.throws(() => prepareParentRequest({ tools: [{ type: 'namespace', name: W, tools: [] }] }), /Reserved/);
});
test('stateful continuation is rejected rather than silently mismatched', () => {
  assert.throws(() => prepareParentRequest({ previous_response_id: 'resp_old' }), /stateless/);
});
test('invalid JSON request shapes rejected', () => {
  for (const x of [null, [], 'text', 1]) assert.throws(() => prepareParentRequest(x), /JSON object/);
});
for (const type of ['function_call', 'custom_tool_call']) {
  test(`restore ${type} in nonstream response, leave text and argument content alone`, () => {
    const item = { ...call(), type };
    const text = { type: 'message', content: [{ type: 'output_text', text: W }] };
    const r = restoreParentResponse({ object: 'response', output: [item, text] });
    assert.equal(r.output[0].namespace, 'collaboration');
    assert.equal(r.output[0].arguments, call().arguments);
    assert.deepEqual(r.output[1], text);
  });
}
test('fully qualified upstream name is restored as namespace and bare name', () => {
  const r = restoreParentResponse({ type: 'response.output_item.done', item: { ...call(), name: W + '.spawn_agent', namespace: undefined } });
  assert.equal(r.item.name, 'spawn_agent');
  assert.equal(r.item.namespace, 'collaboration');
});
test('completed event restores both output and echoed tool catalog', () => {
  const r = restoreParentResponse({ type: 'response.completed', response: { output: [call()], tools: [{ type: 'namespace', name: W, tools: [] }] } });
  assert.equal(r.response.output[0].namespace, 'collaboration');
  assert.equal(r.response.tools[0].name, 'collaboration');
});
test('SSE deltas are not subjected to namespace string replacement', () => {
  const x = { type: 'response.function_call_arguments.delta', delta: `{"message":"${W}"}` };
  assert.deepEqual(restoreParentResponse(structuredClone(x)), x);
});
test('SSE parser handles every UTF-8 byte split, CRLF, comments and final tail', () => {
  const original = ': keepalive\r\n\r\nevent: response.output_item.added\r\nid: test\r\n'
    + frame({ type: 'response.output_item.added', item: call() }).replaceAll('\n', '\r\n')
    + frame({ type: 'response.function_call_arguments.delta', delta: '中文😀' }) + 'data: [DONE]';
  const decoder = new ParentSseDecoder();
  let actual = '';
  for (const byte of Buffer.from(original)) actual += decoder.push(Uint8Array.of(byte)).join('');
  actual += decoder.push(undefined, true).join('');
  assert.match(actual, /"namespace":"collaboration"/);
  assert.match(actual, /中文😀/);
  assert.match(actual, /: keepalive/);
  assert.match(actual, /id: test/);
  assert.match(actual, /data: \[DONE\]/);
});
test('multiline SSE data joins correctly', () => {
  const decoder = new ParentSseDecoder();
  const data = `event: response.output_item.done\ndata: {"type":"response.output_item.done",\ndata: "item":${JSON.stringify(call())}}\n\n`;
  assert.match(decoder.push(Buffer.from(data)).join(''), /"namespace":"collaboration"/);
});
test('invalid/oversized SSE frames fail explicitly', () => {
  assert.throws(() => new ParentSseDecoder().push(Buffer.from('data: {bad}\n\n')));
  assert.throws(() => new ParentSseDecoder(4).push(Buffer.from('data: 12345')));
  assert.throws(() => new ParentSseDecoder(4).push(Buffer.from('data: 12345\n\n')));
});

async function listening(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handle, options = {}) {
  const upstream = http.createServer(handle);
  const url = await listening(upstream);
  const proxy = createParentProxy({ upstream: url + '/v1', timeoutMs: 3000, ...options });
  const base = await listening(proxy);
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  return base;
}
const headers = { authorization: 'Bearer test-only', 'content-type': 'application/json' };
test('HTTP integration: auth/status/request-id forwarding and complete JSON restoration', async t => {
  let received;
  const base = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, 'Bearer test-only');
    assert.equal(req.headers['accept-encoding'], 'identity');
    const buffers = []; for await (const x of req) buffers.push(x);
    received = JSON.parse(Buffer.concat(buffers));
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'trace_1', 'set-cookie': 'secret_cookie=1' });
    res.end(JSON.stringify({ object: 'response', output: [call()] }));
  });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ tools: catalog(), input: 'test' }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-request-id'), 'trace_1');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await r.json()).output[0].namespace, 'collaboration');
  assert.equal(received.tools[0].name, W);
  assert.equal(received.tools[0].tools[0].parameters.properties.message.encrypted, undefined);
});
test('HTTP integration: streaming restoration and terminal event preservation', async t => {
  const base = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ type: 'response.output_item.added', item: call() }));
    res.end(frame({ type: 'response.completed', response: { output: [call()] } }));
  });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{}' });
  const text = await r.text();
  assert.equal((text.match(/"namespace":"collaboration"/g) || []).length, 2);
  assert.match(text, /response.completed/); assert.doesNotMatch(text, new RegExp(W));
});
test('HTTP errors remain errors, including retry-after', async t => {
  const base = await fixture(t, (_req, res) => { res.writeHead(429, { 'retry-after': '3' }); res.end('{"error":"limit"}'); });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '3');
  assert.equal(await r.text(), '{"error":"limit"}');
});
test('compact requests and encrypted compaction results are passed through', async t => {
  const body = { model: 'parent', input: [{ type: 'reasoning', encrypted_content: 'opaque' }], tools: catalog() };
  const reply = { object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: 'untouched' }] };
  const base = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/responses/compact');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), body);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
  });
  const r = await fetch(base + '/v1/responses/compact', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.deepEqual(await r.json(), reply);
});
test('redirect is not followed and upstream URL is never client-controlled', async t => {
  let count = 0;
  const base = await fixture(t, (_req, res) => { count++; res.writeHead(302, { location: 'http://example.invalid/' }); res.end(); });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 502); assert.equal(count, 1);
  assert.equal((await fetch(base + '/v1/responses?url=evil', { method: 'POST', headers, body: '{}' })).status, 404);
});
test('health, auth, request size, invalid JSON and unsupported routes', async t => {
  let calls = 0;
  const base = await fixture(t, (_req, res) => { calls++; res.end('{}'); }, { maxBytes: 100 });
  assert.equal(await (await fetch(base + '/health')).text(), 'OK');
  assert.equal((await fetch(base + '/v1/responses', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/v1/responses', { method: 'POST', headers, body: 'x'.repeat(101) })).status, 413);
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal(calls, 0);
});
test('upstream timeout becomes a bounded 502 without leaking error/URL', async t => {
  const base = await fixture(t, () => {}, { timeoutMs: 100 });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /127\.0\.0\.1|test-only/);
});
test('malformed upstream SSE terminates without fake completion', async t => {
  const base = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: not-json\n\n'); });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{}' });
  const text = await r.text(); assert.match(text, /parent_compat_error/); assert.doesNotMatch(text, /response.completed/);
});
test('fixed upstream URL rejects embedded credentials and non-http schemes', () => {
  for (const upstream of ['file:///secret', 'https://key:secret@example.com/v1', 'https://example.com/v1?secret=1']) {
    assert.throws(() => createParentProxy({ upstream }));
  }
});
