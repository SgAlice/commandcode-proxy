import http from 'node:http';
import assert from 'node:assert/strict';
import { prepareResponsesCompatibility, createToolInputCollector } from '../responses-compat.mjs';

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

function request(body, path = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 13051, path, method: 'POST',
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

for (const stream of [false, true]) {
  for (const location of ['top', 'additional']) {
    test(`optional hosted search does not block plain Responses stream=${stream} location=${location}`, async () => {
      const tools = [{ type: 'web_search' }];
      const body = location === 'top' ? { tools, input: 'Reply OK' }
        : { input: [additional(tools), user('Reply OK')] };
      const result = await good({ ...body, stream });
      assert.equal(output(result, stream)[0].content[0].text, 'OK');
      assert.ok(!captured.tools || captured.tools.length === 0);
      assert.match(captured.system, /web_search is unavailable/);
      assert.match(captured.system, /Never claim to have searched/);
    });
  }
  for (const [label, input] of [
    ['object wrapper', { input: 'const x = "雪";\ntext(x);' }],
    ['serialized wrapper', JSON.stringify({ input: 'const x = "雪";\ntext(x);' })],
    ['raw code', 'const x = "雪";\ntext(x);'],
    ['encoded code string', JSON.stringify('const x = "雪";\ntext(x);')],
    ['empty code', ''],
  ]) {
    test(`custom output variant ${label} stream=${stream}`, async () => {
      const result = await good({ stream, input: [additional([ns('functions', [custom()])]), user('call tool')] }, p => [
        { type: 'tool-call', toolCallId: 'variant', toolName: p.tools[0].name, input },
      ]);
      const item = output(result, stream)[0];
      assert.equal(item.type, 'custom_tool_call');
      assert.equal(item.namespace, 'functions');
      assert.equal(item.input, label === 'empty code' ? '' : 'const x = "雪";\ntext(x);');
      await good({ stream, input: [additional([ns('functions', [custom()])]), item,
        { type: 'custom_tool_call_output', call_id: 'variant', output: 'done' }] });
      assert.deepEqual(captured.messages[0].content[0].input, { input: item.input });
    });
  }
  test(`optional search leaves other tool parameters intact stream=${stream}`, async () => {
    const result = await good({ stream, tools: [{ type: 'web_search' }, fun()], input: 'call lookup' }, () => [
      { type: 'tool-call', toolCallId: 'f', toolName: 'lookup', input: { n: 17 } },
    ]);
    assert.equal(captured.tools.length, 1);
    assert.deepEqual(JSON.parse(output(result, stream)[0].arguments), { n: 17 });
  });
}
for (const type of ['web_search_preview', 'web_search_preview_2025_03_11']) {
  test(`optional legacy search declaration ${type}`, async () => {
    await good({ tools: [{ type }], input: 'hi' });
    assert.match(captured.system, /web_search is unavailable/);
  });
}
test('explicit or required hosted-only search fails clearly before contacting upstream', async () => {
  for (const tool_choice of [{ type: 'web_search' }, 'required']) {
    const before = calls;
    const result = await request({ tools: [{ type: 'web_search' }], input: 'search', tool_choice });
    assert.equal(result.status, 400);
    assert.match(result.body, /unavailable/);
    assert.equal(calls, before);
  }
});
test('search omission never enables guessed hosted-tool calls', () => {
  const r = registry([{ type: 'web_search' }]);
  assert.throws(() => r.outputCall('web_search', { query: 'test' }, 'a', 'b'), /undeclared/);
});
test('unambiguous object validation remains fail-closed with value-free diagnostics', () => {
  const r = registry([custom()]);
  for (const args of [{ code: 'PRIVATE_CODE_SENTINEL' }, { cmd: 'PRIVATE_CMD_SENTINEL' }, { input: {} }, []]) {
    assert.throws(() => r.outputCall('exec', args, 'a', 'b'), e => {
      assert.match(e.message, /shape=/);
      assert.doesNotMatch(e.message, /PRIVATE_/);
      return true;
    });
  }
});
test('Requests without hosted search do not receive a new capability prompt', async () => {
  await good({ instructions: 'existing system', input: 'hi', tools: [fun()] });
  assert.equal(captured.system, 'existing system');
});
for (const stream of [false, true]) {
  for (const raw of ['text("raw survives");', JSON.stringify({ input: 'text("raw survives");' }), '{}']) {
    test(`recover matched raw argument deltas stream=${stream} serialized=${raw.startsWith('{')}`, async () => {
      const result = await good({ stream, tools: [ns('functions', [custom()])], input: 'call exec' }, p => [
        { type: 'tool-input-start', id: 'recover', toolName: p.tools[0].name },
        { type: 'tool-input-delta', id: 'recover', delta: raw.slice(0, 5) },
        { type: 'tool-input-delta', id: 'recover', delta: raw.slice(5) },
        { type: 'tool-input-end', id: 'recover' },
        { type: 'tool-call', toolCallId: 'recover', toolName: p.tools[0].name, input: {} },
      ]);
      assert.equal(output(result, stream)[0].input, raw === '{}' ? '{}' : 'text("raw survives");');
    });
  }
  test(`interleaved custom streams never mix calls stream=${stream}`, async () => {
    const result = await good({ stream, tools: [custom('a'), custom('b')], input: 'call tools' }, () => [
      { type: 'tool-input-start', id: '1', toolName: 'a' },
      { type: 'tool-input-start', id: '2', toolName: 'b' },
      { type: 'tool-input-delta', id: '1', delta: 'text(' },
      { type: 'tool-input-delta', id: '2', delta: 'text(2);' },
      { type: 'tool-input-delta', id: '1', delta: '1);' },
      { type: 'tool-call', toolCallId: '2', toolName: 'b', input: {} },
      { type: 'tool-call', toolCallId: '1', toolName: 'a', input: {} },
    ]);
    assert.deepEqual(output(result, stream).map(x => [x.call_id, x.input]), [['2', 'text(2);'], ['1', 'text(1);']]);
  });
}
test('collector accepts SDK UI delta fields, releases buffers and enforces size limit', () => {
  const c = createToolInputCollector({ maxBytes: 8 });
  c.observe({ type: 'tool-input-start', toolCallId: 'a', toolName: 'exec' });
  c.observe({ type: 'tool-input-delta', toolCallId: 'a', inputTextDelta: 'text(1)' });
  assert.equal(c.take({ toolCallId: 'a' }).text, 'text(1)');
  assert.equal(c.take({ toolCallId: 'a' }).text, undefined);
  c.observe({ type: 'tool-input-start', id: 'b', toolName: 'exec' });
  assert.throws(() => c.observe({ type: 'tool-input-delta', id: 'b', delta: 'x'.repeat(9) }), /buffer limit/);
});
test('raw fallback rejects other tools and missing IDs but preserves original JSON text', () => {
  const r = registry([custom('a'), custom('b')]);
  assert.throws(() => r.outputCall('a', {}, '1', 'x', 'completed', { name: 'b', text: 'text(1);' }), /string input/);
  assert.equal(r.outputCall('a', {}, '1', 'x', 'completed', { name: 'a', text: '{"code":"do not guess"}' }).input, '{"code":"do not guess"}');
  const c = createToolInputCollector();
  c.observe({ type: 'tool-input-delta', id: 'missing', delta: 'do not recover' });
  assert.equal(c.take({ toolCallId: 'missing' }).text, undefined);
});
test('readable namespace aliases avoid opaque hashes for ordinary tools', () => {
  const r = registry([ns('functions', [custom()])]);
  assert.equal(r.tools[0].function.name, 'functions__exec');
});
test('exact legacy hashed names remain compatible during a rolling upgrade', () => {
  const r = registry([ns('functions', [custom()])]);
  // SHA-256 of JSON.stringify(["functions", "exec"]), same deterministic legacy mapping.
  const legacy = 'cc_tool_functions_exec_add2bac04685f47872f9';
  const item = r.outputCall(legacy, { input: 'text(1)' }, 'a', 'b');
  assert.equal(item.namespace, 'functions');
  assert.equal(item.name, 'exec');
  assert.equal(item.input, 'text(1)');
});
for (const raw of ['{}', '[]', 'null', '42', '{"cmd":"do not extract this"}']) {
  test(`raw custom JSON text is preserved exactly: ${raw}`, () => {
    const r = registry([custom()]);
    assert.equal(r.outputCall('exec', raw, 'a', 'b').input, raw);
    assert.equal(r.outputCall('exec', {}, 'a', 'b', 'completed', { name: 'exec', text: raw }).input, raw);
  });
}
test('ordinary function streams are not buffered or transformed', () => {
  const r = registry([fun()]);
  const c = createToolInputCollector({ maxBytes: 1, acceptName: r.isCustomTool });
  c.observe({ type: 'tool-input-start', id: 'a', toolName: 'lookup' });
  c.observe({ type: 'tool-input-delta', id: 'a', delta: 'a large ordinary JSON argument' });
  assert.equal(c.take({ toolCallId: 'a' }).text, undefined);
});
for (const stream of [false, true]) {
  test(`nullable optional tools preserve ordinary Responses stream=${stream}`, async () => {
    const result = await good({ stream, tools: null, instructions: 'original system', input: 'hi' });
    assert.equal(output(result, stream)[0].content[0].text, 'OK');
    assert.equal(captured.system, 'original system');
  });
  test(`ordinary function input field is not unwrapped stream=${stream}`, async () => {
    const args = { input: 'ordinary field', n: 7 };
    const result = await good({ stream, tools: [fun('exec')], input: 'call exec' }, () => [
      { type: 'tool-call', toolCallId: 'ordinary', toolName: 'exec', input: args },
    ]);
    assert.deepEqual(JSON.parse(output(result, stream)[0].arguments), args);
  });
  for (const path of ['/v1/chat/completions', '/v1/messages']) {
    test(`unchanged direct endpoint ${path} text stream=${stream}`, async () => {
      events = ok;
      const result = await request({ stream, max_tokens: 32, messages: [{ role: 'user', content: 'reply OK' }] }, path);
      assert.equal(result.status, 200, result.body);
      assert.deepEqual(captured.messages, [{ role: 'user', content: [ccText('reply OK')] }]);
      assert.doesNotMatch(captured.system, /Gateway capability notice/);
      if (stream) assert.match(result.body, path === '/v1/messages' ? /event: message_stop/ : /\[DONE\]/);
      else if (path === '/v1/messages') assert.equal(JSON.parse(result.body).content[0].text, 'OK');
      else assert.equal(JSON.parse(result.body).choices[0].message.content, 'OK');
    });
    test(`unchanged direct endpoint ${path} function arguments stream=${stream}`, async () => {
      const args = { input: 'ordinary field', n: 17 };
      events = [{ type: 'tool-call', toolCallId: 'native', toolName: 'lookup', input: args }];
      const tool = path === '/v1/messages'
        ? { name: 'lookup', description: 'test', input_schema: fun().parameters }
        : { type: 'function', function: { name: 'lookup', parameters: fun().parameters } };
      const result = await request({ stream, max_tokens: 64, tools: [tool], messages: [{ role: 'user', content: 'call lookup' }] }, path);
      assert.equal(result.status, 200, result.body);
      assert.equal(captured.tools[0].name, 'lookup');
      if (stream) assert.match(result.body, /lookup/);
      else if (path === '/v1/messages') assert.deepEqual(JSON.parse(result.body).content.find(x => x.type === 'tool_use').input, args);
      else assert.deepEqual(JSON.parse(JSON.parse(result.body).choices[0].message.tool_calls[0].function.arguments), args);
    });
  }
}

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
