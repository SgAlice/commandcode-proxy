import { createHash } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const identity = (namespace, name) => JSON.stringify([namespace || '', name]);

// A per-request registry: never guess how to split a flattened name, and never
// share aliases across clients. Custom tools cross the function-only CC wire as
// {input: string}, then become native Responses custom_tool_call items again.
export function prepareResponsesCompatibility(request) {
  const entries = new Map();
  const aliases = new Map();
  const definitions = new Map();
  const alternateNames = new Map();

  function register(name, namespace, type) {
    if (typeof name !== 'string' || !name || (namespace != null && typeof namespace !== 'string')) {
      throw invalid('Responses tools require a non-empty name and an optional string namespace');
    }
    const key = identity(namespace, name);
    const previous = entries.get(key);
    if (previous) {
      if (previous.type !== type) throw invalid('Conflicting Responses tool types for the same name');
      return previous;
    }
    // Reserve cc_tool_ for encoded names, including collisions with root tools.
    const readable = `${namespace || ''}_${name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const alias = !namespace && /^[A-Za-z0-9_-]{1,64}$/.test(name) && !name.startsWith('cc_tool_')
      ? name : 'cc_tool_' + readable + '_' + createHash('sha256').update(key).digest('hex').slice(0, 20);
    if (aliases.has(alias)) throw invalid('Responses tool alias collision');
    const entry = { name, namespace: namespace || undefined, type, alias };
    entries.set(key, entry);
    aliases.set(alias, entry);
    // Accept only known, unambiguous names from the declared catalog. Some
    // models copy the original tool spelling from Codex's system instructions.
    for (const spelling of [name, ...(namespace ? [`${namespace}.${name}`, `${namespace}__${name}`] : [])]) {
      if (!alternateNames.has(spelling)) alternateNames.set(spelling, entry);
      else if (alternateNames.get(spelling) !== entry) alternateNames.set(spelling, null);
    }
    return entry;
  }

  function addTools(tools, namespace) {
    if (!Array.isArray(tools)) throw invalid('Responses tools must be an array');
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') throw invalid('Invalid Responses tool definition');
      if (tool.type === 'namespace') {
        if (namespace || typeof tool.name !== 'string' || !tool.name) {
          throw invalid('Nested or unnamed Responses namespaces are not supported');
        }
        addTools(tool.tools, tool.name);
        continue;
      }
      if (tool.type !== 'function' && tool.type !== 'custom') {
        throw invalid(`Unsupported Responses tool type: ${tool.type}`);
      }
      const entry = register(tool.name, namespace || tool.namespace, tool.type);
      let description = tool.description || '';
      if (entry.namespace) description = `Responses tool ${entry.namespace}.${entry.name}.\n${description}`;
      let parameters = tool.parameters || { type: 'object', properties: {} };
      if (tool.type === 'custom') {
        description += '\nPass the exact free-form tool input as the input string. Do not JSON-encode the string a second time.';
        if (tool.format?.type === 'grammar') {
          description += `\nInput grammar (${tool.format.syntax || 'text'}):\n${tool.format.definition || ''}`;
        }
        parameters = {
          type: 'object', properties: { input: { type: 'string', description: 'Exact free-form tool input' } },
          required: ['input'], additionalProperties: false,
        };
      } else if (entry.namespace === 'collaboration' && ['spawn_agent', 'send_message', 'followup_task'].includes(entry.name)) {
        // OpenAI's encrypted schema annotation is not a portable JSON Schema
        // feature. Request plaintext for delegation authored through this bridge.
        parameters = structuredClone(parameters);
        if (parameters.properties?.message) delete parameters.properties.message.encrypted;
      }
      // Later additional_tools declarations may update an existing definition.
      definitions.set(entry.alias, { type: 'function', function: { name: entry.alias, description, parameters } });
    }
  }
  if (request.tools !== undefined) addTools(request.tools);
  const input = Array.isArray(request.input) ? request.input : [];
  for (const item of input) if (item?.type === 'additional_tools') addTools(item.tools);
  // Full stateless history may include a tool that is no longer offered.
  for (const item of input) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      register(item.name, item.namespace, item.type === 'custom_tool_call' ? 'custom' : 'function');
    }
  }

  const normalizedInput = input.flatMap(item => {
    if (item?.type === 'additional_tools') return [];
    if (item?.type === 'agent_message') {
      let content = item.content;
      if (Array.isArray(content)) content = content.map(part => {
        if (part?.type !== 'encrypted_content') return part;
        // Some third-party Codex routes use this field for the original text.
        // This is a representation conversion, NOT cryptographic decryption.
        if (typeof part.encrypted_content !== 'string') throw invalid('Invalid agent_message encrypted_content');
        if (/^gAAAA[A-Za-z0-9_-]{70,}={0,2}$/.test(part.encrypted_content.trim())) {
          throw invalid('Encrypted Codex agent_message cannot be decrypted by this proxy. Disable message encryption on the parent agent route before spawning; resend the task in plaintext.');
        }
        return { type: 'input_text', text: part.encrypted_content };
      });
      if (typeof content !== 'string' && !Array.isArray(content)) throw invalid('agent_message requires content');
      if (Array.isArray(content) && content.some(p => p && !['input_text', 'text', 'input_image'].includes(p.type))) {
        throw invalid('Unsupported agent_message content type');
      }
      return [{ type: 'message', role: 'user', content }];
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const entry = entries.get(identity(item.namespace, item.name));
      if (entry.type === 'custom' && typeof item.input !== 'string') throw invalid('custom_tool_call requires string input');
      return [{ ...item, type: 'function_call', name: entry.alias,
        arguments: entry.type === 'custom' ? JSON.stringify({ input: item.input }) : item.arguments }];
    }
    if (item?.type === 'custom_tool_call_output') return [{ ...item, type: 'function_call_output' }];
    return [item];
  });

  function toolChoice(choice) {
    if (choice == null || typeof choice === 'string') return choice;
    if (!['function', 'custom'].includes(choice.type)) throw invalid('Unsupported Responses tool_choice');
    const entry = entries.get(identity(choice.namespace, choice.name));
    if (!entry || !definitions.has(entry.alias)) throw invalid('tool_choice references an undeclared tool');
    return { type: 'function', function: { name: entry.alias } };
  }

  function outputCall(name, args, callId, id, status = 'completed') {
    const entry = aliases.get(name) || alternateNames.get(name);
    if (!entry) throw new Error(`Upstream returned an undeclared or ambiguous tool name: ${String(name).slice(0, 100)}`);
    const base = { id, call_id: callId, name: entry?.name || name, status };
    if (entry?.namespace) base.namespace = entry.namespace;
    if (entry?.type === 'custom') {
      let parsed;
      try { parsed = typeof args === 'string' ? JSON.parse(args) : args; } catch { /* fail closed below */ }
      if (!parsed || typeof parsed.input !== 'string') throw new Error('Upstream custom tool arguments must contain a string input');
      return { ...base, type: 'custom_tool_call', input: parsed.input };
    }
    return { ...base, type: 'function_call', arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) };
  }

  return { input: Array.isArray(request.input) ? normalizedInput : request.input,
    tools: [...definitions.values()], toolChoice: toolChoice(request.tool_choice), outputCall };
}
