import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const GBA_ROM = fileURLToPath(new URL('../roms/arm.gba', import.meta.url));
const FAR_CART_ROM = fileURLToPath(
  new URL('../roms/gba-farcart-probe.gba', import.meta.url),
);

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

  /*
   * mGBA maps a cartridge instead of copying it, so the buffer handed to
   * loadROM has to stay valid for as long as the game runs. It briefly did
   * not, and a 16 MiB retail cartridge came out as a white screen.
   *
   * Merely padding a small test ROM does not catch this — that was tried, and
   * it passes either way, because a released allocation still holds its old
   * bytes and a tiny ROM never reads past its own first few kilobytes. What
   * catches it is a cartridge whose *picture* depends on bytes far from the
   * code, which is what this probe is: four colours stored 4, 8, 12 and nearly
   * 16 MiB in, drawn as four bands.
   */
  test('keeps the whole cartridge readable, not just its first kilobytes', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(FAR_CART_ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // Red, green, blue, white — top to bottom, one band per far marker.
    const expected = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ];

    await expect
      .poll(() => bandColours(page), { timeout: 30_000, intervals: [500] })
      .toEqual(expected);
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

/**
 * The colour of each of the four horizontal bands the far-cartridge probe
 * draws, sampled at the middle of each band and snapped to full 8-bit
 * channels — the GBA's 5-bit colours come out as 0xF8-style values once
 * scaled, which is exact enough to compare against pure red, green and blue.
 */
async function bandColours(
  page: import('@playwright/test').Page,
): Promise<number[][]> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const source = canvas as HTMLCanvasElement;
    const probe = document.createElement('canvas');
    probe.width = source.width;
    probe.height = source.height;
    const ctx = probe.getContext('2d');
    if (!ctx) return [];
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);

    // The picture is letterboxed, so the bands are found relative to the drawn
    // rectangle rather than to the canvas.
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < probe.height; y++) {
      const i = (y * probe.width + (probe.width >> 1)) * 4;
      const lit = data[i]! + data[i + 1]! + data[i + 2]! > 24;
      if (lit && top < 0) top = y;
      if (lit) bottom = y;
    }
    if (top < 0) return [];

    const height = bottom - top + 1;
    const x = probe.width >> 1;
    return [0, 1, 2, 3].map((band) => {
      const y = top + Math.floor((height * (band + 0.5)) / 4);
      const i = (y * probe.width + x) * 4;
      // 5-bit channels scale to 0, 8, 16 ... 248; round each to 0 or 255.
      return [data[i]!, data[i + 1]!, data[i + 2]!].map((v) => (v > 127 ? 255 : 0));
    });
  });
}
