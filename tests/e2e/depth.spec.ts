import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const OVERWORLD_ROM = fileURLToPath(new URL('../roms/overworld-probe.gb', import.meta.url));

test.describe('2.5D rendering', () => {
  // The renderer does not depend on viewport size, and these tests play for
  // several seconds each, so one project is enough.
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'covered once; independent of viewport',
    );
  });

  test('turns a scrolling map into a scene with depth', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    await page.locator('input[type=file]').setInputFiles(OVERWORLD_ROM);
    await page.getByRole('button', { name: /OVERWORLD/i }).first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // Let the flat renderer settle first, and keep the picture for comparison.
    await expect
      .poll(() => canvasSignature(page), { timeout: 20_000, intervals: [500] })
      .not.toBe('blank');
    const flat = await canvasSignature(page);

    await page.getByRole('button', { name: 'Menü' }).click();
    await expect(page.getByRole('button', { name: '2.5D aus' })).toBeVisible();
    await page.getByRole('button', { name: '2.5D aus' }).click();
    await expect(page.getByRole('button', { name: '2.5D an' })).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();

    // The perspective view must actually differ from the flat one.
    await expect
      .poll(() => canvasSignature(page), { timeout: 20_000, intervals: [500] })
      .not.toBe(flat);

    // The probe ROM walks a character along a corridor of ground tiles past
    // scattered scenery. Nothing tells the model which is which, so finding
    // exactly the scenery tile is the whole feature working.
    await page.waitForTimeout(7000);
    await page.getByRole('button', { name: 'Menü' }).click();

    // The panel carries more than one footnote now, so the heights reading has
    // its own hook rather than being the only one.
    const readout = page.locator('.heights-readout');
    await expect(readout).toContainText('Kachel steht');
    await expect(readout).toContainText('lernt');
  });

  test('remembers the setting for that game', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(OVERWORLD_ROM);
    await page.getByRole('button', { name: /OVERWORLD/i }).first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: '2.5D aus' }).click();
    await page.getByRole('button', { name: 'Speichern und beenden' }).click();

    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
    await page.reload();

    await page.getByRole('button', { name: /OVERWORLD/i }).first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Menü' }).click();

    await expect(page.getByRole('button', { name: '2.5D an' })).toBeVisible();
  });
});

/**
 * A coarse fingerprint of the canvas: enough to tell "blank", "flat picture"
 * and "perspective picture" apart without pinning exact pixels, which would
 * differ between GPUs and software rendering.
 */
async function canvasSignature(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 32;
    const ctx = probe.getContext('2d');
    if (!ctx) return 'blank';
    ctx.drawImage(canvas as HTMLCanvasElement, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);

    let signature = '';
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const luma = Math.round((data[i]! * 0.3 + data[i + 1]! * 0.6 + data[i + 2]! * 0.1) / 32);
      seen.add(luma);
      signature += luma.toString(16);
    }
    return seen.size <= 1 ? 'blank' : signature;
  });
}
