import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildContentDisposition } from './file-store.js';
import { loadMoodleConfig, MoodleClient, type MoodleConfig } from './moodle.js';
import { requestContextStorage } from './request-context.js';
import { createServer, SERVER_VERSION } from './server.js';

export interface MoodleHttpServerOptions {
  config?: MoodleConfig;
  authToken?: string;
  client?: MoodleClient;
}

export interface MoodleHttpServerInstance {
  httpServer: http.Server;
  client: MoodleClient;
  close: () => Promise<void>;
}

function safeTokenEquals(candidate: string | undefined | null, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}

function inferPublicBaseUrl(req: http.IncomingMessage, configuredBaseUrl?: string): string {
  if (configuredBaseUrl && configuredBaseUrl.trim()) {
    return configuredBaseUrl.trim().replace(/\/+$/, '');
  }
  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
  const host =
    firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
  const prefixRaw = firstHeaderValue(req.headers['x-forwarded-prefix']) || '';
  const prefix = prefixRaw ? `/${prefixRaw.replace(/^\/+|\/+$/g, '')}` : '';
  return `${proto}://${host}${prefix}`.replace(/\/+$/, '');
}

export function createMoodleHttpServer(
  options: MoodleHttpServerOptions = {}
): MoodleHttpServerInstance {
  const config = options.config ?? loadMoodleConfig();
  const authToken =
    options.authToken !== undefined ? options.authToken : process.env.MCP_AUTH_TOKEN;
  const sharedClient = options.client ?? new MoodleClient(config);

  const handler = createMcpHandler(() => createServer(config, sharedClient), {
    responseMode: 'json',
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = url.pathname;
    let pathHasToken = false;

    if (authToken) {
      const tokenPrefix = `/${authToken}`;
      if (pathname === tokenPrefix || pathname.startsWith(`${tokenPrefix}/`)) {
        pathHasToken = true;
        pathname = pathname.slice(tokenPrefix.length) || '/';
      }
    }

    // 1. Temporary Capability File Download Endpoint: GET/HEAD /files/<dl_token>[/<filename>]
    if (pathname.startsWith('/files/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          'Content-Type': 'application/json; charset=utf-8',
          Allow: 'GET, HEAD',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }

      const relParts = pathname.slice('/files/'.length).split('/').filter(Boolean);
      const candidateDlToken = relParts[0] ? decodeURIComponent(relParts[0]) : '';
      const entry = sharedClient.fileStore.getByDownloadToken(candidateDlToken);

      if (!entry) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(
          JSON.stringify({
            error: 'file_not_found_or_expired',
            message:
              'Arquivo temporário não encontrado ou prazo de validade expirado. Execute download_moodle_file novamente para gerar uma nova referência.',
          })
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': entry.mimeType,
        'Content-Length': String(entry.sizeBytes),
        'Content-Disposition': buildContentDisposition(entry.originalFilename),
        'X-Content-SHA256': entry.sha256,
        'X-Original-Filename': encodeURIComponent(entry.originalFilename),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(entry.diskPath);
      stream.on('error', (err) => {
        console.error(
          'ufsc-moodle-mcp-http: error streaming stored file:',
          sharedClient.sanitizeErrorMessage(err)
        );
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.destroy();
      });
      req.on('close', () => {
        stream.destroy();
      });
      stream.pipe(res);
      return;
    }

    // 2. Authenticate MCP endpoints with MCP_AUTH_TOKEN when configured
    if (authToken) {
      const authHeader = firstHeaderValue(req.headers['authorization']);
      const bearerCandidate = authHeader?.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;
      const queryToken = url.searchParams.get('token');

      const authorized =
        pathHasToken ||
        safeTokenEquals(bearerCandidate, authToken) ||
        safeTokenEquals(queryToken, authToken);

      if (!authorized) {
        res.writeHead(401, {
          'Content-Type': 'text/plain; charset=utf-8',
          'WWW-Authenticate': 'Bearer',
        });
        res.end('Unauthorized\n');
        return;
      }
    }

    // 3. Support /, /mcp, and /sse
    if (pathname !== '/mcp' && pathname !== '/' && pathname !== '' && pathname !== '/sse') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found\n');
      return;
    }

    // 4. Health check on GET without event-stream
    if (req.method === 'GET' && !req.headers.accept?.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'healthy',
          service: 'ufsc-moodle-mcp',
          version: SERVER_VERSION,
          siteUrl: config.siteUrl,
        })
      );
      return;
    }

    // 5. Handle MCP JSON-RPC / Streamable HTTP request inside RequestContext
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }

      const init: RequestInit = {
        method: req.method,
        headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0) {
        init.body = body;
      }

      const forwardUrl = new URL(url.href);
      forwardUrl.pathname = pathname || '/';
      forwardUrl.searchParams.delete('token');

      const publicBaseUrl = inferPublicBaseUrl(req, config.publicBaseUrl);
      const webRequest = new Request(forwardUrl.href, init);
      const webResponse = await requestContextStorage.run({ publicBaseUrl }, () =>
        handler.fetch(webRequest)
      );

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of webResponse.headers.entries()) {
        resHeaders[k] = v;
      }

      if (
        req.method === 'POST' &&
        (resHeaders['content-type'] || '').includes('text/event-stream') &&
        webResponse.body
      ) {
        const text = await webResponse.text();
        const dataLines = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6).trim())
          .filter(Boolean);
        if (dataLines.length === 1) {
          const jsonPayload = Buffer.from(dataLines[0], 'utf-8');
          resHeaders['content-type'] = 'application/json; charset=utf-8';
          resHeaders['content-length'] = String(jsonPayload.length);
          res.writeHead(webResponse.status, resHeaders);
          res.end(jsonPayload);
          return;
        }
        resHeaders['x-accel-buffering'] = 'no';
        res.writeHead(webResponse.status, resHeaders);
        res.end(text);
        return;
      }

      if ((resHeaders['content-type'] || '').includes('text/event-stream')) {
        resHeaders['x-accel-buffering'] = 'no';
      }
      res.writeHead(webResponse.status, resHeaders);

      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      console.error(
        'ufsc-moodle-mcp-http: error handling request:',
        sharedClient.sanitizeErrorMessage(err)
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error\n');
      }
    }
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close(() => resolve());
    });
    await handler.close();
    sharedClient.fileStore.close();
  };

  return {
    httpServer,
    client: sharedClient,
    close,
  };
}
