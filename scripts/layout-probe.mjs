#!/usr/bin/env node
/**
 * The layout probe's driver (playtest round 5, P1).
 *
 * B1, B2 and B3 were three reports of one thing: a screen with more content than the window
 * has room for. All three were found with a `getBoundingClientRect()` against a stated
 * viewport, which is P0 rule 7's point — a layout bug on this project is a **number**, and a
 * number is something a script can take. This is the script.
 *
 * It serves `probes/layout.html` from the dev server the project already has, drives a
 * headless Chrome at six viewports, and asks the page to measure itself at each. The rules it
 * asserts and why they are those rules are in `src/client/probes/layout.ts`; this half is
 * only transport.
 *
 * ## No new libraries, and no `--dump-dom`
 *
 * S2 permits no new dependencies, so there is no Puppeteer here. Chrome speaks the DevTools
 * Protocol over a WebSocket and `ws` is already the one permitted server dependency, so the
 * client is forty lines at the bottom of this file. The alternative — one `--dump-dom` launch
 * per viewport, scraping the answer back out of serialised HTML — needs no socket at all but
 * cannot report a page that threw: an exception in the probe module would come back as a page
 * with no results on it, indistinguishable from a page with nothing to say. `Runtime.evaluate`
 * hands back the stack.
 *
 * ## Why it is not in `npm run check`
 *
 * `npm run build` runs `npm run check`, and the build runs on a managed host with no browser
 * on it. A gate that needs Chrome would make the deploy depend on one. So this sits beside
 * `readability` and `progression` as an instrument you run, and the browser it needs is named
 * in the failure message rather than assumed.
 *
 * Chrome is found from `CHROME_PATH` first, then the usual install locations. Exits non-zero
 * on any violation, which is what makes it a probe rather than a report.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from 'vite';

const PAGE = '/probes/layout.html';

/**
 * Where Chrome lives, in the order it is looked for.
 *
 * Edge is on the list because it is Chromium and speaks the same protocol, and because it is
 * the browser that is already installed on a Windows machine that has never had Chrome put on
 * it deliberately. Any of them will do; the probe measures Blink either way.
 */
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

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chrome or Edge found. Set CHROME_PATH to a Chromium binary and run this again.\n' +
      'Looked in:\n  ' +
      CHROME_CANDIDATES.filter((c) => c !== undefined).join('\n  '),
  );
}

// -- the DevTools Protocol, in as little as it takes -------------------------

class Cdp {
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
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails;
    const described = details.exception?.description ?? details.text;
    throw new Error(`the probe page threw:\n${described}`);
  }
  return result.result.value;
}

// -- the run ------------------------------------------------------------------

/** Start the project's own dev server on a free port. The probe page is served from it. */
async function startDevServer() {
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

function launchChrome(binary, userDataDir) {
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

function formatRect(rect) {
  return `x ${rect.left.toFixed(0)}..${rect.right.toFixed(0)}, y ${rect.top.toFixed(0)}..${rect.bottom.toFixed(0)}`;
}

async function main() {
  const binary = findChrome();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'operator-layout-'));
  const { server, origin } = await startDevServer();
  const { child, endpoint } = launchChrome(binary, userDataDir);

  let failures = 0;
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

    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${origin}${PAGE}` }, sessionId);
    await loaded;

    const ready = await evaluate(cdp, sessionId, 'window.__layoutProbe !== undefined');
    if (ready !== true) throw new Error(`${PAGE} loaded but never installed window.__layoutProbe`);

    const viewports = await evaluate(cdp, sessionId, 'window.__layoutProbe.viewports');
    const surfaces = await evaluate(cdp, sessionId, 'window.__layoutProbe.surfaces');

    console.log(`OPERATOR layout probe — ${binary}`);
    console.log(`${surfaces.length} surfaces x ${viewports.length} viewports\n`);

    const detail = [];
    for (const viewport of viewports) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      );
      const run = await evaluate(cdp, sessionId, 'window.__layoutProbe.run()');
      const label = `${run.width}x${run.height}`;
      console.log(`${label}`);
      for (const screen of run.screens) {
        const bad = screen.violations.length;
        failures += bad;
        const size = `content ${screen.contentWidth}x${screen.contentHeight}`;
        const verdict = bad === 0 ? 'ok' : `${bad} violation${bad === 1 ? '' : 's'}`;
        console.log(`  ${screen.screen.padEnd(24)} ${size.padEnd(24)} ${verdict}`);
        for (const violation of screen.violations) {
          detail.push(`${label} · ${screen.screen} · ${violation.rule}/${violation.axis}
    ${violation.element}
    ${violation.detail}
    before: ${formatRect(violation.before)}
    after:  ${formatRect(violation.after)}`);
        }
      }
      console.log('');
    }

    if (detail.length > 0) {
      console.log('--- violations ---\n');
      for (const entry of detail) console.log(`${entry}\n`);
    }
    console.log(failures === 0 ? 'PASS — every surface fits or scrolls' : `FAIL — ${failures} violations`);
  } finally {
    cdp?.close();
    // Wait for it to be gone before deleting its profile: on Windows a still-open handle in a
    // dying Chrome makes the remove fail with EPERM, and a probe that reports a failure
    // because it could not tidy a temp directory is a probe nobody trusts the exit code of.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    await server.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
