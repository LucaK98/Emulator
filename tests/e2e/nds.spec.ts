import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const NDS_ROM = fileURLToPath(new URL('../roms/nds-probe.nds', import.meta.url));

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
});

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
