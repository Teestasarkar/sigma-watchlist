/**
 * Structured logging with a tiny surface. Deliberately not a dependency:
 * one file, JSON in production, human-readable in development.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold: number =
  ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

const pretty = process.env.NODE_ENV !== 'production' && process.env.LOG_JSON !== '1';

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;

  if (pretty) {
    const time = new Date().toISOString().slice(11, 23);
    const extra =
      fields && Object.keys(fields).length
        ? ' ' +
          Object.entries(fields)
            .map(([k, v]) => `${k}=${format(v)}`)
            .join(' ')
        : '';
    // eslint-disable-next-line no-console
    console.log(`${COLOR[level]}${time} ${level.padEnd(5)}\x1b[0m \x1b[1m${scope}\x1b[0m ${msg}${extra}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: Date.now(), level, scope, msg, ...fields }));
}

function format(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (v instanceof Error) return JSON.stringify(v.message);
  return JSON.stringify(v);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('sigma');
