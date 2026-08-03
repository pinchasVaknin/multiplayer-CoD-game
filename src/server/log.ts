import { installLogSink, setLogLevel, type LogLevel, type LogSink } from '../shared/core/Log';

/**
 * Structured logging for the headless process (M9, S6.4).
 *
 * The brief's reasoning is the design constraint: *"the server has no debug overlay; logs
 * are the only visibility you will have into it for the rest of the project. Build them
 * properly now."* Everything downstream of this milestone — netcode, lag compensation, a
 * twelve-hour soak — gets diagnosed from these lines and nothing else.
 *
 * Two output shapes, because they have different readers:
 *
 * **`text`** is for a human watching a terminal. Level, elapsed seconds since boot, tag,
 * message. Aligned columns so a scan down the left edge finds the warnings.
 *
 * **`json`** is one object per line, which is what S7 asks for at match boundaries and what
 * makes a soak run greppable by a machine. It is the default under `--json` and whenever
 * stdout is not a TTY, because a redirected log is being read by something.
 *
 * Fields are always in the same order, so `sort`, `uniq` and a diff all behave.
 */

export type LogFormat = 'text' | 'json';

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

const bootNs = process.hrtime.bigint();

function elapsedSeconds(): number {
  return Number(process.hrtime.bigint() - bootNs) / 1e9;
}

/**
 * Warnings and errors go to stderr, everything else to stdout.
 *
 * So that `npm run server > run.log` keeps the run's output and still shows failures on the
 * terminal, and so a CI job that only captures stderr captures the thing that went wrong.
 */
function write(level: LogLevel, line: string): void {
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function makeTextSink(): LogSink {
  return {
    log(level, tag, message) {
      const t = elapsedSeconds().toFixed(3).padStart(9);
      write(level, `${LEVEL_LABEL[level]} ${t}s ${tag.padEnd(14)} ${message}`);
    },
  };
}

export function makeJsonSink(): LogSink {
  return {
    log(level, tag, message) {
      write(level, JSON.stringify({ t: +elapsedSeconds().toFixed(3), level, tag, msg: message }));
    },
  };
}

/**
 * Emit a structured record rather than a sentence.
 *
 * S7 wants frame time, tick jitter, AI cost and heap logged as JSON at every match boundary.
 * A metric is not prose and should not have to be parsed back out of prose, so it bypasses
 * the message formatting entirely and writes one flat object per line.
 *
 * Always to stdout, always one line, always with `t`, `tag` and `event` first — a soak run
 * is read with `grep event=... | jq`, and a field that moves position breaks that.
 */
export function metric(tag: string, event: string, fields: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ t: +elapsedSeconds().toFixed(3), tag, event, ...fields }) + '\n',
  );
}

/** Install the process-wide sink. Called once, from the entry point, before anything runs. */
export function installServerLogging(format: LogFormat, level: LogLevel): void {
  installLogSink(format === 'json' ? makeJsonSink() : makeTextSink());
  setLogLevel(level);
}
