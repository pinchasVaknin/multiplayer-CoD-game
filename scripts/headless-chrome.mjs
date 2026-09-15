/**
 * Headless Chrome over the DevTools Protocol, with no new dependency (playtest round 5, P1;
 * lifted out of `layout-probe.mjs` for M15 B5, which needed the same forty lines to render
 * skin thumbnails).
 *
 * S2 permits no new dependencies, so there is no Puppeteer here. Chrome speaks the DevTools
 * Protocol over a WebSocket and `ws` is already the one permitted server dependency, so the
 * client is the `Cdp` class below. `withPage` is the whole ceremony — the project's own dev
 * server on a free port, a Chrome with a scratch profile, one page, and a promise that the
 * page's exceptions are printed rather than dropped — handed to a callback that does the work.
 *
 * Chrome is found from `CHROME_PATH` first, then the usual install locations. Edge is on the
 * list because it is Chromium and speaks the same protocol, and because it is the browser
 * that is already installed on a Windows machine that has never had Chrome put on it
 * deliberately. Any of them will do.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from 'vite';

const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env['LOCALAPPDATA'] === undefined
    ? undefined
    : path.join(process.env['LOCALAPPDATA'], 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chrome or Edge found. Set CHROME_PATH to a Chromium binary and run this again.\n' +
      'Looked in:\n  ' +
      CHROME_CANDIDATES.filter((c) => c !== undefined).join('\n  '),
  );
}

export class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined) {
        const waiting = this.#pending.get(message.id);
        if (waiting === undefined) return;
        this.#pending.delete(message.id);
        if (message.error !== undefined) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
        return;
      }
      const handlers = this.#listeners.get(message.method);
      if (handlers === undefined) return;
      for (const handler of [...handlers]) handler(message.params ?? {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    this.#socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  on(method, handler) {
    const existing = this.#listeners.get(method);
    if (existing === undefined) this.#listeners.set(method, [handler]);
    else existing.push(handler);
  }

  once(method) {
    return new Promise((resolve) => {
      const handler = (params) => {
        const handlers = this.#listeners.get(method) ?? [];
        this.#listeners.set(
          method,
          handlers.filter((h) => h !== handler),
        );
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  close() {
    this.#socket.close();
  }
}

/** Run an expression in the page and hand back its value, or throw what the page threw. */
export async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails;
    const described = details.exception?.description ?? details.text;
    throw new Error(`the page threw:\n${described}`);
  }
  return result.result.value;
}

/** Start the project's own dev server on a free port. The probe pages are served from it. */
export async function startDevServer() {
  const server = await createServer({
    // The committed config pins 5173 with `strictPort`, which is right for a human running
    // `npm run dev` and wrong for a probe that must not fight with one that is already up.
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error('the dev server started without a local URL');
  return { server, origin: url.replace(/\/$/, '') };
}

/**
 * Launch a headless Chrome on a scratch profile and resolve its DevTools endpoint.
 *
 * `--disable-gpu` on purpose, for both users: layout must not depend on the machine's display
 * driver, and a thumbnail rendered through SwiftShader is the same bytes on every machine
 * that regenerates it, which is what a committed asset wants. WebGL still works; it is
 * software, and a 320×400 render of one body is a fraction of a second of it.
 */
export function launchChrome(binary, userDataDir) {
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-gpu',
      // Layout must not depend on the machine's display scaling, or the same tree measures
      // differently on two laptops.
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const endpoint = new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error(`Chrome did not report a DevTools endpoint:\n${buffered}`)),
      20_000,
    );
    child.stderr.on('data', (chunk) => {
      buffered += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${buffered}`)));
  });

  return { child, endpoint };
}

/**
 * The whole ceremony around one page: dev server up, Chrome up, a target attached with Page
 * and Runtime enabled and its exceptions printed, `pagePath` loaded; then `work({ cdp,
 * sessionId, origin, load })` — `load(path)` navigates the same target again and waits for
 * it — and everything torn down afterwards whatever `work` did.
 *
 * `prefix` names the scratch profile directory, so two probes running at once do not share
 * one. The teardown waits for Chrome to be gone before deleting its profile: on Windows a
 * still-open handle in a dying Chrome makes the remove fail with EPERM, and a probe that
 * reports a failure because it could not tidy a temp directory is a probe nobody trusts the
 * exit code of.
 */
export async function withPage(prefix, pagePath, work) {
  const binary = findChrome();
  const userDataDir = mkdtempSync(path.join(tmpdir(), `operator-${prefix}-`));
  const { server, origin } = await startDevServer();
  const { child, endpoint } = launchChrome(binary, userDataDir);

  let cdp;
  try {
    cdp = await Cdp.connect(await endpoint);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    // A page that logs an error is a page whose measurement is suspect, so it is printed
    // rather than dropped.
    cdp.on('Runtime.exceptionThrown', (params) => {
      if (params.sessionId !== undefined && params.sessionId !== sessionId) return;
      console.error(
        `  page exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`,
      );
    });

    const load = async (p) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${origin}${p}` }, sessionId);
      await loaded;
    };
    await load(pagePath);
    return await work({ cdp, sessionId, origin, binary, load });
  } finally {
    cdp?.close();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    await server.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
