/**
 * The touch controls hit-test manually — a d-pad needs diagonal wedges, which
 * no DOM element gives you — so they hold the on-screen geometry of every
 * button. That cache is the hazard: if anything moves the controls after it was
 * taken, presses land where the buttons used to be and the pad goes dead.
 *
 * On an iPhone that happens for reasons the page does not control: a double tap
 * that scrolls or zooms, the keyboard, the dynamic toolbar. Rather than chase
 * each trigger, this asserts the property that matters — a press is hit-tested
 * against where the buttons are *now*.
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const GB_ROM = fileURLToPath(new URL('../roms/overworld-probe.gb', import.meta.url));

test.describe('touch controls after the page moves', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'independent of viewport',
    );
  });

  test('hit-tests against where the buttons are now, not where they were', async ({
    page,
  }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GB_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // Start is a plain rectangle with no slop around it, so "inside" and
    // "outside" are unambiguous — unlike the d-pad, whose wedges reach well
    // past the arms they are drawn on.
    const start = page.getByRole('button', { name: 'Start' });
    await expect(start).toBeVisible();

    const before = (await start.boundingBox())!;
    // Sideways, and by more than the button is wide: moving the controls up
    // would slide them under the play area's overlay, which would swallow the
    // press and prove nothing about the geometry.
    const shift = Math.ceil(before.width) + 10;

    // Shift the controls the way an unwanted scroll or zoom would, without
    // firing resize or orientationchange — those are already handled, and a
    // real iPhone does not always send them. Far enough that the button's old
    // and new rectangles do not overlap.
    await page.locator('.touch-surface').evaluate((element, by) => {
      (element as HTMLElement).style.transform = `translateX(${by}px)`;
    }, shift);

    const after = (await start.boundingBox())!;
    expect(after.x, 'the control really moved clear of its old place').toBeGreaterThan(
      before.x + before.width,
    );

    // A press where the button is now must register.
    await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
    await page.mouse.down();
    await expect(start).toHaveClass(/is-pressed/);
    await page.mouse.up();
    await expect(start).not.toHaveClass(/is-pressed/);

    // A press where it used to be must not.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await expect(start).not.toHaveClass(/is-pressed/);
    await page.mouse.up();
  });
});
