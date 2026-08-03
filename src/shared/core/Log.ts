/**
 * Logging, abstracted away from the runtime that prints it (M9, S3 and S6.4).
 *
 * ## Why this exists
 *
 * It was not planned. `tsconfig.shared.json` compiles `shared/` with `"lib": ["ES2022"]` and
 * nothing else, and the first run of that config found eight `console.*` calls in simulation
 * code that had never been noticed — because `console` belongs to neither the DOM library
 * nor the Node one. It is a *host* global, and the whole point of the M9 split is that
 * shared code does not know which host it is in.
 *
 * That turned out to be the right question rather than a compiler technicality. S6.4 asks
 * for structured logging with levels on the server, on the grounds that *"the server has no
 * debug overlay; logs are the only visibility you will have into it for the rest of the
 * project."* A bare `console.warn` in `PlayerController` cannot carry a level, a timestamp
 * or a tick number, and cannot be turned off in a ten-minute soak. This is the seam that
 * lets the server give those eight call sites all four.
 *
 * ## The default
 *
 * `consoleSink` is used until a runtime installs something else. That is deliberate and it
 * is not a stub: the browser's correct behaviour genuinely is to write to the console, which
 * is what M1-M8 did and what the "console clean" acceptance criterion is measured against.
 * The server replaces it with a structured sink at boot.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogSink {
  /**
   * `tag` is the subsystem, without brackets — `'Save'`, `'BotDirector'`. The sink decides
   * how to render it, so a structured sink can put it in a field rather than in the message.
   */
  log(level: LogLevel, tag: string, message: string): void;
}

/**
 * `globalThis.console` without naming a host library.
 *
 * The cast is the one place in `shared/` that asserts anything about its runtime, and it is
 * guarded: a host with no console gets a sink that drops the line rather than throwing.
 * Every JavaScript runtime this project will ever run in has one, but the simulation should
 * not fall over in the one that does not.
 */
interface ConsoleLike {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  log?: (message: string) => void;
}

const hostConsole = (globalThis as { console?: ConsoleLike }).console;

export const consoleSink: LogSink = {
  log(level: LogLevel, tag: string, message: string): void {
    if (hostConsole === undefined) return;
    const line = `[${tag}] ${message}`;
    const fn = hostConsole[level] ?? hostConsole.log;
    fn?.call(hostConsole, line);
  },
};

let sink: LogSink = consoleSink;
let minLevel: LogLevel = 'debug';

/** Replace the sink. The server installs a structured one at boot. */
export function installLogSink(next: LogSink): void {
  sink = next;
}

/** Drop anything below `level`. A ten-minute soak does not want every debug line. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minLevel);
}

/**
 * A logger bound to one subsystem.
 *
 * Created at module scope and reused, so the tag is written once rather than at every call
 * site — which is what made the pre-M9 `[BotDirector]` prefixes drift in the first place.
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function logger(tag: string): Logger {
  return {
    debug(message: string): void {
      if (enabled('debug')) sink.log('debug', tag, message);
    },
    info(message: string): void {
      if (enabled('info')) sink.log('info', tag, message);
    },
    warn(message: string): void {
      if (enabled('warn')) sink.log('warn', tag, message);
    },
    error(message: string): void {
      if (enabled('error')) sink.log('error', tag, message);
    },
  };
}
