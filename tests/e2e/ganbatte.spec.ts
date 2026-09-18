/**
 * Ganbatte — the Spanish tracker that ships alongside the emulator under
 * /ganbatte/.
 *
 * It is a plain static app (no build step, no bundler), so the things worth
 * testing are the ones that only exist in a real browser: that a logged day
 * survives a reload, that a card actually gets scheduled, that the quiz
 * answers back, and that the installed app starts with the network off.
 *
 * The arithmetic behind all of that — intervals and local calendar days — is
 * checked directly against the modules, because that is where an off-by-one
 * would silently cost someone their streak.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const APP = './ganbatte/';

/** The bottom tab bar; the tiles on the dashboard carry similar words. */
function tab(page: Page, label: string) {
  return page.locator('.tab', { hasText: label });
}

/** The app's entire state, as it sits in local storage. */
async function storedState(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('ganbatte.state.v1') || 'null'));
}

test.describe('Ganbatte', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'one phone viewport is enough; this is about behaviour, not layout',
    );
  });

  test('logs a spoken day and still knows it after a reload', async ({ page }) => {
    await page.goto(APP);
    await expect(page.locator('.streak__count')).toHaveText('0');

    await page.getByRole('button', { name: /Heute gesprochen/ }).click();
    await expect(page.locator('.streak__count')).toHaveText('1');
    // Today's dot is green, and it is the only one.
    await expect(page.locator('.calendar__day.is-done')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.streak__count')).toHaveText('1');

    const state = await storedState(page);
    expect(state.streak.current).toBe(1);
    expect(state.speakingLog).toHaveLength(1);
  });

  test('a new card is due at once and lands on tomorrow when it sat', async ({ page }) => {
    await page.goto(APP);
    await tab(page, 'Vokabeln').click();

    await page.getByRole('button', { name: /Neue Vokabel/ }).click();
    await page.locator('.form .input').nth(0).fill('la playa');
    await page.locator('.form .input').nth(1).fill('der Strand');
    await page.locator('.form .input').nth(2).fill('Play a Beach');
    await page.getByRole('button', { name: 'Hinzufügen' }).click();

    await page.getByRole('button', { name: /Lernrunde starten/ }).click();
    await expect(page.locator('.flashcard__es')).toHaveText('la playa');
    // The translation stays hidden until it has been recalled.
    await expect(page.locator('.flashcard__de')).toHaveCount(0);

    await page.locator('.flashcard').click();
    await expect(page.locator('.flashcard__de')).toHaveText('der Strand');
    await page.getByRole('button', { name: /Wusste ich/ }).click();

    // Round over: back to the overview, nothing left for today.
    await expect(page.getByRole('button', { name: /Alles wiederholt/ })).toBeVisible();

    const state = await storedState(page);
    expect(state.vocab).toHaveLength(1);
    const tomorrow = await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
    });
    expect(state.vocab[0].nextReview).toBe(tomorrow);
    expect(state.vocab[0].step).toBe(1);
  });

  test('the cognate quiz answers back and records the attempt', async ({ page }) => {
    await page.goto(APP);
    await tab(page, 'Cognates').click();

    await expect(page.locator('.quiz__word')).not.toBeEmpty();
    await expect(page.locator('.option')).toHaveCount(3);

    await page.locator('.option').first().click();

    // Whatever was picked, the right answer is revealed immediately.
    await expect(page.locator('.option.is-right')).toHaveCount(1);
    await expect(page.locator('.quiz__feedback')).toContainText(/Exacto|Fast/);

    const state = await storedState(page);
    expect(Object.keys(state.cognatesProgress.hits)).toHaveLength(1);
  });

  test('starts with the network off once the worker holds the shell', async ({ page, context }) => {
    await page.goto(APP);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The first navigation happened before the worker controlled the page.
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await page.getByRole('button', { name: /Heute gesprochen/ }).click();
    await expect(page.locator('.streak__count')).toHaveText('1');

    await context.setOffline(true);
    try {
      await page.reload();
      // Shell from the cache, data from local storage: the streak is still there.
      await expect(page.locator('.streak__count')).toHaveText('1');
      await expect(tab(page, 'Cognates')).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('is installable: manifest, scope and icons', async ({ page, request }) => {
    await page.goto(APP);

    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    expect(href).toBe('./manifest.json');

    const manifestUrl = new URL('manifest.json', page.url()).href;
    const manifest = await (await request.get(manifestUrl)).json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.name).toContain('Ganbatte');
    // Relative start_url and scope keep the app working under /Emulator/.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');

    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(
      manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable'),
    ).toBe(true);

    for (const icon of manifest.icons as Array<{ src: string }>) {
      const response = await request.get(new URL(icon.src, manifestUrl).href);
      expect(response.status(), `${icon.src} must exist`).toBe(200);
      expect(response.headers()['content-type']).toContain('image/png');
    }

    // iOS ignores the manifest and needs its own icon.
    await expect(page.locator('link[rel=apple-touch-icon]')).toHaveAttribute(
      'href',
      './icons/apple-touch-icon.png',
    );
  });

  test('intervals and calendar days hold at the edges', async ({ page }) => {
    await page.goto(APP);
    // The page is already at the app root, so its own URL is the module base.
    const base = page.url();

    const result = await page.evaluate(async (root) => {
      const dates = await import(`${root}js/dates.js`);
      const srs = await import(`${root}js/srs.js`);

      const card = srs.createCard({ es: 'el sol', translation: 'die Sonne' }, '2026-03-28');

      // Four "knew it" answers walk up the ladder 1 → 3 → 7 → 14.
      const schedule: string[] = [];
      let walking = card;
      let day = '2026-03-28';
      for (let i = 0; i < 4; i += 1) {
        walking = srs.review(walking, true, day, dates.addDays);
        schedule.push(walking.nextReview);
        day = walking.nextReview;
      }

      const forgotten = srs.review(walking, false, '2026-05-01', dates.addDays);

      return {
        schedule,
        // 29 March 2026 is the European clock change: a 23-hour day that must
        // still count as one day.
        dstGap: dates.daysBetween('2026-03-28', '2026-03-29'),
        acrossMonth: dates.daysBetween('2026-02-27', '2026-03-02'),
        // A forgotten card comes back in the same round, not tomorrow.
        forgottenDue: forgotten.nextReview,
        forgottenStep: forgotten.step,
      };
    }, base);

    expect(result.schedule).toEqual(['2026-03-29', '2026-04-01', '2026-04-08', '2026-04-22']);
    expect(result.dstGap).toBe(1);
    expect(result.acrossMonth).toBe(3);
    expect(result.forgottenDue).toBe('2026-05-01');
    expect(result.forgottenStep).toBe(0);
  });
});
