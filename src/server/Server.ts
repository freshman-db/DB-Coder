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
import type { PluginMonitor } from '../plugins/PluginMonitor.js';
import type { PatrolManager } from '../core/ModeManager.js';
import type { PlanWorkflow } from '../core/PlanWorkflow.js';
import { handleRequest } from './routes.js';
import { createRateLimiter } from './rateLimit.js';
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
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 100;

/**
 * Content-Security-Policy directives.
 *
 * - default-src 'self'         — fallback for everything
 * - script-src                 — self + CDN for marked.js & DOMPurify
 * - style-src 'unsafe-inline'  — inline style= attributes in app.js
 * - img-src data:              — data: URI SVG favicon
 * - connect-src                — fetch / SSE connections
 */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
] as const;

export class Server {
  private server: HttpServer;
  private webDir: string;
  private rateLimiter: (ip: string) => boolean;

  constructor(
    private config: Config,
    private loop: MainLoop,
    private taskStore: TaskStore,
    private globalMemory: GlobalMemory,
    private costTracker: CostTracker,
    private evolutionEngine?: EvolutionEngine,
    private pluginMonitor?: PluginMonitor,
    private patrolManager?: PatrolManager,
    private planWorkflow?: PlanWorkflow,
  ) {
    // Web files directory (relative to compiled output)
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    this.webDir = join(thisDir, '..', 'web');

    // Also check source directory for development
    if (!existsSync(this.webDir)) {
      this.webDir = join(thisDir, '..', '..', 'src', 'web');
    }

    this.rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS);

    const ctx = { loop, taskStore, globalMemory, costTracker, config, evolutionEngine: this.evolutionEngine, pluginMonitor: this.pluginMonitor, patrolManager: this.patrolManager, planWorkflow: this.planWorkflow };

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      this.setSecurityHeaders(res);
      try {
        if (this.shouldApplyRateLimit(req) && !this.rateLimiter(this.getClientIp(req))) {
          req.resume();
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end(JSON.stringify({ error: 'Too Many Requests' }));
          return;
        }

        if (!this.isAuthorizedApiRequest(req)) {
          req.resume();
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

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

  /** Security headers applied to every response. */
  private setSecurityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', CSP_DIRECTIVES.join('; '));
  }

  private isApiRequest(req: IncomingMessage): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return false;
    }
    return url.pathname.startsWith('/api/');
  }

  private isAuthorizedApiRequest(req: IncomingMessage): boolean {
    if (!this.isApiRequest(req)) return true;

    const method = req.method?.toUpperCase() ?? 'GET';
    if (method === 'OPTIONS') return true;

    const rawAuthorization = req.headers.authorization;
    const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
    if (!authorization) return false;

    const matches = authorization.match(/^Bearer\s+(.+)$/i);
    if (!matches) return false;

    return matches[1] === this.config.values.apiToken;
  }

  private shouldApplyRateLimit(req: IncomingMessage): boolean {
    if (!this.isApiRequest(req)) return false;

    const method = req.method?.toUpperCase() ?? 'GET';
    if (method === 'OPTIONS') return false;

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return false;
    }

    return !(method === 'GET' && url.pathname === '/api/health');
  }

  private getClientIp(req: IncomingMessage): string {
    const rawForwardedFor = req.headers['x-forwarded-for'];
    const forwardedFor = Array.isArray(rawForwardedFor) ? rawForwardedFor[0] : rawForwardedFor;
    if (typeof forwardedFor === 'string') {
      const firstForwardedIp = forwardedFor.split(',')[0]?.trim();
      if (firstForwardedIp) {
        return firstForwardedIp;
      }
    }

    const socketIp = req.socket?.remoteAddress?.trim();
    return socketIp && socketIp.length > 0 ? socketIp : 'unknown';
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
      // Stop accepting new connections
      this.server.close(() => resolve());
      // Force-close idle connections after a short timeout so SSE streams don't block shutdown
      setTimeout(() => {
        this.server.closeAllConnections();
        resolve();
      }, 2000);
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
