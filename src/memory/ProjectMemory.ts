import { log } from '../utils/logger.js';
import { getErrorMessage, isRecord } from '../utils/parse.js';
import { calculateRetryDelay } from '../utils/retry.js';

interface ClaudeMemResult {
  id: number;
  title?: string;
  text: string;
}

/** MCP-style response from claude-mem worker */
interface McpResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type SearchType = 'all' | 'observations' | 'sessions' | 'prompts';
type SearchFormat = 'index' | 'full';

interface SearchOptions {
  project?: string;
  type?: SearchType;
  format?: SearchFormat;
  obsType?: string;
  concepts?: string;
  files?: string;
  dateStart?: string;
  dateEnd?: string;
}

type ProjectMemoryResult<T extends unknown[]> =
  | (T & { ok: true; data: T })
  | (T & { ok: false; error: string });

const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

export class ProjectMemory {
  private baseUrl: string;

  constructor(claudeMemUrl: string) {
    this.baseUrl = claudeMemUrl.replace(/\/$/, '');
  }

  /** Extract text from claude-mem MCP-style response {content: [{type:"text", text:"..."}]} */
  private extractText(data: McpResponse): string {
    if (data.content && Array.isArray(data.content) && data.content.length > 0) {
      return data.content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n');
    }
    return '';
  }

  private extractSearchItemText(item: Record<string, unknown>): string {
    const directText = ['text', 'preview', 'summary', 'description']
      .map((key) => item[key])
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof directText === 'string') {
      return directText;
    }
    if (Array.isArray(item.matches)) {
      const matchText = item.matches
        .filter((m): m is Record<string, unknown> => isRecord(m))
        .map((m) => m.text)
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .join('\n');
      if (matchText.length > 0) {
        return matchText;
      }
    }
    return '';
  }

  private extractSearchResults(payload: unknown): ClaudeMemResult[] {
    // Backward compatibility: legacy MCP-style payload.
    if (isRecord(payload) && Array.isArray(payload.content)) {
      const text = this.extractText(payload as McpResponse);
      return text ? [{ id: 0, text }] : [];
    }

    const records: Record<string, unknown>[] = [];
    const collect = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        if (isRecord(item)) records.push(item);
      }
    };

    if (isRecord(payload)) {
      collect(payload.results);
      collect(payload.observations);
      collect(payload.sessions);
      collect(payload.prompts);
      if (isRecord(payload.result)) {
        collect(payload.result.results);
        collect(payload.result.observations);
        collect(payload.result.sessions);
        collect(payload.result.prompts);
      }
    }

    const results: ClaudeMemResult[] = [];
    records.forEach((item, index) => {
      const text = this.extractSearchItemText(item).trim();
      if (!text) return;
      const id = typeof item.id === 'number' ? item.id : index;
      const title = typeof item.title === 'string' ? item.title : undefined;
      results.push(title ? { id, title, text } : { id, text });
    });
    return results;
  }

  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
    const retryLimit = Math.max(0, Math.floor(maxRetries));
    const { signal, ...requestOptions } = options;

    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestInit: RequestInit = signal
        ? { ...requestOptions, signal: AbortSignal.any([signal, timeoutSignal]) }
        : { ...requestOptions, signal: timeoutSignal };

      try {
        const response = await fetch(url, requestInit);
        if (response.status >= 500 && attempt < retryLimit) {
          await this.waitForRetry(url, attempt, retryLimit, `HTTP ${response.status}`);
          continue;
        }
        return response;
      } catch (error) {
        if (!this.isRetryableFetchError(error) || attempt >= retryLimit) {
          throw error;
        }
        const errorName = typeof error === 'object' && error !== null && 'name' in error
          ? String(error.name)
          : 'UnknownError';
        await this.waitForRetry(url, attempt, retryLimit, errorName);
      }
    }
  }

  private isRetryableFetchError(error: unknown): boolean {
    if (error instanceof TypeError) {
      return true;
    }
    if (typeof error !== 'object' || error === null || !('name' in error)) {
      return false;
    }
    const name = String(error.name);
    return name === 'AbortError' || name === 'TimeoutError';
  }

  private async waitForRetry(url: string, attempt: number, maxRetries: number, reason: string): Promise<void> {
    const delayMs = calculateRetryDelay({
      attempt,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
    });
    const retryAttempt = attempt + 1;
    log.debug(`ProjectMemory retry ${retryAttempt}/${maxRetries} for ${url} in ${delayMs}ms (${reason})`);
    await this.sleep(delayMs);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async search(
    query: string,
    limit = 10,
    options: SearchOptions = {},
  ): Promise<ProjectMemoryResult<ClaudeMemResult[]>> {
    try {
      const params = new URLSearchParams({ query, limit: String(limit) });
      if (options.project) params.set('project', options.project);
      if (options.type) params.set('type', options.type);
      if (options.format) params.set('format', options.format);
      if (options.obsType) params.set('obs_type', options.obsType);
      if (options.concepts) params.set('concepts', options.concepts);
      if (options.files) params.set('files', options.files);
      if (options.dateStart) params.set('date_start', options.dateStart);
      if (options.dateEnd) params.set('date_end', options.dateEnd);
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/search?${params}`, {});
      if (!res.ok) {
        const error = `ProjectMemory search failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        log.warn(error);
        return Object.assign([], { ok: false as const, error });
      }
      const data = await res.json() as unknown;
      const results = this.extractSearchResults(data);
      return Object.assign(results, { ok: true as const, data: results });
    } catch (err) {
      const error = `ProjectMemory search failed: ${getErrorMessage(err)}`;
      log.warn(error);
      return Object.assign([], { ok: false as const, error });
    }
  }

  async timeline(
    anchor: number,
    depthBefore = 3,
    depthAfter = 3,
    project?: string,
  ): Promise<ProjectMemoryResult<ClaudeMemResult[]>> {
    try {
      const params = new URLSearchParams({
        anchor: String(anchor),
        depth_before: String(depthBefore),
        depth_after: String(depthAfter),
      });
      if (project) params.set('project', project);
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/timeline?${params}`, {});
      if (!res.ok) {
        const error = `ProjectMemory timeline failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        log.warn(error);
        return Object.assign([], { ok: false as const, error });
      }
      const data = await res.json() as McpResponse;
      const text = this.extractText(data);
      const results: ClaudeMemResult[] = text ? [{ id: anchor, text }] : [];
      return Object.assign(results, { ok: true as const, data: results });
    } catch (err) {
      const error = `ProjectMemory timeline failed: ${getErrorMessage(err)}`;
      log.warn(error);
      return Object.assign([], { ok: false as const, error });
    }
  }

  async save(
    text: string,
    title?: string,
    project?: string,
    cwd?: string,
    sessionId?: string,
  ): Promise<boolean> {
    const sessionSaved = await this.saveViaSessionObservation(
      text,
      title,
      project,
      cwd,
      sessionId,
    );
    if (sessionSaved) {
      return true;
    }
    return this.saveLegacy(text, title, project);
  }

  private buildSessionId(project?: string): string {
    const projectSlug = (project ?? 'default')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'default';
    return `db-coder-${projectSlug}-${Date.now()}`;
  }

  private async saveViaSessionObservation(
    text: string,
    title?: string,
    project?: string,
    cwd?: string,
    sessionId?: string,
  ): Promise<boolean> {
    try {
      const payload = {
        claudeSessionId: sessionId ?? this.buildSessionId(project),
        tool_name: 'db-coder_reflection',
        tool_input: {
          title: title ?? '',
          project: project ?? '',
          source: 'db-coder',
        },
        tool_response: text,
        cwd: cwd ?? process.cwd(),
      };
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        log.debug(`ProjectMemory sessions save unavailable (HTTP ${res.status}), falling back to legacy endpoint`);
      }
      return res.ok;
    } catch (err) {
      log.debug(`ProjectMemory sessions save failed: ${getErrorMessage(err)}`);
      return false;
    }
  }

  private async saveLegacy(text: string, title?: string, project?: string): Promise<boolean> {
    try {
      const body: Record<string, string> = { text };
      if (title) body.title = title;
      if (project) body.project = project;
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/memory/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      log.warn('ProjectMemory: failed to save, claude-mem may be unavailable');
      return false;
    }
  }

  async injectContext(project: string, colors = false): Promise<string | null> {
    try {
      const params = new URLSearchParams({ project });
      if (colors) params.set('colors', 'true');
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/api/context/inject?${params}`,
        {},
      );
      if (!res.ok) {
        return null;
      }
      const text = (await res.text()).trim();
      return text.length > 0 ? text : null;
    } catch (err) {
      log.debug(`ProjectMemory injectContext failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/search?query=ping&limit=1`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
