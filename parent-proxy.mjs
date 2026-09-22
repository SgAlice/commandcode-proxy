import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { prepareParentRequest, restoreParentResponse, ParentSseDecoder } from './codex-parent-compat.mjs';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding',
  'accept-encoding', 'cookie', 'set-cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
function safeHeaders(headers) {
  const entries = headers instanceof Headers ? [...headers] : Object.entries(headers);
  const excluded = new Set(hopHeaders);
  const connection = entries.find(([k]) => k.toLowerCase() === 'connection')?.[1];
  for (const name of String(connection || '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(entries.filter(([k, v]) => v !== undefined && !excluded.has(k.toLowerCase())));
}
function sendError(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: 'compatibility_error', message } }));
}
async function limitedBody(iterable, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of iterable) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Body exceeds configured limit'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function write(res, data) {
  if (res.destroyed) throw new Error('Client disconnected');
  if (res.write(data)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Client disconnected')); };
    const failed = e => { cleanup(); reject(e); };
    res.once('drain', drained); res.once('close', closed); res.once('error', failed);
  });
}

export function createParentProxy({ upstream, timeoutMs = 600000, maxBytes = 100 * 1024 * 1024,
  maxFrameBytes = 16 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const base = new URL(upstream);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('PARENT_UPSTREAM_BASE must be an HTTP(S) base URL without credentials, query or fragment');
  }
  const target = base.toString().replace(/\/$/, '');
  const server = http.createServer(async (req, res) => {
    // Exact origin-form paths only. No arbitrary URL forwarding or redirects.
    if (req.method === 'GET' && req.url === '/health') { res.end('OK'); return; }
    const responses = req.method === 'POST' && req.url === '/v1/responses';
    const compact = req.method === 'POST' && req.url === '/v1/responses/compact';
    const models = req.method === 'GET' && req.url === '/v1/models';
    if (!responses && !compact && !models) { sendError(res, 404, 'Unsupported endpoint'); return; }
    if (!req.headers.authorization && !req.headers['x-api-key']) { sendError(res, 401, 'Authorization is required'); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref();
    req.once('aborted', () => abort.abort());
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      let body;
      if (responses || compact) {
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
          sendError(res, 415, 'Compressed request bodies are unsupported'); return;
        }
        if (Number(req.headers['content-length']) > maxBytes) { req.resume(); sendError(res, 413, 'Body exceeds configured limit'); return; }
        let parsed;
        try { parsed = JSON.parse(await limitedBody(req, maxBytes)); }
        catch (error) { if (error.statusCode) throw error; throw Object.assign(new Error('Invalid JSON request'), { statusCode: 400 }); }
        body = JSON.stringify(responses ? prepareParentRequest(parsed) : parsed);
      }
      const headers = safeHeaders(req.headers);
      headers['accept-encoding'] = 'identity';
      if (responses || compact) headers['content-type'] = 'application/json';
      const upstreamResponse = await fetchImpl(target + (responses ? '/responses' : compact ? '/responses/compact' : '/models'), {
        method: req.method, headers, body, redirect: 'manual', signal: abort.signal,
      });
      const outHeaders = safeHeaders(upstreamResponse.headers);
      // Prevent callers from following an upstream redirect with credentials.
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        sendError(res, 502, 'Upstream redirects are not followed'); return;
      }
      const contentType = upstreamResponse.headers.get('content-type') || '';
      if (responses && upstreamResponse.ok && contentType.includes('text/event-stream')) {
        res.writeHead(upstreamResponse.status, { ...outHeaders, 'content-type': 'text/event-stream',
          'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        const decoder = new ParentSseDecoder(maxFrameBytes);
        for await (const chunk of upstreamResponse.body) {
          for (const frame of decoder.push(chunk)) await write(res, frame);
        }
        for (const frame of decoder.push(undefined, true)) await write(res, frame);
        res.end();
      } else {
        let text = upstreamResponse.body ? await limitedBody(upstreamResponse.body, maxBytes) : '';
        if (responses && upstreamResponse.ok) {
          text = JSON.stringify(restoreParentResponse(JSON.parse(text)));
        }
        res.writeHead(upstreamResponse.status, outHeaders);
        res.end(text);
      }
    } catch (error) {
      abort.abort();
      if (!res.headersSent) sendError(res, error.statusCode || 502,
        error.statusCode ? error.message : 'Parent upstream transport or response error');
      else if (!res.destroyed && !res.writableEnded) {
        // Never manufacture response.completed after a broken upstream stream.
        res.end('event: error\ndata: {"type":"error","code":"parent_compat_error","message":"Parent upstream transport or response error"}\n\n');
      }
      // Deliberately do not log body, headers, keys, prompts or upstream errors.
    } finally { clearTimeout(timer); }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 60000);
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.PARENT_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Parent proxy must bind to loopback');
  const port = Number(process.env.PARENT_PORT || 3051);
  const timeoutMs = Number(process.env.PARENT_TIMEOUT_MS || 600000);
  const maxBytes = Number(process.env.PARENT_MAX_BODY_MB || 100) * 1024 * 1024;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid parent proxy limits');
  const server = createParentProxy({ upstream: process.env.PARENT_UPSTREAM_BASE, timeoutMs, maxBytes });
  server.listen(port, host, () => console.log(`Parent compatibility proxy listening on ${host}:${port}`));
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 15000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
