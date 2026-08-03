import { installClock } from '../shared/core/Clock';
import { browserClock } from './engine/BrowserClock';
import { Game } from './Game';

/**
 * Entry point. Finds the three hosts the game needs and starts the state machine.
 */

// Before anything else: the shared simulation measures itself through an installed clock
// and throws if it has none (M9, S3). The server's entry point does the same with its own.
installClock(browserClock);

const canvas = document.getElementById('viewport');
const uiRoot = document.getElementById('ui-root');
const debugRoot = document.getElementById('debug-root');

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#viewport canvas is missing from index.html');
}
if (uiRoot === null || debugRoot === null) {
  throw new Error('#ui-root or #debug-root is missing from index.html');
}

const game = new Game(canvas, uiRoot, debugRoot);
game.start();
