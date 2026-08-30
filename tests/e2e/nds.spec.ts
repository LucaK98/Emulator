import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const NDS_ROM = fileURLToPath(new URL('../roms/nds-probe.nds', import.meta.url));
/** A single-screen console, to check the new layout is not forced on it. */
const GBA_ROM = fileURLToPath(new URL('../roms/gba-depth-probe.gba', import.meta.url));

test.describe('Nintendo DS', () => {
  // The DS core is heavy; once through is enough and it does not depend on
  // viewport size.
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'covered once; independent of viewport',
    );
  });

  test('imports a DS cartridge and draws both screens', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    await page.locator('input[type=file]').setInputFiles(NDS_ROM);

    const tile = page.locator('.game-tile').first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Nintendo DS');

    await tile.click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // Stacked, the picture is taller than it is wide.
    await expect
      .poll(() => drawnAspect(page), { timeout: 30_000, intervals: [500] })
      .toBeLessThan(1);
  });

  test('offers the extra buttons the DS has', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(NDS_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    for (const label of ['L', 'R', 'X', 'Y']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
  });

  test('rearranges the screens', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(NDS_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await expect.poll(() => drawnAspect(page), { timeout: 30_000, intervals: [500] }).toBeLessThan(1);

    await page.getByRole('button', { name: 'Menü' }).click();
    await expect(page.getByRole('heading', { name: 'Bildschirme' })).toBeVisible();
    await page.getByRole('button', { name: 'Nebeneinander' }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();

    // Side by side, the picture is wider than it is tall.
    await expect
      .poll(() => drawnAspect(page), { timeout: 30_000, intervals: [500] })
      .toBeGreaterThan(1.5);
  });

  /*
   * The screens get the whole display, not the half above the buttons.
   *
   * The picture is exactly two screens tall, so an even split is the same
   * thing as the picture being centred: the seam then falls on the display's
   * own middle line. Before this the stage was a row above the controls, the
   * seam sat well above the middle, and both screens were smaller than they
   * needed to be.
   */
  test('splits the two screens on the middle of the display', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(NDS_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await expect.poll(() => drawnAspect(page), { timeout: 30_000, intervals: [500] }).toBeLessThan(1);

    const box = await drawnBox(page);
    // Measured against the display, not against the canvas: the picture was
    // always centred inside its own element, and that element used to be the
    // row above the buttons — which is exactly the thing being fixed.
    expect(Math.abs(box.seam - box.displayHeight / 2)).toBeLessThan(6);

    // And large: as tall as the display's width allows, rather than squeezed
    // into what was left over above the buttons.
    expect(box.height / box.displayHeight).toBeGreaterThan(0.6);
  });

  /*
   * Only one of the two can have the taps.
   *
   * The buttons overlay the lower screen, so while they are up a press of the
   * d-pad must not also be a poke at the console's touch screen. Hiding them
   * hands the lower screen over — and takes the menu button with them, so the
   * corner carries one.
   */
  test('hands the lower screen its touches only once the buttons are out of the way', async ({
    page,
  }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(NDS_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    const canvas = page.locator('canvas.player-canvas');
    await expect(canvas).toHaveAttribute('data-touchscreen', 'aus');
    await expect(page.locator('.touch-surface')).toBeVisible();
    await expect(page.getByRole('button', { name: 'A', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Tasten ausblenden' }).click();

    await expect(canvas).toHaveAttribute('data-touchscreen', 'an');
    await expect(page.locator('.touch-surface')).toHaveCount(0);
    // Without the buttons there is no menu button either, so the corner has one.
    await expect(page.getByRole('button', { name: 'Menü' })).toBeVisible();

    await page.getByRole('button', { name: 'Tasten einblenden' }).click();

    await expect(canvas).toHaveAttribute('data-touchscreen', 'aus');
    await expect(page.getByRole('button', { name: 'A', exact: true })).toBeVisible();
  });

  test('leaves the single-screen consoles their own layout', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GBA_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // Nothing to hand over, so nothing to hide and nothing to report.
    await expect(page.locator('.player.is-overlaid')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tasten ausblenden' })).toHaveCount(0);
    await expect(page.locator('canvas.player-canvas')).not.toHaveAttribute('data-touchscreen');
  });
});

/** Where the drawn picture sits on the display, in CSS pixels. */
async function drawnBox(page: import('@playwright/test').Page): Promise<{
  seam: number;
  height: number;
  displayHeight: number;
}> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const source = canvas as HTMLCanvasElement;
    const probe = document.createElement('canvas');
    probe.width = source.width;
    probe.height = source.height;
    const ctx = probe.getContext('2d');
    const rect = source.getBoundingClientRect();
    const nothing = { seam: 0, height: 0, displayHeight: window.innerHeight };
    if (!ctx) return nothing;
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);

    let top = -1;
    let bottom = -1;
    for (let y = 0; y < probe.height; y++) {
      let lit = false;
      for (let x = 0; x < probe.width && !lit; x++) {
        const i = (y * probe.width + x) * 4;
        if (data[i]! + data[i + 1]! + data[i + 2]! > 24) lit = true;
      }
      if (!lit) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0) return nothing;

    // Buffer rows back into the page: the buffer covers the element exactly.
    const scale = rect.height / probe.height;
    const drawnTop = rect.top + top * scale;
    const drawnHeight = (bottom - top + 1) * scale;
    return {
      seam: drawnTop + drawnHeight / 2,
      height: drawnHeight,
      displayHeight: window.innerHeight,
    };
  });
}

/** Aspect ratio of the region actually drawn, found from the letterbox. */
async function drawnAspect(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const source = canvas as HTMLCanvasElement;
    const probe = document.createElement('canvas');
    probe.width = source.width;
    probe.height = source.height;
    const ctx = probe.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);

    let minX = probe.width;
    let minY = probe.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const i = (y * probe.width + x) * 4;
        if (data[i]! + data[i + 1]! + data[i + 2]! <= 24) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return 0;
    return (maxX - minX + 1) / (maxY - minY + 1);
  });
}
