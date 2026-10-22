/**
 * Softening the edges between emulated pixels.
 *
 * The DS fills a phone at about 4.6 device pixels per emulated one, which is
 * not a whole number — so with hard edges some rows come out a pixel thicker
 * than their neighbours and the unevenness crawls as the picture scrolls.
 *
 * What separates this from simply smoothing the picture is that the inside of
 * a block must keep its exact colour: only the last output pixel at each
 * boundary may blend. A filter that fails that is a blur, and pixel art does
 * not survive one. So the test asserts both halves — that something changed at
 * the edges, and that nothing changed in the middle of a flat area.
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const NDS_ROM = fileURLToPath(new URL('../roms/nds-probe.nds', import.meta.url));

test.describe('the picture filter', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'about sampling, not about viewport',
    );
  });

  test('softens the edges and leaves flat areas exactly as they were', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    const hard = await playAndSample(page, NDS_ROM);
    // The probe paints the lower screen one flat colour and the upper one a
    // field of gradients, so one sample is a flat area and the other is full
    // of edges.
    expect(hard.flat, 'the flat screen must have a colour at all').not.toEqual([0, 0, 0]);

    await setFilter(page, 'Weich');
    const soft = await playAndSample(page, NDS_ROM);

    expect(soft.flat, 'a flat area must keep its exact colour').toEqual(hard.flat);
    /*
     * The telling one: how wide the blend is.
     *
     * At the seam the probe meets pure blue with a screen that has none, so a
     * row's blue channel says exactly how far the blend reached. Hard edges
     * give no mixed rows at all. Softening only the boundary gives about one
     * device pixel of them — the whole point. Plain smoothing blends across
     * half an emulated pixel, four or five device pixels here, and that is
     * what turns pixel art to mush.
     */
    expect(hard.blendRows, 'hard edges blend nothing').toBeLessThanOrEqual(1);
    expect(soft.blendRows, 'the blend may not span more than one output pixel').toBeLessThanOrEqual(2);
    expect(soft.edges, 'the edges must actually be sampled differently').not.toEqual(hard.edges);
  });

  test('remembers the setting', async ({ page }) => {
    await page.goto('./');
    await setFilter(page, 'Weich');
    await page.reload();
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(page.getByRole('button', { name: 'Weich', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

/** Picks an edge mode in the settings and returns to the library. */
async function setFilter(page: import('@playwright/test').Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await expect(page.getByRole('heading', { name: 'Bild' })).toBeVisible();
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
}

/**
 * Plays the probe and reads two points: the middle of the flat lower screen,
 * and a band of the upper one, which is nothing but edges.
 */
async function playAndSample(
  page: import('@playwright/test').Page,
  rom: string,
): Promise<Sample> {
  if ((await page.locator('.game-tile').count()) === 0) {
    await page.locator('input[type=file]').setInputFiles(rom);
  }
  await page.locator('.game-tile').first().click();
  await page.getByRole('button', { name: 'Spielen' }).click();

  await expect
    .poll(async () => (await sample(page)).flat, { timeout: 30_000, intervals: [500] })
    .not.toEqual([0, 0, 0]);

  const taken = await sample(page);
  await page.getByRole('button', { name: 'Menü' }).click();
  await page.getByRole('button', { name: 'Speichern und beenden' }).click();
  await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
  return taken;
}

interface Sample {
  flat: number[];
  /** Rows at the seam that are a mixture of the two screens. */
  blendRows: number;
  edges: number[];
}

async function sample(page: import('@playwright/test').Page): Promise<Sample> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const source = canvas as HTMLCanvasElement;
    const probe = document.createElement('canvas');
    probe.width = source.width;
    probe.height = source.height;
    const ctx = probe.getContext('2d');
    if (!ctx) return { flat: [0, 0, 0], blendRows: 0, edges: [] };
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const at = (x: number, y: number) => {
      const i = (y * probe.width + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };

    // Three quarters down is well inside the lower screen, which the probe
    // paints one flat colour.
    const flat = at(probe.width >> 1, Math.floor(probe.height * 0.75));

    // The lower screen is pure blue and the upper one has none, so at the seam
    // the blue channel measures the blend directly. Counting rows rather than
    // probing one point keeps this independent of exactly where the seam falls.
    const column = probe.width >> 1;
    const seam = probe.height >> 1;
    let blendRows = 0;
    for (let y = seam - 8; y <= seam + 8; y++) {
      const blue = at(column, y)[2]!;
      if (blue > 40 && blue < 215) blendRows++;
    }
    // A row across the upper screen's gradients: every few pixels an edge.
    const edges: number[] = [];
    const y = Math.floor(probe.height * 0.3);
    for (let x = 0; x < probe.width; x += 7) edges.push(...at(x, y));
    return { flat, blendRows, edges };
  });
}
