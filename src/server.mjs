/**
 * 本地 HTTP 服务：静态前端 + REST API + SSE 进度流。
 * 只用 node:http，零依赖。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, normalize } from 'node:path';
import {
  createRun,
  executeRun,
  getRun,
  subscribe,
  cancelRun,
  snapshot,
  buildReport,
  probeModels,
} from './core/runner.mjs';
import { testCatalog } from './core/tests.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const filePath = join(WEB_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end('Not Found');
    return;
  }
  const data = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

/**
 * @param {{port?:number, host?:string, open?:boolean}} opts
 */
export function createServer(opts = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const { pathname } = url;

    // 只允许本机访问，避免任意网页探测本地端口
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return json(res, 403, { error: 'Origin 不被允许' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin || 'null');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      if (pathname === '/api/health') {
        return json(res, 200, { ok: true, version: '1.0.0', node: process.version });
      }

      if (pathname === '/api/tests' && req.method === 'GET') {
        return json(res, 200, { tests: testCatalog() });
      }

      if (pathname === '/api/models' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const models = await probeModels({
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
            headers: body.headers,
            q: body.q,
            timeoutMs: 20000,
          });
          return json(res, 200, { models, total: models.length });
        } catch (e) {
          return json(res, 200, { models: [], total: 0, error: e.message, status: e.status });
        }
      }

      if (pathname === '/api/run' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let run;
        try {
          run = createRun({
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
            model: body.model,
            tests: body.tests,
            concurrency: body.concurrency,
            timeoutMs: body.timeoutMs,
            headers: body.headers,
          });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        // 异步执行，立即返回 runId
        executeRun(run).catch(() => {});
        return json(res, 200, { runId: run.id, run: snapshot(run) });
      }

      const runMatch = pathname.match(/^\/api\/run\/([^/]+)$/);
      if (runMatch && req.method === 'GET') {
        const run = getRun(runMatch[1]);
        if (!run) return json(res, 404, { error: 'run 不存在或已过期' });
        return json(res, 200, snapshot(run));
      }

      const reportMatch = pathname.match(/^\/api\/run\/([^/]+)\/report$/);
      if (reportMatch && req.method === 'GET') {
        const run = getRun(reportMatch[1]);
        if (!run) return json(res, 404, { error: 'run 不存在或已过期' });
        if (!run.finishedAt) return json(res, 409, { error: '运行尚未结束' });
        return json(res, 200, buildReport(run));
      }

      const cancelMatch = pathname.match(/^\/api\/run\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const run = getRun(cancelMatch[1]);
        if (!run) return json(res, 404, { error: 'run 不存在或已过期' });
        cancelRun(run);
        return json(res, 200, { ok: true, cancelled: run.cancelled });
      }

      const streamMatch = pathname.match(/^\/api\/run\/([^/]+)\/events$/);
      if (streamMatch && req.method === 'GET') {
        const run = getRun(streamMatch[1]);
        if (!run) return json(res, 404, { error: 'run 不存在或已过期' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const send = (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        send({ type: 'snapshot', run: snapshot(run) });
        const unsub = subscribe(run, (event) => {
          send(event);
          if (event.type === 'done') {
            unsub();
            res.end();
          }
        });
        const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(keepAlive);
          unsub();
        });
        if (run.finishedAt) {
          send({ type: 'done', report: buildReport(run) });
          unsub();
          clearInterval(keepAlive);
          res.end();
        }
        return;
      }

      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return json(res, 404, { error: 'Not Found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });

  return server;
}

export function startServer({ port = 0, host = '127.0.0.1', open = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      const url = `http://${host}:${actual}`;
      resolvePromise({ server, url, port: actual });
    });
  });
}
