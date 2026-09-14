import { describe, expect, it } from 'vitest';
import { FRAME_HEIGHT, FRAME_WIDTH, frameScale } from './Frame';

/**
 * The design frame's one number (M15, Phase A1). Pure, so it is tested here; the element half
 * of `Frame.ts` needs a document and is measured by the layout probe instead.
 */
describe('frameScale', () => {
  it('is exactly 1 at the design size', () => {
    expect(frameScale(FRAME_WIDTH, FRAME_HEIGHT)).toBe(1);
  });

  it('is bound by the tighter axis', () => {
    // 16:9 windows scale by either axis alike.
    expect(frameScale(1280, 720)).toBeCloseTo(2 / 3, 12);
    // The round-5 playtest window: the height is the constraint, and the frame is 58% wide.
    expect(frameScale(1366, 626)).toBeCloseTo(626 / 1080, 12);
    // An ultrawide: the height caps it at 1, the extra width is gutter.
    expect(frameScale(2560, 1080)).toBe(1);
    // Taller than wide: the width caps it.
    expect(frameScale(375, 812)).toBeCloseTo(375 / 1920, 12);
  });

  it('has no lower clamp — the rule holds below the floor', () => {
    expect(frameScale(800, 600)).toBeCloseTo(800 / 1920, 12);
    expect(frameScale(0, 0)).toBe(0);
  });
});
