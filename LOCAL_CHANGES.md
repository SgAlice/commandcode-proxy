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

## Validation

26 network-isolated mock regression tests passed (including tool images, mixed
content, parallel results, malformed tool images, and both streaming modes). Earlier live tests with
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
  --entrypoint node commandcode-proxy-private:test /app/tests/responses-images.mjs
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
