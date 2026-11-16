// HTTP front door: routing, bearer-token authentication, body reading, and replies.
//
// Routing uses plain string operations — no URL parsing on the hot paths — and every reply
// carries an explicit Content-Length so the suite's keep-alive connections stay open. All
// routes except GET /healthz require `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; when the
// environment token is empty (local development only) every request is accepted.

import http from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

const MAX_BODY = 64 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

function parseQuery(queryString) {
  const query = {};
  if (queryString === '') return query;
  const pairs = queryString.split('&');
  for (const pair of pairs) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    let key;
    let value;
    if (eq < 0) {
      key = pair;
      value = '';
    } else {
      key = pair.slice(0, eq);
      value = pair.slice(eq + 1);
    }
    try {
      key = decodeURIComponent(key.replace(/\+/g, ' '));
    } catch { /* keep raw */ }
    try {
      value = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch { /* keep raw */ }
    query[key] = value;
  }
  return query;
}

function splitPath(path) {
  const parts = path.split('/');
  const segments = [];
  for (const part of parts) {
    if (part === '') continue;
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      segments.push(part);
    }
  }
  return segments;
}

export function createServer({ store, token }) {
  let requestCounter = 0;

  const send = (res, status, body, contentType, extraHeaders) => {
    const headers = {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'X-GitHub-Request-Id': (requestCounter++).toString(16).padStart(8, '0'),
      ...extraHeaders,
    };
    res.writeHead(status, headers);
    res.end(body);
  };

  const sendJson = (res, status, value, extraHeaders) => {
    if (value === null || value === undefined) {
      send(res, status, Buffer.alloc(0), 'application/json', extraHeaders);
      return;
    }
    send(res, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json', extraHeaders);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    let bodyLength = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (tooLarge) {
          sendJson(res, 413, { message: 'request body too large' });
          return;
        }
        const body = chunks.length === 0 ? EMPTY_BODY : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        const rawUrl = req.url ?? '/';
        const qmark = rawUrl.indexOf('?');
        const path = qmark < 0 ? rawUrl : rawUrl.slice(0, qmark);
        const query = qmark < 0 ? {} : parseQuery(rawUrl.slice(qmark + 1));
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          send(res, 200, Buffer.from('ok', 'utf8'), 'text/plain');
          return;
        }

        // Authentication: every other route requires the shop token.
        if (token !== undefined && token !== '') {
          const auth = req.headers.authorization ?? '';
          if (auth !== `Bearer ${token}`) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
        }

        const ctx = {
          store,
          method,
          query,
          body,
          json: null,
          host: req.headers.host ?? 'localhost',
          headers: req.headers,
          segments: [],
        };

        if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
          const result = handleGraphQL(ctx);
          sendJson(res, result.status, result.json, result.headers);
          return;
        }
        if (path === '/mcp' || path.startsWith('/mcp/')) {
          const result = handleMcp(ctx);
          sendJson(res, result.status, result.json, result.headers);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          ctx.segments = splitPath(path.slice('/api/v3'.length));
          if (method !== 'GET' && body.length > 0) {
            try {
              ctx.json = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'invalid JSON body' });
              return;
            }
          }
          const result = handleRest(ctx);
          if (result.buffer !== undefined) {
            send(res, result.status, result.buffer, result.contentType ?? 'application/json', result.headers);
          } else {
            sendJson(res, result.status, result.json, result.headers);
          }
          return;
        }

        // Git smart-HTTP: /<owner>/<repo>.git/<endpoint>
        const segments = splitPath(path);
        if (
          segments.length >= 3
          && segments[1].endsWith('.git')
          && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack'
            || (segments[2] === 'info' && segments[3] === 'refs'))
        ) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -4);
          const repo = owner === undefined ? null : (store.getRepo(owner, repoName) ?? null);
          if (segments[2] === 'info') {
            if (method !== 'GET') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const result = handleInfoRefs(repo, query.service, req.headers['git-protocol']);
            send(res, result.status, result.body, result.contentType);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          try {
            const result = segments[2] === 'git-upload-pack'
              ? handleUploadPack(repo, body)
              : handleReceivePack(repo, body);
            send(res, result.status, result.body, result.contentType);
          } catch (error) {
            // A malformed git request is a 400; the server stays healthy.
            sendJson(res, 400, { message: error instanceof Error ? error.message : 'malformed request' });
          }
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        console.error('request failed:', error);
        if (!res.headersSent) sendJson(res, 500, { message: 'internal error' });
        else res.end();
      }
    });
    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 400, { message: 'request error' });
      else res.end();
    });
  });

  server.on('clientError', (error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  });

  return server;
}
