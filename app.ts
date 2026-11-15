// HTTP server and router: health checks, authentication, request ids, and
// dispatch to the git, REST, GraphQL, and MCP surfaces. Every reply carries
// a non-empty X-GitHub-Request-Id. A handler failure never kills the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

const JSON_TYPE = 'application/json';

export interface ForgeServer {
  server: Server;
  forge: Forge;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function createForgeServer(): ForgeServer {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length);
    if (presented.length === 0) return false;
    if (expectedToken === '') return true;
    return presented === expectedToken;
  }

  function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer, extra: Record<string, string> = {}): void {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    requestCounter += 1;
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': payload.length,
      'X-GitHub-Request-Id': `req-${requestCounter}`,
      ...extra,
    });
    res.end(payload);
  }

  function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
    send(res, status, JSON_TYPE, JSON.stringify(value), extra);
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bodyLength = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (bodyTooLarge) return;
      chunks.push(chunk);
      bodyLength += chunk.length;
      if (bodyLength > 64 * 1024 * 1024) bodyTooLarge = true;
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        // Socket already gone.
      }
    });
    req.on('end', () => {
      try {
        if (bodyTooLarge) {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        dispatch(req, res, Buffer.concat(chunks));
      } catch (error) {
        console.error('forge handler error:', (error as Error).message);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.destroy();
      }
    });
  });

  function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const pathname = url.pathname;

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch) {
      const owner = decodeSegment(gitMatch[1]);
      const repoName = decodeSegment(gitMatch[2]);
      if (owner === null || repoName === null) {
        send(res, 400, 'text/plain; charset=utf-8', 'bad path encoding');
        return;
      }
      const tail = gitMatch[3] ?? '';
      const result = handleGit(forge, {
        method,
        owner,
        repoName,
        tail,
        query: url.searchParams,
        headers: req.headers,
        body,
      });
      if (result) {
        send(res, result.status, result.contentType, result.body);
        return;
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }

    // REST v3.
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const rawSegments = pathname.slice('/api/v3'.length).split('/').filter((s) => s.length > 0);
      const segments: string[] = [];
      for (const raw of rawSegments) {
        const decoded = decodeSegment(raw);
        if (decoded === null) {
          sendJson(res, 400, { message: 'Bad path encoding' });
          return;
        }
        segments.push(decoded);
      }
      const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
      if (!isPublic && !authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const result = handleRest(forge, {
        method,
        segments,
        query: url.searchParams,
        host: req.headers.host ?? '127.0.0.1',
        body,
      });
      send(res, result.status, JSON_TYPE, result.body, result.headers);
      return;
    }

    // GraphQL.
    if (pathname === '/api/graphql') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const result = handleGraphQL(forge, body);
      send(res, result.status, JSON_TYPE, result.body);
      return;
    }

    // MCP.
    if (pathname === '/mcp') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const result = handleMcp(forge, method, body);
      const contentType = result.body.length > 0 ? JSON_TYPE : 'text/plain; charset=utf-8';
      send(res, result.status, contentType, result.body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return { server, forge };
}
