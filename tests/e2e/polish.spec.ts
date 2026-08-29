import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const GB_ROM = fileURLToPath(new URL('../roms/overworld-probe.gb', import.meta.url));
const NDS_ROM = fileURLToPath(new URL('../roms/nds-probe.nds', import.meta.url));
/*
 * For measuring which way the picture travels. The overworld probe cannot
 * serve: its map repeats every tile, so matching two pictures only ever gives
 * the shift modulo eight pixels and the direction is not in there at all. This
 * one repeats every 128 pixels, well outside anything measured below.
 */
const SCROLL_ROM = fileURLToPath(new URL('../roms/gba-scroll-probe.gba', import.meta.url));

test.describe('rewind, fast-forward and screenshots', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'covered once; independent of viewport',
    );
  });

  test('offers rewind where a state history fits, and says so where it does not', async ({
    page,
  }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GB_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.waitForTimeout(600);

    await expect(page.getByRole('button', { name: 'Zurückspulen' })).toBeVisible();
    await page.getByRole('button', { name: 'Menü' }).click();
    await expect(page.locator('.overlay-card')).toContainText('Rücklauf: bis zu');
  });

  test('leaves rewind out for the DS, whose states are far too large', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(NDS_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.waitForTimeout(1500);

    await expect(page.getByRole('button', { name: 'Zurückspulen' })).toBeHidden();
    // Fast-forward costs nothing extra, so it stays.
    await expect(page.getByRole('button', { name: 'Vorspulen' })).toBeVisible();

    await page.getByRole('button', { name: 'Menü' }).click();
    await expect(page.locator('.overlay-card')).toContainText('nicht möglich');
  });

  test('rewinding runs the world backwards', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(SCROLL_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    // Long enough to build a history that outlasts the measurement. Rewinding
    // runs at about three times speed, so a few seconds of play is spent in
    // about a second of holding — and once the history runs out the game
    // simply carries on forwards, which would be measured as travel in the
    // wrong direction.
    await page.waitForTimeout(9000);

    // The probe scrolls its map by one pixel per frame over a picture that does
    // not repeat within the range searched, so the direction of travel can be
    // read straight off it — a far better check than "something changed".
    const forwards = await measureScroll(page);
    expect(Math.abs(forwards), 'the map should be scrolling').toBeGreaterThan(2);

    const rewind = page.getByRole('button', { name: 'Zurückspulen' });
    const box = (await rewind.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // The control must register as held, otherwise the measurement below would
    // be testing nothing.
    await expect(rewind).toHaveClass(/is-pressed/);

    const backwards = await measureScroll(page);
    await page.mouse.up();

    expect(Math.abs(backwards), 'rewinding should still be moving').toBeGreaterThan(2);
    expect(
      Math.sign(backwards),
      'rewinding should reverse the direction of travel',
    ).toBe(-Math.sign(forwards));
  });

  test('produces a screenshot file', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GB_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.waitForTimeout(800);

    await page.getByRole('button', { name: 'Menü' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Screenshot' }).click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    expect(await file.path()).toBeTruthy();
  });

  test('keeps the LCD grid setting', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Einstellungen' }).click();

    const slider = page.getByRole('slider').first();
    await slider.fill('0.3');
    await expect(page.locator('.slider-value').first()).toContainText('30');

    await page.reload();
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(page.locator('.slider-value').first()).toContainText('30');
  });
});

/**
 * How far the picture travelled horizontally, in canvas pixels. Positive and
 * negative are opposite directions; only the sign and the fact that there was
 * movement are meaningful.
 *
 * The whole measurement happens inside the page, across animation frames.
 * Reading the canvas from two separate evaluate calls returns the same content
 * even when the emulator is plainly running, so the samples have to be taken
 * without handing control back to the test.
 *
 * Several short samples rather than one long one, reduced to their median. The
 * probe's map repeats, so matching two pictures far apart in time can lock
 * onto the wrong repetition and report travel backwards as travel forwards; a
 * short step is unambiguous, and the median shrugs off a single bad match.
 */
async function measureScroll(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('canvas.player-canvas').evaluate(async (canvas) => {
    const source = canvas as HTMLCanvasElement;

    const readRow = (row: number): number[] => {
      const probe = document.createElement('canvas');
      probe.width = source.width;
      probe.height = source.height;
      const ctx = probe.getContext('2d');
      if (!ctx) return [];
      ctx.drawImage(source, 0, 0);
      const { data } = ctx.getImageData(0, Math.min(row, probe.height - 1), probe.width, 1);
      const profile: number[] = [];
      for (let i = 0; i < data.length; i += 4) {
        profile.push(data[i]! * 0.3 + data[i + 1]! * 0.6 + data[i + 2]! * 0.1);
      }
      return profile;
    };

    // Some rows barely change — the probe's walkable corridor is nearly plain —
    // so the row with the most contrast is the one worth watching.
    const busiestRow = (): number => {
      const probe = document.createElement('canvas');
      probe.width = source.width;
      probe.height = source.height;
      const ctx = probe.getContext('2d');
      if (!ctx) return 0;
      ctx.drawImage(source, 0, 0);
      const { data } = ctx.getImageData(0, 0, probe.width, probe.height);

      let bestRow = 0;
      let bestVariance = -1;
      for (let y = 0; y < probe.height; y += 20) {
        let mean = 0;
        for (let x = 0; x < probe.width; x++) mean += data[(y * probe.width + x) * 4]!;
        mean /= probe.width;

        let variance = 0;
        for (let x = 0; x < probe.width; x++) {
          const delta = data[(y * probe.width + x) * 4]! - mean;
          variance += delta * delta;
        }
        if (variance > bestVariance) {
          bestVariance = variance;
          bestRow = y;
        }
      }
      return bestRow;
    };

    const waitFrames = (count: number) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });

    const row = busiestRow();
    const offsets: number[] = [];

    for (let sample = 0; sample < 5; sample++) {
      const before = readRow(row);
      await waitFrames(3);
      const after = readRow(row);
      if (before.length === 0) return 0;
      offsets.push(matchOffset(before, after));
    }
    offsets.sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)]!;

    function matchOffset(before: number[], after: number[]): number {

      // Offsets are in canvas pixels: the picture is drawn several times its
      // native size, so a few emulated pixels of scroll is tens of them here.
      const window = 160;
      let bestOffset = 0;
      let bestError = Infinity;
      for (let offset = -window; offset <= window; offset++) {
        let error = 0;
        let count = 0;
        for (let i = window; i < before.length - window; i++) {
          const other = after[i + offset];
          if (other === undefined) continue;
          error += Math.abs(before[i]! - other);
          count++;
        }
        if (count === 0) continue;
        const mean = error / count;
        if (mean < bestError) {
          bestError = mean;
          bestOffset = offset;
        }
      }
      return bestOffset;
    }
  });
}
