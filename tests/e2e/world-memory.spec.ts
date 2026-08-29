/**
 * The explored world outlives the session.
 *
 * The depth view draws its ground from what the player has walked through,
 * because the console holds barely more map than it shows. Earning that view
 * again from nothing on every launch would make it close to useless, so it is
 * stored per game beside the save state — and only alongside it, because the
 * two have to agree about where the player is standing.
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/** Scrolls its map on its own, so world accumulates without any input. */
const ROM = fileURLToPath(new URL('../roms/overworld-probe.gb', import.meta.url));

test.describe('the explored world', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'independent of viewport',
    );
  });

  test('is still there after leaving the game and coming back', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(ROM);

    await enterWithDepth(page);
    // Long enough to have walked well past a single screen.
    await page.waitForTimeout(9000);

    const explored = await readWorldCells(page);
    // Walked well past the screen it started on, whatever the frame rate.
    expect(explored).toBeGreaterThan(20 * 18);

    // Leaving is what writes both the state and the world beside it. The
    // reading above closed the menu, so it has to be opened again.
    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Speichern und beenden' }).click();
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();

    await enterWithDepth(page);
    // Deliberately brief: anything on screen now was remembered, not walked.
    await page.waitForTimeout(1200);

    const restored = await readWorldCells(page);
    // Essentially all of it: the brief play since re-entering can only add.
    expect(restored, 'the world should come back with the game').toBeGreaterThanOrEqual(
      Math.floor(explored * 0.9),
    );
  });

  test('starts blank for a game that has never been played', async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles(ROM);

    await enterWithDepth(page);
    await page.waitForTimeout(600);

    // Whatever this frame put there and no more: nothing was walked, and there
    // was nothing stored to start from.
    const cells = await readWorldCells(page, { waitForContent: false });
    expect(cells).toBeLessThan(20 * 18 * 2);
  });
});

/** Opens the game and switches the depth view on, leaving the menu closed. */
async function enterWithDepth(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.game-tile').first().click();
  await page.getByRole('button', { name: 'Spielen' }).click();
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'Menü' }).click();
  // The button reports the current state rather than the action, so the one
  // that says "off" is the one to press.
  const off = page.getByRole('button', { name: '2.5D aus', exact: true });
  if (await off.isVisible().catch(() => false)) await off.click();
  await expect(page.getByRole('button', { name: '2.5D an', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Weiter' }).click();
}

/**
 * How many tiles of world the pause menu reports.
 *
 * Read off an attribute rather than the sentence, which rounds to whole
 * screens. The reading is collected when the menu opens and reaches the page
 * one render later, so it is polled rather than grabbed in the same breath as
 * the click — otherwise it is still the previous visit's number, which is
 * exactly the sort of thing that makes a test claim the opposite of the truth.
 */
async function readWorldCells(
  page: import('@playwright/test').Page,
  { waitForContent = true } = {},
): Promise<number> {
  await page.getByRole('button', { name: 'Menü' }).click();
  const readout = page.locator('.world-readout');
  await expect(readout).toBeVisible();

  let cells = 0;
  const read = async () => {
    cells = Number(await readout.getAttribute('data-cells'));
    return cells;
  };

  if (waitForContent) {
    // Any world at all: how much depends on how many frames the machine
    // managed, which is no business of this test.
    await expect.poll(read, { timeout: 20_000, intervals: [200] }).toBeGreaterThan(0);
  }
  else {
    // Nothing is expected, so there is nothing to wait for — but the reading
    // still has to arrive before it can be trusted.
    await page.waitForTimeout(500);
    await read();
  }

  await page.getByRole('button', { name: 'Weiter' }).click();
  return cells;
}
