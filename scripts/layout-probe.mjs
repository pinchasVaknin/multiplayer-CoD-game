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
 * headless Chrome at eight viewports (M15, A1: the 1920x1080 design frame and the 1280x720
 * floor, then round 5's six), and asks the page to measure itself at each. The rule it
 * asserts and why it is that rule are in `src/client/probes/layout.ts`; this half is only
 * transport.
 *
 * ## No new libraries, and no `--dump-dom`
 *
 * S2 permits no new dependencies, so there is no Puppeteer here. Chrome speaks the DevTools
 * Protocol over a WebSocket and `ws` is already the one permitted server dependency, so the
 * client is `headless-chrome.mjs` (lifted out of this file for M15 B5, which renders skin
 * thumbnails through the same Chrome). The alternative — one `--dump-dom` launch per
 * viewport, scraping the answer back out of serialised HTML — needs no socket at all but
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
 * Exits non-zero on any violation, which is what makes it a probe rather than a report.
 */
import { evaluate, withPage } from './headless-chrome.mjs';

const PAGE = '/probes/layout.html';

function formatRect(rect) {
  return `x ${rect.left.toFixed(0)}..${rect.right.toFixed(0)}, y ${rect.top.toFixed(0)}..${rect.bottom.toFixed(0)}`;
}

const failures = await withPage('layout', PAGE, async ({ cdp, sessionId, binary }) => {
  const ready = await evaluate(cdp, sessionId, 'window.__layoutProbe !== undefined');
  if (ready !== true) throw new Error(`${PAGE} loaded but never installed window.__layoutProbe`);

  const viewports = await evaluate(cdp, sessionId, 'window.__layoutProbe.viewports');
  const surfaces = await evaluate(cdp, sessionId, 'window.__layoutProbe.surfaces');

  console.log(`PROTOCOL SEVEN layout probe — ${binary}`);
  console.log(`${surfaces.length} surfaces x ${viewports.length} viewports\n`);

  let count = 0;
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
    // The frame's scale at this window (M15, A1); the content sizes below are in frame pixels.
    console.log(`${label}  (frame x${run.scale.toFixed(3)})`);
    for (const screen of run.screens) {
      const bad = screen.violations.length;
      count += bad;
      const size = `frame ${screen.contentWidth}x${screen.contentHeight}`;
      const verdict = bad === 0 ? 'ok' : `${bad} violation${bad === 1 ? '' : 's'}`;
      console.log(`  ${screen.screen.padEnd(24)} ${size.padEnd(24)} ${verdict}`);
      for (const violation of screen.violations) {
        detail.push(`${label} · ${screen.screen} · ${violation.rule}/${violation.axis}
    ${violation.element}
    ${violation.detail}
    at: ${formatRect(violation.rect)}`);
      }
    }
    console.log('');
  }

  if (detail.length > 0) {
    console.log('--- violations ---\n');
    for (const entry of detail) console.log(`${entry}\n`);
  }
  console.log(count === 0 ? 'PASS — every surface fits its frame' : `FAIL — ${count} violations`);
  return count;
});

process.exitCode = failures === 0 ? 0 : 1;
