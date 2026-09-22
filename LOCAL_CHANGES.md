# Personally maintained fork

This repository is a personally maintained public fork of
[MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy),
based on upstream commit `407040df375ad031553cb10d948329c091c5b28c`.
The original MIT license and upstream documentation are retained.

## Responses image-input fix

The original Responses adapter flattened all message content to plain text,
silently discarding `input_image` blocks. This copy includes the deployed fix:

- Preserve user-message images and their order among text blocks.
- Translate `input_image.image_url` into the existing Chat `image_url` path,
  which produces Command Code `image` blocks.
- Support data-URI images, image URLs, image-only messages, multiple images,
  and streaming or non-streaming Responses requests.
- Preserve the previous text-only representation and tool-call/history handling.
- Return a clear HTTP 400 for images with missing/invalid URLs, including
  unsupported `file_id`-only inputs, instead of silently discarding them.

## Responses tool-image fix (2026-09-14)

Codex `view_image` returns `input_image` blocks inside
`function_call_output.output`. Previously these were serialized as text, sending
base64 to the language context instead of the vision input.

The adapter now keeps the tool result and call ID, and attaches the original
image/text blocks as explicitly labeled tool data using CC's supported user
image format. Attachments are emitted after the adjacent tool-result batch so
parallel tool calls remain paired before the next user/assistant message.
Invalid image URLs fail locally with HTTP 400. Ordinary tool outputs are unchanged.
This is a compatibility representation, not native multimodal tool-result support.

## Codex Responses Lite compatibility (2026-09-22)

Checked upstream `master` and `release` at `cce214d`; neither handles
`input[].additional_tools` or `agent_message`. This is a focused local fix, not
a merge of unrelated upstream changes. The existing image fixes are retained.

- Lift `additional_tools` into CC's function tool catalog, preserving ordinary
  function schemas and flattening namespaces through a per-request alias map.
- Convert plaintext `agent_message` content into user messages instead of
  silently discarding delegated instructions.
- Bridge custom/free-form tools through a required `{input: string}` parameter;
  restore `custom_tool_call`, namespaces, input strings, call IDs and matching
  tool-result history, including images. Streaming emits the corresponding
  `response.custom_tool_call_input.delta/done` and output-item events.
- Preserve tool grammar descriptions, but do not claim CC enforces Lark or
  regex grammars. Malformed custom argument wrappers fail rather than producing
  corrupted client calls. DSML text is never parsed or executed as a tool call.
- Reject unsupported input/tool types instead of silently dropping them. Tool
  aliases are request-local, deterministic and collision-resistant. Only known,
  unambiguous original spellings are accepted as alternate upstream names.

### Important: parent-agent encryption is a separate prerequisite

This proxy cannot decrypt another provider's encrypted delegation payload.
Third-party routes sometimes put **plaintext** into an `encrypted_content`
carrier; that representation is normalized, not decrypted. Recognizable Fernet
ciphertext is rejected with HTTP 400 and an actionable error, before contacting
the model. Other cryptographic formats are not supported either.

The **parent's** request route must disable message encryption before generating
`collaboration.spawn_agent` / `send_message` / `followup_task` calls. Removing the
`parameters.properties.message.encrypted` schema annotation is done for tools
that actually pass through this bridge. It cannot affect a parent routed through
a different provider. CLIProxyAPI's `codex.optimize-multi-agent-v2` is a separate
gateway feature (including native collaboration namespace rewriting); it is not
a Codex TOML setting or a YAML setting implemented by this project. The optional
[parent compatibility service](PARENT_COMPAT.md) now provides a native Responses
adaptation on that separate route; do not add the CLIProxyAPI YAML option here.

Live validation through an Aether gateway and `deepseek/deepseek-v4.1-flash`
passed plaintext agent-message delivery and a namespaced custom-tool echo/result
round trip, each with streaming on and off (six model requests). The tool was a
synthetic echo; no model-generated code was executed by the test.

Initial native cross-provider testing exposed real encrypted messages from the
separately routed parent. The child-side adapter alone cannot fix that scenario.
After adding the separate parent service, two actual Codex child tasks passed:
a plaintext arithmetic/sentinel task, and a real shell `printf` invocation with
exit code 0. The second child's session record contains a native namespaced
`custom_tool_call` followed by its matching `custom_tool_call_output`, not DSML
text pretending to be a call. Both tasks used the existing child model mapping.

## Optional parent service (2026-09-22)

`parent-proxy.mjs` and `codex-parent-compat.mjs` implement the parent route in this
same repository. `Dockerfile.parent` / `compose.parent.yml` run it in a separate,
loopback-only container on port 3051. The original child container on port 3050
remains independent. See [setup, protocol boundaries and rollback](PARENT_COMPAT.md).

Native parent traffic through the new service was verified before dispatching
the two child probes. Only the gateway's parent Responses endpoint base URL was
changed, using its admin API; provider credentials, model mappings and the child
endpoint were retained. The original URL was backed up outside the repository.

## Validation

87 mock regression tests passed (26 image, 33 child compatibility, 28 parent tests),
including network-isolated execution in the deployment's Node 22 Docker runtime.
The image cases include tool images, mixed content, parallel results, malformed
tool images, and both streaming modes. Earlier live tests with
`deepseek/deepseek-v4.1-flash` also passed for direct non-streaming Responses
and streaming Responses through an Aether gateway, correctly recognizing a
generated diagnostic image containing a red circle and a blue square.

The tool-image fix was separately tested against the real model with a synthetic
left-red/right-blue image in a `function_call_output`, using both streaming and
non-streaming Responses. Both completed and correctly identified the colors.

Re-run the mock tests without credentials or external network access:

```sh
docker build -t commandcode-proxy-private:test .
docker run --rm --network none --read-only --user node \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$PWD/tests:/app/tests:ro" \
  --entrypoint npm commandcode-proxy-private:test test
```

## Local-only deployment

On a Linux Docker host, use the included local-only Compose file:

```sh
docker compose -f compose.local.yml up -d --build
```

This keeps the proxy bound to `127.0.0.1:3050`; a separate gateway may expose
the desired authenticated public interface. The upstream `docker-compose.yml`
is also retained, but its default port publication is not local-only.

No actual API keys, gateway credentials, production logs, server backups, or
live-test credential-loading scripts are included. The committed `config.json`
is the upstream sample with an empty API key. Supply credentials through request
headers; do not commit real secrets into the sample.

The upstream automatic container-publishing workflow was intentionally omitted
from this fork to avoid unintended package publication.

## Future updates

This is a local patch, not an upstream release. Before replacing the code with
a newer upstream version, preserve or merge the Responses image-input fix and
re-run the regression tests above. Upstream Git history is retained. Do not push these personal patches upstream
or open a pull request unless explicitly requested.
