import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const ROM = fileURLToPath(new URL('../roms/cpu_instrs.gb', import.meta.url));

test.describe('save slots and backup', () => {
  // These play for several seconds and do not depend on viewport size.
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'covered once; independent of viewport',
    );
  });

  test('writes a slot, and the slot survives a reload', async ({ page }) => {
    await page.goto('./');
    await importAndPlay(page);

    await page.getByRole('button', { name: 'Menü' }).click();
    await expect(page.getByRole('heading', { name: 'Spielstände' })).toBeVisible();

    // Every slot starts empty; the automatic one is not hand-writable.
    const slotOne = page.getByRole('button', { name: 'Slot 1 speichern' });
    await expect(slotOne).toContainText('leer');
    await expect(page.getByRole('button', { name: 'Auto speichern' })).toBeDisabled();

    await slotOne.click();
    await expect(page.locator('.slots-panel .footnote').first()).toContainText(
      'In Slot 1 gespeichert',
    );
    // A written slot shows when it was made and carries a picture of the moment.
    await expect(slotOne).not.toContainText('leer');
    await expect(slotOne.locator('img')).toBeVisible();

    await page.reload();
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.getByRole('button', { name: 'Menü' }).click();

    // Slots are labelled by the active mode, so switch before looking for a
    // loadable one; an empty slot stays disabled in Laden mode.
    await page.getByRole('button', { name: 'Laden' }).click();
    await expect(page.getByRole('button', { name: 'Slot 1 laden' })).toBeEnabled();
  });

  test('loads a slot back', async ({ page }) => {
    await page.goto('./');
    await importAndPlay(page);

    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Slot 2 speichern' }).click();
    await expect(page.locator('.slots-panel .footnote').first()).toContainText('gespeichert');

    await page.getByRole('button', { name: 'Laden' }).click();
    await page.getByRole('button', { name: 'Slot 2 laden' }).click();
    await expect(page.locator('.slots-panel .footnote').first()).toContainText('Slot 2 geladen');
  });

  test('backs everything up and puts it back after a deletion', async ({ page }) => {
    await page.goto('./');
    await importAndPlay(page);

    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Slot 3 speichern' }).click();
    await expect(page.locator('.slots-panel .footnote').first()).toContainText('gespeichert');
    await page.getByRole('button', { name: 'Speichern und beenden' }).click();
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    // --- back up, cartridge included so the restore is self-contained -----
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await page.getByRole('checkbox').check();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Backup erstellen' }).click();
    const archive = await (await download).path();
    expect(archive).toBeTruthy();
    await expect(page.locator('.panel .footnote')).toContainText('Zwischenstände');

    // --- throw the game away ---------------------------------------------
    await page.getByRole('button', { name: 'Schließen' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('.tile-delete').first().click();
    await expect(page.locator('.game-tile')).toHaveCount(0);

    // --- and put it back --------------------------------------------------
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await page.locator('input[type=file]').setInputFiles(archive!);
    await expect(page.locator('.panel .footnote')).toContainText('Eingespielt:');

    await page.getByRole('button', { name: 'Schließen' }).click();
    await expect(page.locator('.game-tile')).toHaveCount(1);

    // The slot came back with the game.
    await page.locator('.game-tile').first().click();
    await page.getByRole('button', { name: 'Spielen' }).click();
    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Laden' }).click();
    await expect(page.getByRole('button', { name: 'Slot 3 laden' })).toBeEnabled();
  });

  test('rejects a file that is not a backup', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Einstellungen' }).click();

    await page.locator('input[type=file]').setInputFiles({
      name: 'not-a-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('definitely not a zip archive'),
    });

    await expect(page.locator('.panel .footnote')).toBeVisible();
    await expect(page.locator('.game-tile')).toHaveCount(0);
  });
});

async function importAndPlay(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(ROM);
  await page.locator('.game-tile').first().click();
  await page.getByRole('button', { name: 'Spielen' }).click();
  // Let the core actually run, so a state has something in it.
  await page.waitForTimeout(1200);
}
