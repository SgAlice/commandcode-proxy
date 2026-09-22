// Native Responses-to-Responses adaptation. Never inspect/rewrite user text,
// argument strings, tool results, reasoning ciphertext or embedded documents.
export const ORIGINAL_NAMESPACE = 'collaboration';
export const WIRE_NAMESPACE = 'cc_collaboration_plain';
const messageTools = new Set(['spawn_agent', 'send_message', 'followup_task']);
const calls = new Set(['function_call', 'custom_tool_call']);
const bad = message => Object.assign(new Error(message), { statusCode: 400 });

function toolLists(body) {
  return [body.tools, ...(Array.isArray(body.input)
    ? body.input.filter(x => x?.type === 'additional_tools').map(x => x.tools) : [])].filter(Array.isArray);
}
function mapName(item, from, to) {
  if (item.namespace === from) item.namespace = to;
  for (const separator of ['.', '__']) {
    if (typeof item.name === 'string' && item.name.startsWith(from + separator)) {
      item.name = to + item.name.slice(from.length);
    }
  }
}
function mapTools(tools, from, to, stripEncryption, parentNamespace) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'namespace') {
      const originalNamespace = tool.name;
      if (tool.name === from) {
        tool.name = to;
        if (stripEncryption && Array.isArray(tool.tools)) {
          for (const child of tool.tools) {
            if (messageTools.has(child?.name) && child.parameters?.properties?.message) {
              delete child.parameters.properties.message.encrypted;
            }
          }
        }
      }
      mapTools(tool.tools, from, to, stripEncryption, originalNamespace);
    } else if (tool.type === 'function') {
      const originalName = tool.name;
      const name = typeof originalName === 'string'
        ? originalName.replace(new RegExp(`^${from}(?:\\.|__)`), '') : '';
      if (stripEncryption && (tool.namespace === from || originalName !== name || (!parentNamespace && messageTools.has(originalName)))
        && messageTools.has(name) && tool.parameters?.properties?.message) {
        delete tool.parameters.properties.message.encrypted;
      }
      mapName(tool, from, to);
    }
  }
}
function hasReserved(tools) {
  return tools.some(t => t && (t.name === WIRE_NAMESPACE || t.namespace === WIRE_NAMESPACE
    || (typeof t.name === 'string' && (t.name.startsWith(WIRE_NAMESPACE + '.') || t.name.startsWith(WIRE_NAMESPACE + '__')))
    || (t.type === 'namespace' && Array.isArray(t.tools) && hasReserved(t.tools))));
}

export function prepareParentRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Expected a Responses JSON object');
  if (body.previous_response_id) throw bad('Parent compatibility requires full stateless input; previous_response_id is unsupported');
  const result = structuredClone(body);
  const lists = toolLists(result);
  if (lists.some(hasReserved)) throw bad(`Reserved compatibility namespace: ${WIRE_NAMESPACE}`);
  for (const tools of lists) mapTools(tools, ORIGINAL_NAMESPACE, WIRE_NAMESPACE, true);
  if (Array.isArray(result.input)) {
    for (const item of result.input) {
      if (calls.has(item?.type)) mapName(item, ORIGINAL_NAMESPACE, WIRE_NAMESPACE);
    }
  }
  if (result.tool_choice && typeof result.tool_choice === 'object') {
    mapName(result.tool_choice, ORIGINAL_NAMESPACE, WIRE_NAMESPACE);
    mapTools(result.tool_choice.tools, ORIGINAL_NAMESPACE, WIRE_NAMESPACE, true);
  }
  return result;
}

function restoreCall(item) {
  if (!calls.has(item?.type)) return;
  if (typeof item.name === 'string' && item.name.startsWith(WIRE_NAMESPACE + '.')) {
    item.name = item.name.slice(WIRE_NAMESPACE.length + 1);
    item.namespace = ORIGINAL_NAMESPACE;
    return;
  }
  mapName(item, WIRE_NAMESPACE, ORIGINAL_NAMESPACE);
}
function restoreResponse(response) {
  if (!response || typeof response !== 'object') return;
  if (Array.isArray(response.output)) response.output.forEach(restoreCall);
  mapTools(response.tools, WIRE_NAMESPACE, ORIGINAL_NAMESPACE, false);
}
export function restoreParentResponse(value) {
  // Only recognized envelope locations; do not recurse through arbitrary JSON.
  if (!value || typeof value !== 'object') return value;
  if (value.object === 'response') restoreResponse(value);
  if (typeof value.type === 'string' && value.type.startsWith('response.')) {
    restoreCall(value.item);
    restoreResponse(value.response);
  }
  return value;
}

export function restoreSseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const indexes = [];
  const data = [];
  lines.forEach((line, i) => {
    if (line === 'data' || line.startsWith('data:')) {
      indexes.push(i);
      data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
    }
  });
  const payload = data.join('\n');
  if (!indexes.length || !payload || payload.trim() === '[DONE]') return frame;
  const parsed = JSON.parse(payload);
  restoreParentResponse(parsed);
  lines[indexes[0]] = 'data: ' + JSON.stringify(parsed);
  const remove = new Set(indexes.slice(1));
  return lines.filter((_, i) => !remove.has(i)).join('\n');
}

export class ParentSseDecoder {
  constructor(maxFrameBytes = 16 * 1024 * 1024) {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.buffer = '';
    this.maxFrameBytes = maxFrameBytes;
  }
  push(bytes, final = false) {
    this.buffer += bytes ? this.decoder.decode(bytes, { stream: !final }) : this.decoder.decode();
    const output = [];
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index);
      if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new Error('SSE frame exceeds configured limit');
      output.push(restoreSseFrame(frame) + '\n\n');
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) throw new Error('SSE frame exceeds configured limit');
    if (final && this.buffer) {
      output.push(restoreSseFrame(this.buffer) + '\n\n');
      this.buffer = '';
    }
    return output;
  }
}
