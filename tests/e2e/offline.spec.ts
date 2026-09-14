/**
 * Playing with no network at all.
 *
 * This is the case the whole design is for: a game on a plane. Nothing about
 * it may depend on reaching a server — not the page, not the emulator core,
 * not the cartridge, and least of all the save. The parts live in different
 * places (the shell and the core in the service worker's cache, the cartridge
 * and the save in local storage), so it is worth one test that cuts the
 * network and simply plays.
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const ROM = fileURLToPath(new URL('../roms/overworld-probe.gb', import.meta.url));

test.describe('with no network', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'about storage and caching, not about viewport',
    );
  });

  test('plays on, and carries the save with it', async ({ page, context }) => {
    // First, online: this is the visit that puts the shell, the core and the
    // cartridge where they can be found again.
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The first navigation happened before the worker controlled the page, so
    // the reload is what makes it see the requests that follow.
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await page.locator('input[type=file]').setInputFiles(ROM);
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await expect
      .poll(() => canvasColourCount(page), { timeout: 30_000, intervals: [500] })
      .toBeGreaterThan(1);

    // Play a while, then leave the way the app expects — that is what writes
    // the save beside the cartridge.
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Speichern und beenden' }).click();
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    // Now the aeroplane.
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

      await page.locator('.game-tile').first().click();
      // The save is there, and the app says so before it starts.
      await expect(page.getByText('Spielstand wiederhergestellt.')).toBeVisible();

      await page.getByRole('button', { name: 'Spielen' }).click();
      // And the core actually runs: a picture, with nothing fetched to get it.
      await expect
        .poll(() => canvasColourCount(page), { timeout: 30_000, intervals: [500] })
        .toBeGreaterThan(1);
    }
    finally {
      await context.setOffline(false);
    }
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
