import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MainLoop } from '../core/MainLoop.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Config } from '../config/Config.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import { handleRequest } from './routes.js';
import { log } from '../utils/logger.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const BODY_LIMIT_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export class Server {
  private server: HttpServer;
  private webDir: string;

  constructor(
    private config: Config,
    private loop: MainLoop,
    private taskStore: TaskStore,
    private globalMemory: GlobalMemory,
    private costTracker: CostTracker,
    private evolutionEngine?: EvolutionEngine,
  ) {
    // Web files directory (relative to compiled output)
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    this.webDir = join(thisDir, '..', 'web');

    // Also check source directory for development
    if (!existsSync(this.webDir)) {
      this.webDir = join(thisDir, '..', '..', 'src', 'web');
    }

    const ctx = { loop, taskStore, globalMemory, costTracker, config, evolutionEngine: this.evolutionEngine };

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (this.isRequestBodyTooLarge(req)) {
          req.resume();
          res.writeHead(413).end('Payload Too Large');
          return;
        }

        // Try API routes first
        const handled = await handleRequest(req, res, ctx);
        if (handled) return;

        // Serve static files
        this.serveStatic(req, res);
      } catch (err) {
        log.error('Server error', err);
        res.writeHead(500).end('Internal Server Error');
      }
    });
  }

  private isRequestBodyTooLarge(req: IncomingMessage): boolean {
    const method = req.method?.toUpperCase() ?? 'GET';
    if (!BODY_LIMIT_METHODS.has(method)) return false;

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/api/')) return false;

    const rawContentLength = req.headers['content-length'];
    const contentLength = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength;
    if (!contentLength) return false;

    const byteLength = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(byteLength)) return false;
    return byteLength > MAX_REQUEST_BODY_BYTES;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const { port, host } = this.config.values.server;
      this.server.listen(port, host, () => {
        log.info(`Server listening on http://${host}:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    // SPA: all non-file paths serve index.html
    if (!pathname.includes('.')) {
      pathname = '/index.html';
    }

    const filePath = join(this.webDir, pathname.replace(/^\/+/, ''));
    const resolvedRoot = resolve(this.webDir);

    // Path traversal protection: ensure resolved path stays within webDir
    const resolvedFile = resolve(filePath);
    if (!this.isWithinRoot(resolvedRoot, resolvedFile)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (!existsSync(resolvedFile)) {
      // Fallback to index.html for SPA routing
      const indexPath = resolve(this.webDir, 'index.html');
      if (!this.isWithinRoot(resolvedRoot, indexPath)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(readFileSync(indexPath));
      } else {
        res.writeHead(404).end('Not Found');
      }
      return;
    }

    const ext = extname(resolvedFile);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(readFileSync(resolvedFile));
  }

  private isWithinRoot(root: string, path: string): boolean {
    const rel = relative(root, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }
}
