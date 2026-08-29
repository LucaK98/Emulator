/**
 * Importing a packed download.
 *
 * ROM hacks are distributed as archives, so the import unpacks them. Two paths
 * exist and both are exercised here: zip is handled by fflate, which is already
 * bundled, while rar and 7z are handled by libarchive, which is fetched on
 * demand. The 7z case is what proves that lazy load actually works in the
 * browser — the chunk, the wasm URL, and reading an entry — and rar rides on
 * exactly the same reader.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const GBA_ROM = fileURLToPath(new URL('../roms/arm.gba', import.meta.url));
const SEVEN_ZIP = fileURLToPath(new URL('../roms/packed-probe.7z', import.meta.url));

test.describe('importing an archive', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'independent of viewport',
    );
  });

  test('takes the cartridge out of a zip and plays it', async ({ page }) => {
    const zip = zipSync({
      'Rising Sun/liesmich.txt': new TextEncoder().encode('Changelog …'),
      'Rising Sun/Rising Sun.gba': new Uint8Array(readFileSync(GBA_ROM)),
    });

    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({
      name: 'Rising Sun.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });

    // Unpacked: the entry is a GBA cartridge, and its size is the ROM's, not
    // the archive's. An archive that reached the importer unopened would have
    // been rejected for its extension instead.
    const tile = page.locator('.game-tile').first();
    await expect(tile).toContainText('Game Boy Advance');
    await expect(tile).toContainText('8.6 KB');

    await tile.click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await expect
      .poll(() => canvasColourCount(page), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThan(1);
  });

  test('unpacks a 7z through the reader that also reads rar', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(SEVEN_ZIP);

    // 20 s: this is the run that fetches libarchive's WebAssembly.
    const tile = page.locator('.game-tile').first();
    await expect(tile).toContainText('Game Boy Advance', { timeout: 20_000 });
    await expect(tile).toContainText('8.6 KB');

    await tile.click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await expect
      .poll(() => canvasColourCount(page), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThan(1);
  });

  test('says what is wrong when the archive holds no cartridge', async ({ page }) => {
    const zip = zipSync({ 'liesmich.txt': new TextEncoder().encode('nur Text') });

    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({
      name: 'leer.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });

    await expect(page.locator('.footnote')).toContainText('keine ROM');
    await expect(page.locator('.game-tile')).toHaveCount(0);
  });
});

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
