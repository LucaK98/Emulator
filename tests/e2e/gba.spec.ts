import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const GBA_ROM = fileURLToPath(new URL('../roms/arm.gba', import.meta.url));

/** Native Game Boy Advance resolution. */
const GBA_ASPECT = 240 / 160;

test.describe('Game Boy Advance', () => {
  test('imports a GBA cartridge and runs it', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    await page.locator('input[type=file]').setInputFiles(GBA_ROM);

    const tile = page.locator('.game-tile').first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Game Boy Advance');

    await tile.click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // The suite draws its report within the first couple of seconds.
    await expect
      .poll(() => canvasColourCount(page), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThan(1);

    // The drawing buffer fills the element; the console's aspect ratio shows up
    // in the letterboxed rectangle actually drawn inside it.
    const drawn = await drawnAspect(page);
    expect(drawn).toBeCloseTo(GBA_ASPECT, 1);
  });

  test('shows shoulder buttons, which the Game Boy does not have', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GBA_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    await expect(page.getByRole('button', { name: 'L', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'R', exact: true })).toBeVisible();
  });

  test('offers no 2.5D for a system the depth renderer does not cover', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(GBA_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.waitForTimeout(400);

    await page.getByRole('button', { name: 'Menü' }).click();
    await expect(page.locator('.depth-panel')).toContainText('Game Boy Advance');
    await expect(page.getByRole('button', { name: /2\.5D (an|aus)/ })).toBeHidden();
  });
});

/**
 * Aspect ratio of the region the renderer actually drew, found as the bounding
 * box of everything that is not the black letterbox around it.
 */
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
        const lit = data[i]! + data[i + 1]! + data[i + 2]! > 24;
        if (!lit) continue;
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

/** Counts distinct colours on the canvas — a blank canvas has one. */
async function canvasColourCount(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const probe = document.createElement('canvas');
    probe.width = 60;
    probe.height = 40;
    const ctx = probe.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(canvas as HTMLCanvasElement, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    }
    return seen.size;
  });
}
