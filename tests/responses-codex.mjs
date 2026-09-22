import http from 'node:http';
import assert from 'node:assert/strict';
import { prepareResponsesCompatibility } from '../responses-compat.mjs';

process.env.HOST = '127.0.0.1';
process.env.PORT = '13051';
process.env.CC_API_BASE = 'http://mock.invalid';
console.log = () => {};
let captured;
let events = [];
let calls = 0;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '0.32.3' });
  if (String(url).endsWith('/alpha/generate')) {
    calls++;
    captured = JSON.parse(options.body).params;
    const output = typeof events === 'function' ? events(captured) : events;
    return new Response([...output, { type: 'finish', finishReason: 'stop',
      totalUsage: { inputTokens: 10, outputTokens: 2 } }].map(x => JSON.stringify(x)).join('\n') + '\n');
  }
  return Response.json({ ok: true });
};
await import('../proxy.mjs');
await new Promise(resolve => setTimeout(resolve, 100));

function request(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 13051, path: '/v1/responses', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user_mock_only' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', x => body += x);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('test timeout')));
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', ...body }));
  });
}
const fun = (name = 'lookup') => ({ type: 'function', name, parameters: { type: 'object', properties: { n: { type: 'number' } } } });
const custom = (name = 'exec') => ({ type: 'custom', name, description: 'Execute JavaScript',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } });
const ns = (name, tools) => ({ type: 'namespace', name, tools });
const additional = tools => ({ type: 'additional_tools', role: 'developer', tools });
const agent = content => ({ type: 'agent_message', content });
const text = text => ({ type: 'input_text', text });
const user = content => ({ type: 'message', role: 'user', content });
const ccText = text => ({ type: 'text', text });
const ok = [{ type: 'text-delta', text: 'OK' }];
const registry = tools => prepareResponsesCompatibility({ tools });
const tests = [];
const test = (name, run) => tests.push({ name, run });
const good = async (body, upstream = ok) => {
  events = upstream;
  const result = await request(body);
  assert.equal(result.status, 200, result.body);
  return result;
};
function output(result, stream) {
  if (!stream) return JSON.parse(result.body).output;
  const events = result.body.split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  const completed = events.find(e => e.type === 'response.completed');
  assert.ok(completed, result.body);
  const items = events.filter(e => e.type === 'response.output_item.done').map(e => e.item);
  assert.deepEqual(items, completed.response.output);
  return items;
}

test('additional_tools and plaintext agent task survive', async () => {
  await good({ input: [additional([fun()]), agent([text('17+25; no tools')])] });
  assert.equal(captured.tools[0].name, 'lookup');
  assert.deepEqual(captured.messages, [{ role: 'user', content: [ccText('17+25; no tools')] }]);
});
test('encrypted_content plaintext carrier is preserved, not decrypted', async () => {
  await good({ input: [agent([{ type: 'encrypted_content', encrypted_content: 'PING_OK_20260922' }])] });
  assert.equal(captured.messages[0].content[0].text, 'PING_OK_20260922');
});
test('agent image and text order survive', async () => {
  await good({ input: [agent([text('before'), { type: 'input_image', image_url: 'https://example.com/img.png' }, text('after')])] });
  assert.deepEqual(captured.messages[0].content, [ccText('before'), { type: 'image', image: 'https://example.com/img.png' }, ccText('after')]);
});
test('namespace function/custom schemas and grammar are exposed', async () => {
  await good({ input: [additional([ns('functions', [custom(), fun()])]), agent('task')] });
  assert.equal(captured.tools.length, 2);
  assert.match(captured.tools[0].description, /functions\.exec/);
  assert.match(captured.tools[0].description, /start:/);
  assert.equal(captured.tools[0].input_schema.properties.input.type, 'string');
  assert.equal(captured.tools[1].input_schema.properties.n.type, 'number');
});
test('collaboration message encryption annotation removed without changing caller schema', () => {
  const tool = { ...fun('spawn_agent'), parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } };
  const r = registry([ns('collaboration', [tool])]);
  assert.equal(r.tools[0].function.parameters.properties.message.encrypted, undefined);
  assert.equal(tool.parameters.properties.message.encrypted, true);
});
test('repeated tool definitions deduplicate, later schema wins', () => {
  const r = prepareResponsesCompatibility({ tools: [fun()], input: [additional([{ ...fun(), description: 'updated' }])] });
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].function.description, 'updated');
});
test('aliases collision resistant and stable across declaration order', () => {
  const defs = [fun('a__b'), ns('a', [fun('b')]), ns('a__b', [fun('c')]), ns('a', [fun('b__c')]), fun('x'.repeat(100))];
  const first = registry(defs).tools.map(t => t.function.name);
  assert.equal(new Set(first).size, 5);
  assert.ok(first.every(n => /^[A-Za-z0-9_-]{1,64}$/.test(n)));
  assert.deepEqual(registry([...defs].reverse()).tools.map(t => t.function.name).reverse(), first);
  const reserved = registry([fun(first[1]), ns('a', [fun('b')])]).tools;
  assert.notEqual(reserved[0].function.name, reserved[1].function.name);
});

for (const stream of [false, true]) {
  for (const kind of ['function', 'custom']) {
    test(`${kind} namespace call and history round trip stream=${stream}`, async () => {
      const tool = kind === 'custom' ? custom() : fun();
      const raw = 'const x = "雪";\ntext(x);';
      const args = kind === 'custom' ? { input: raw } : { n: 42 };
      const tools = [ns('functions', [tool])];
      const result = await good({ stream, input: [additional(tools), agent('do task')] }, p => [
        { type: 'tool-call', toolCallId: 'call_1', toolName: p.tools[0].name, input: args },
      ]);
      const item = output(result, stream)[0];
      assert.equal(item.type, kind === 'custom' ? 'custom_tool_call' : 'function_call');
      assert.equal(item.namespace, 'functions');
      assert.equal(item.name, tool.name);
      assert.equal(item.call_id, 'call_1');
      if (kind === 'custom') assert.equal(item.input, raw);
      else assert.deepEqual(JSON.parse(item.arguments), args);
      if (stream) {
        assert.match(result.body, new RegExp(kind === 'custom' ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta'));
      }
      await good({ stream, input: [additional(tools), item,
        { type: kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id: 'call_1', output: 'result' }, user('continue')] });
      assert.deepEqual(captured.messages[0].content[0].input, args);
      assert.equal(captured.messages[0].content[0].toolName, captured.tools[0].name);
      assert.equal(captured.messages[1].content[0].toolCallId, 'call_1');
      assert.equal(captured.messages[1].content[0].toolName, captured.tools[0].name);
    });
  }
  test(`multiple parallel namespaced calls stream=${stream}`, async () => {
    const result = await good({ stream, input: [additional([ns('a', [fun()]), ns('b', [custom()])]), agent('task')] }, p => [
      { type: 'tool-call', toolCallId: 'a', toolName: p.tools[0].name, input: { n: 1 } },
      { type: 'tool-call', toolCallId: 'b', toolName: p.tools[1].name, input: JSON.stringify({ input: 'text(2)' }) },
    ]);
    assert.deepEqual(output(result, stream).map(x => [x.namespace, x.call_id, x.type]), [
      ['a', 'a', 'function_call'], ['b', 'b', 'custom_tool_call'],
    ]);
  });
}
test('custom tool image history keeps attachment after complete result batch', async () => {
  await good({ input: [additional([ns('functions', [custom()])]),
    { type: 'custom_tool_call', name: 'exec', namespace: 'functions', call_id: 'a', input: 'image(...)' },
    { type: 'custom_tool_call_output', call_id: 'a', output: [{ type: 'input_image', image_url: 'https://example.com/test.png' }] },
  ] });
  assert.equal(captured.messages[1].role, 'tool');
  assert.equal(captured.messages[2].content[1].type, 'image');
});
test('named custom tool_choice uses the same upstream alias', async () => {
  await good({ input: [additional([ns('functions', [custom()])]), agent('task')],
    tool_choice: { type: 'custom', namespace: 'functions', name: 'exec' } });
  assert.equal(captured.tool_choice.name, captured.tools[0].name);
});
test('historical custom tool can be removed from current catalog', async () => {
  await good({ input: [
    { type: 'custom_tool_call', name: 'old', namespace: 'functions', call_id: 'a', input: 'raw' },
    { type: 'custom_tool_call_output', call_id: 'a', output: 'done' }, user('continue'),
  ] });
  assert.deepEqual(captured.messages[0].content[0].input, { input: 'raw' });
});
for (const [name, body] of [
  ['unknown input type', { input: [{ type: 'future_task', content: 'must not disappear' }, user('hi')] }],
  ['bad additional_tools', { input: [additional(null), user('hi')] }],
  ['unknown tool', { tools: [{ type: 'future_builtin', name: 'x' }], input: 'hi' }],
  ['conflicting types', { tools: [fun('x'), custom('x')], input: 'hi' }],
  ['nested namespace', { tools: [ns('a', [ns('b', [fun()])])], input: 'hi' }],
  ['missing agent content', { input: [agent(null)] }],
  ['invalid encrypted carrier', { input: [agent([{ type: 'encrypted_content', encrypted_content: {} }])] }],
  ['unknown agent part', { input: [agent([{ type: 'unknown', text: 'task' }])] }],
  ['nonstring custom history', { input: [{ type: 'custom_tool_call', name: 'x', input: {} }] }],
  ['undeclared tool_choice', { input: 'hi', tool_choice: { type: 'function', name: 'missing' } }],
]) test(`400 before upstream: ${name}`, async () => {
  const before = calls;
  const result = await request(body);
  assert.equal(result.status, 400, result.body);
  assert.equal(calls, before);
});
test('malformed custom output fails instead of returning corrupt call', async () => {
  events = p => [{ type: 'tool-call', toolCallId: 'a', toolName: p.tools[0].name, input: { wrong: 'field' } }];
  const result = await request({ input: [additional([custom()]), user('hi')] });
  assert.equal(result.status, 502);
});
test('undeclared upstream tool fails closed', () => {
  assert.throws(() => registry([fun()]).outputCall('missing', {}, 'a', 'b'), /undeclared/);
  assert.throws(() => registry([]).outputCall('injected_tool', {}, 'a', 'b'), /undeclared/);
});
test('invalid tool after text terminates SSE with response.failed', async () => {
  events = [{ type: 'text-delta', text: 'working' }, { type: 'tool-call', toolCallId: 'a', toolName: 'missing', input: {} }];
  const result = await request({ stream: true, input: [additional([fun()]), user('hi')] });
  assert.equal(result.status, 200);
  assert.match(result.body, /event: response.failed/);
  assert.doesNotMatch(result.body, /event: response.completed/);
});
test('separate requests never reuse aliases', () => {
  const a = registry([ns('a', [fun()])]);
  const b = registry([ns('b', [fun()])]);
  assert.throws(() => b.outputCall(a.tools[0].function.name, {}, 'a', 'b'), /undeclared/);
});
test('only unambiguous declared original tool names can be restored', () => {
  const r = registry([ns('functions', [custom()])]);
  for (const name of ['functions.exec', 'functions__exec', 'exec']) {
    const item = r.outputCall(name, { input: 'text(1)' }, 'a', 'b');
    assert.equal(item.namespace, 'functions');
    assert.equal(item.name, 'exec');
  }
  const ambiguous = registry([ns('a', [fun()]), ns('b', [fun()])]);
  assert.throws(() => ambiguous.outputCall('lookup', {}, 'a', 'b'), /ambiguous/);
});
test('real encrypted delegation is rejected locally with actionable error', async () => {
  const before = calls;
  const result = await request({ input: [agent([{ type: 'encrypted_content', encrypted_content: 'gAAAA' + 'A'.repeat(100) }])] });
  assert.equal(result.status, 400);
  assert.match(result.body, /parent agent route/);
  assert.equal(calls, before);
});
test('DSML remains text and is never interpreted as executable code', async () => {
  const raw = '<｜｜DSML｜｜ invoke name="exec">text(1)</｜｜DSML｜｜ invoke>';
  const result = await good({ input: 'hello' }, [{ type: 'text-delta', text: raw }]);
  assert.equal(JSON.parse(result.body).output[0].type, 'message');
  assert.equal(JSON.parse(result.body).output_text, raw);
});

try {
  for (const t of tests) {
    await t.run();
    process.stdout.write(`PASS ${t.name}\n`);
  }
  process.stdout.write(JSON.stringify({ passed: tests.length, failed: 0, upstream: 'mock' }) + '\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(error.stack + '\n');
  process.exit(1);
}
