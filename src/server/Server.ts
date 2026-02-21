import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MainLoop } from '../core/MainLoop.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Config } from '../config/Config.js';
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

export class Server {
  private server: HttpServer;
  private webDir: string;

  constructor(
    private config: Config,
    private loop: MainLoop,
    private taskStore: TaskStore,
    private globalMemory: GlobalMemory,
    private costTracker: CostTracker,
  ) {
    // Web files directory (relative to compiled output)
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    this.webDir = join(thisDir, '..', 'web');

    // Also check source directory for development
    if (!existsSync(this.webDir)) {
      this.webDir = join(thisDir, '..', '..', 'src', 'web');
    }

    const ctx = { loop, taskStore, globalMemory, costTracker, config };

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
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
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let pathname = url.pathname;

    // SPA: all non-file paths serve index.html
    if (!pathname.includes('.')) {
      pathname = '/index.html';
    }

    const filePath = join(this.webDir, pathname);
    if (!existsSync(filePath)) {
      // Fallback to index.html for SPA routing
      const indexPath = join(this.webDir, 'index.html');
      if (existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(readFileSync(indexPath));
      } else {
        res.writeHead(404).end('Not Found');
      }
      return;
    }

    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(readFileSync(filePath));
  }
}
