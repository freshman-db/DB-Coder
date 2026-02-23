import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../utils/logger.js';

// --- Types ---

export interface SessionOptions {
  /** Permission mode for the Claude Code CLI */
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  /** Max USD budget for this session */
  maxBudget?: number;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
  /** Limit on tools the session can use */
  allowedTools?: string[];
  /** Tools to explicitly block */
  disallowedTools?: string[];
  /** Extra system prompt appended to Claude's defaults */
  appendSystemPrompt?: string;
  /** JSON schema for structured output */
  jsonSchema?: object;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Max number of agentic turns */
  maxTurns?: number;
  /** Callback for streaming text deltas */
  onText?: (text: string) => void;
  /** Callback for each raw stream-json event */
  onEvent?: (event: StreamEvent) => void;
  /** Model to use (default: claude-sonnet-4-6) */
  model?: string;
}

export interface SessionResult {
  /** Assembled full text output */
  text: string;
  /** Parsed structured output if jsonSchema was specified */
  json?: unknown;
  /** Total cost in USD */
  costUsd: number;
  /** Session ID for resuming */
  sessionId: string;
  /** Process exit code */
  exitCode: number;
  /** Number of agentic turns taken */
  numTurns: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the result is an error */
  isError: boolean;
  /** Error messages if isError */
  errors: string[];
  /** Token usage summary */
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Raw stream-json event from Claude Code CLI */
export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

// Env vars to clear to prevent nested Claude Code conflicts
const CLAUDE_ENV_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_PACKAGE_DIR', 'CLAUDE_DEV_HOST', 'CLAUDE_DEV_PORT',
];

function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of CLAUDE_ENV_VARS) {
    delete env[key];
  }
  return env;
}

// --- Session ---

export class ClaudeCodeSession {
  private child: ChildProcess | null = null;

  /**
   * Run a prompt in a new or resumed Claude Code CLI session.
   *
   * Spawns `claude -p --output-format stream-json` and parses the
   * line-delimited JSON event stream. Returns when the process exits.
   */
  async run(prompt: string, opts: SessionOptions): Promise<SessionResult> {
    const start = Date.now();
    const args = this.buildArgs(prompt, opts);

    const env = cleanEnv();
    // Ensure claude-mem uses a strong model
    env.CLAUDE_MEM_MODEL = 'claude-opus-4-6';

    return new Promise<SessionResult>((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;

      let stderr = '';
      let buffer = '';
      let sessionId = '';
      let costUsd = 0;
      let numTurns = 0;
      let isError = false;
      let errors: string[] = [];
      let resultText = '';
      let structuredOutput: unknown = undefined;
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      // Accumulate assistant text from complete assistant messages
      const textParts: string[] = [];

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(trimmed) as StreamEvent;
          } catch {
            log.debug('ClaudeCodeSession: skipping non-JSON line', { line: trimmed.slice(0, 100) });
            continue;
          }

          // Capture session ID from any event
          if (event.session_id && !sessionId) {
            sessionId = event.session_id;
          }

          opts.onEvent?.(event);
          this.processEvent(event, textParts, opts.onText);

          // Handle result event (always the last event)
          if (event.type === 'result') {
            costUsd = asNumber(event.total_cost_usd) ?? 0;
            numTurns = asNumber(event.num_turns) ?? 0;
            isError = Boolean(event.is_error);
            resultText = typeof event.result === 'string' ? event.result : '';
            structuredOutput = event.structured_output ?? undefined;
            if (Array.isArray(event.errors)) {
              errors = event.errors.filter((e): e is string => typeof e === 'string');
            }

            // Extract usage
            if (isRecord(event.usage)) {
              usage.inputTokens = asNumber(event.usage.input_tokens) ?? 0;
              usage.outputTokens = asNumber(event.usage.output_tokens) ?? 0;
              usage.cacheReadInputTokens = asNumber(event.usage.cache_read_input_tokens) ?? 0;
              usage.cacheCreationInputTokens = asNumber(event.usage.cache_creation_input_tokens) ?? 0;
            }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Timeout handling
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeout) {
        timer = setTimeout(() => {
          log.warn('ClaudeCodeSession: timeout, killing process', { timeout: opts.timeout });
          child.kill('SIGTERM');
        }, opts.timeout);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        this.child = null;
        reject(err);
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        this.child = null;

        // Log diagnostics for non-zero exits with no result
        if (code !== 0 && !resultText && textParts.length === 0) {
          log.warn('ClaudeCodeSession: non-zero exit with no output', {
            exitCode: code,
            stderr: stderr.slice(0, 500),
            bufferRemainder: buffer.slice(0, 500),
          });
        }

        // Use result text if available, otherwise fall back to accumulated text
        const text = resultText || textParts.join('');

        resolve({
          text,
          json: structuredOutput,
          costUsd,
          sessionId,
          exitCode: code ?? 0,
          numTurns,
          durationMs: Date.now() - start,
          isError,
          errors: (isError || (code !== 0 && code !== null))
            ? (errors.length > 0 ? errors : [stderr || `exit code ${code}`])
            : [],
          usage,
        });
      });

      // Close stdin immediately (we use -p flag, not interactive mode)
      child.stdin?.end();
    });
  }

  /** Kill the running session process */
  kill(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  // --- Private ---

  private buildArgs(prompt: string, opts: SessionOptions): string[] {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (opts.permissionMode === 'bypassPermissions') {
      args.push('--permission-mode', 'bypassPermissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    if (opts.maxBudget !== undefined) {
      args.push('--max-budget-usd', String(opts.maxBudget));
    }

    if (opts.maxTurns !== undefined) {
      args.push('--max-turns', String(opts.maxTurns));
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools?.length) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }

    if (opts.disallowedTools?.length) {
      args.push('--disallowedTools', opts.disallowedTools.join(','));
    }

    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    if (opts.jsonSchema) {
      args.push('--output-format', 'stream-json');
      args.push('--json', JSON.stringify(opts.jsonSchema));
    }

    return args;
  }

  /**
   * Process a stream event: extract assistant text from complete messages.
   */
  private processEvent(
    event: StreamEvent,
    textParts: string[],
    onText?: (text: string) => void,
  ): void {
    if (event.type === 'assistant' && isRecord(event.message)) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
            onText?.(block.text);
          }
        }
      }
    }
  }
}

// --- Helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
