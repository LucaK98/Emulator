import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const TEST_ROM = fileURLToPath(new URL('../roms/cpu_instrs.gb', import.meta.url));

/** Counts distinct colours on the canvas — a black or blank canvas has one. */
async function canvasColourCount(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('canvas.player-canvas').evaluate((canvas) => {
    const source = canvas as HTMLCanvasElement;
    const probe = document.createElement('canvas');
    probe.width = 160;
    probe.height = 144;
    const ctx = probe.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(source, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    }
    return seen.size;
  });
}

test.describe('playing a game', () => {
  test('imports a cartridge, runs it, and keeps progress across a reload', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    // --- import -----------------------------------------------------------
    await page.locator('input[type=file]').setInputFiles(TEST_ROM);

    const tile = page.getByRole('button', { name: /cpu_instrs|CPU_INSTRS/i }).first();
    await expect(tile).toBeVisible();

    // --- play -------------------------------------------------------------
    await tile.click();
    await expect(page.getByRole('button', { name: 'Spielen' })).toBeVisible();
    await page.getByRole('button', { name: 'Spielen' }).click();

    // The test ROM draws its report over the first couple of seconds.
    await expect
      .poll(() => canvasColourCount(page), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThan(1);

    // --- the emulator is actually stepping frames -------------------------
    // The player samples frame rate over a one-second window, so give it one
    // full window before asking.
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Menü' }).click();

    // The pause overlay carries several footnotes now; the readout has its own hook.
    const fps = page.locator('.overlay-card .fps-readout');
    await expect(fps).toBeVisible();
    const reported = Number((await fps.textContent())?.replace(/[^\d.]/g, ''));
    /*
     * The question here is whether the loop turns at all, not how fast.
     *
     * The bar was twenty frames a second and that made the test unreliable:
     * the suite runs several browsers at once, each with a WebAssembly
     * emulator in it, and on a loaded machine a perfectly healthy loop drops
     * well below that. A stalled loop reports zero, so a handful of frames a
     * second separates the two cases and nothing about speed is claimed.
     */
    expect(reported, 'emulator should be producing frames').toBeGreaterThan(5);

    // --- save and leave ---------------------------------------------------
    await page.getByRole('button', { name: 'Speichern und beenden' }).click();
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    // The auto save state supplies the library thumbnail, so its presence is
    // proof that the state was written.
    await expect(page.locator('.game-thumb img')).toBeVisible();

    // --- survives a reload ------------------------------------------------
    await page.reload();
    await expect(page.locator('.game-thumb img')).toBeVisible({ timeout: 15_000 });

    // Re-entering restores rather than starting over.
    await page.getByRole('button', { name: /cpu_instrs|CPU_INSTRS/i }).first().click();
    await expect(page.getByText('Spielstand wiederhergestellt.')).toBeVisible({ timeout: 15_000 });
  });

  test('rejects a file that is not a cartridge', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    await page.locator('input[type=file]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not a Game Boy cartridge'),
    });

    // It must not crash, and must not land in the library as a playable game.
    await expect(page.locator('.game-tile')).toHaveCount(0);
  });
});
