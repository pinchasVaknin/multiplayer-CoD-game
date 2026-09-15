import { CharacterAssetService } from '../characters/CharacterAssetService';
import { BOT_CHARACTER_IDS, type CharacterId } from '../characters/CharacterCatalog';
import { CharacterStage } from '../ui/CharacterStage';

/**
 * The skin thumbnail page (M15, B5): one skin on the Create-a-Class stage, held at one pose,
 * read back as a PNG by `scripts/skin-thumbs.mjs`.
 *
 * The strip under the stage shows every skin at once, and seven live models would be seven
 * renderers and the whole 17 MB library fetched to open a menu. So the thumbnails are made
 * here, once, by the same `CharacterStage` the editor draws the operator with — same lights,
 * same disc, same lens — and committed as `public/models/bots/skins/thumbs/<File>.png`.
 * `check:skins` refuses a skin without one.
 *
 * `?skin=<id>` picks the skin. `window.__skinThumb.render()` resolves to the data URL once
 * the body has arrived and been drawn; it ticks the stage by hand because nothing in a page
 * a script is driving needs a frame loop, and it holds the turntable at a three-quarter
 * view so the seven thumbnails are seven of one picture.
 */

const wanted = new URLSearchParams(window.location.search).get('skin') ?? '';
if (!(BOT_CHARACTER_IDS as readonly string[]).includes(wanted)) {
  throw new Error(`skin thumbnail: no skin "${wanted}". Try one of: ${BOT_CHARACTER_IDS.join(', ')}`);
}
const skin = wanted as CharacterId;

/** A three-quarter view from the front-left: the pose the reference's portraits use. */
const POSE = Math.PI + Math.PI / 7;
/** Frames to draw after the body arrives, so the idle clip has settled off its first frame. */
const SETTLE_FRAMES = 12;
const DT = 1 / 60;

const host = document.getElementById('ui-root');
if (host === null) throw new Error('skin thumbnail: the page has no #ui-root');

const stage = new CharacterStage({
  characterAssets: new CharacterAssetService(),
  // 1: the thumbnail is 320 px wide and the gunmetal's anisotropy is a match-distance concern.
  anisotropy: () => 1,
});
host.appendChild(stage.canvas);
stage.hold(POSE, 3.3);
stage.show(skin);

async function render(): Promise<string> {
  const deadline = performance.now() + 30_000;
  while (!stage.ready) {
    if (performance.now() > deadline) throw new Error(`skin thumbnail: "${skin}" did not load within 30 s`);
    stage.tick(DT);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (let i = 0; i < SETTLE_FRAMES; i++) stage.tick(DT);
  // Read in the same task as the last draw: the buffer is not preserved past it.
  return stage.snapshot();
}

declare global {
  interface Window {
    __skinThumb?: { skin: CharacterId; render: () => Promise<string> };
  }
}

window.__skinThumb = { skin, render };
