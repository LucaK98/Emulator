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

  /*
   * iOS zooms the page on a double tap, and a zoomed page moves the controls
   * out from under the player's thumbs mid-game. touch-action is supposed to
   * settle it and does not, so the second tap of a quick pair has its default
   * action refused. What that looks like from here is defaultPrevented on the
   * second touchend and not on the first.
   */
  test('refuses the second tap of a double tap, and only that one', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GB_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await expect(page.locator('.touch-surface')).toBeVisible();

    // Record what the page's own guard did with each touchend.
    await page.evaluate(() => {
      (window as unknown as { prevented: boolean[] }).prevented = [];
      document.addEventListener(
        'touchend',
        (event) => {
          (window as unknown as { prevented: boolean[] }).prevented.push(
            event.defaultPrevented,
          );
        },
        // Last in the chain, so the guard has already had its say.
        false,
      );
    });

    const box = (await page.locator('.touch-surface').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(100);

    const quick = await page.evaluate(
      () => (window as unknown as { prevented: boolean[] }).prevented,
    );
    expect(quick, 'both taps should have been seen').toHaveLength(2);
    expect(quick[0], 'a single tap must still work normally').toBe(false);
    expect(quick[1], 'the second of a quick pair is refused').toBe(true);

    // A tap well away from the last one is a first tap again, not a double.
    await page.evaluate(() => {
      (window as unknown as { prevented: boolean[] }).prevented = [];
    });
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x + 120, y);
    await page.waitForTimeout(100);

    const apart = await page.evaluate(
      () => (window as unknown as { prevented: boolean[] }).prevented,
    );
    expect(apart).toEqual([false, false]);
  });

  /*
   * A held direction does not survive a turn of the device.
   *
   * Rotating moves the controls somewhere else entirely, and a finger that was
   * already down keeps its last known coordinate — which now falls on a
   * different part of the pad. Held up, the character walked down, and it
   * looked as though the buttons had stopped working. There is no way to know
   * where the finger is until it moves or lifts, so the press is dropped.
   */
  test('drops a held direction when the device is turned', async ({ page }) => {
    await startPlaying(page);

    const pad = await page.locator('.dpad').boundingBox();
    expect(pad).not.toBeNull();
    await page.mouse.move(pad!.x + pad!.width / 2, pad!.y + pad!.height * 0.15);
    await page.mouse.down();
    await expect(page.locator('.dpad-up')).toHaveClass(/is-pressed/);

    await page.setViewportSize({ width: 852, height: 393 });

    // Nothing may still be held, and least of all the opposite direction.
    await expect(page.locator('.dpad-up')).not.toHaveClass(/is-pressed/);
    await expect(page.locator('.dpad-down')).not.toHaveClass(/is-pressed/);
    await page.mouse.up();
  });

  /*
   * The render loop does not measure the page.
   *
   * Asking an element how large it is forces the browser to lay the page out
   * first. The loop did that once a frame — sixty forced layouts a second for
   * a number that changes twice in a session — and it was at its worst while
   * the device was being turned, when the layout is dirty anyway. That is what
   * the stuttering on rotation was.
   */
  test('does not measure the canvas on every frame', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rects: number }).__rects = 0;
      const original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (this: Element) {
        if (this instanceof HTMLCanvasElement) {
          (window as unknown as { __rects: number }).__rects++;
        }
        return original.call(this);
      };
    });

    await startPlaying(page);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      (window as unknown as { __rects: number }).__rects = 0;
    });

    // Two seconds of play: at sixty frames a second that was over a hundred.
    await page.waitForTimeout(2000);
    const reads = await page.evaluate(
      () => (window as unknown as { __rects: number }).__rects,
    );
    expect(reads).toBeLessThan(10);
  });

});

/** Loads the probe cartridge and gets as far as the controls being live. */
async function startPlaying(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles(GB_ROM);
  await page.locator('.game-tile').first().click();
  await page.getByRole('button', { name: 'Spielen' }).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
}
