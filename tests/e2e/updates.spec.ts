/**
 * A deployed change has to reach the device.
 *
 * The service worker caches everything same-origin stale-while-revalidate,
 * which is right for the hashed asset files — their names change whenever
 * their contents do — but wrong for the page that names them. Served from the
 * cache, index.html keeps pointing at the previous build's script, so a fix
 * lands one launch late at best: the user reloads, sees the old app, reloads
 * again, and only then gets the new one. That is indistinguishable from a fix
 * that does not work, and it wasted a round.
 */

import { expect, test } from '@playwright/test';

const STALE_TITLE = 'VERALTETE HUELLE';

test.describe('reaching the device with a new build', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'iphone-15-pro',
      'about caching, not about viewport',
    );
  });

  test('prefers the freshly served shell over the cached one', async ({ page }) => {
    await settleUnderServiceWorker(page);
    await poisonCachedShell(page);

    await page.reload();

    // The poisoned copy stands for the previous deploy. Serving it is what
    // kept a pushed fix from showing up.
    await expect(page).not.toHaveTitle(STALE_TITLE);
    await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
  });

  test('still opens from the cache with no network at all', async ({ page, context }) => {
    await settleUnderServiceWorker(page);

    // Preferring the network must not cost the installed app its offline
    // start, which is the whole reason the cache exists.
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
    }
    finally {
      await context.setOffline(false);
    }
  });
});

/** Loads the app and waits until the worker is actually serving its requests. */
async function settleUnderServiceWorker(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);

  // The first navigation happened before the worker controlled the page, so it
  // is this reload that puts the shell into the cache.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Spiel hinzufügen' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Replaces every cached copy of the page with an obviously outdated one. */
async function poisonCachedShell(page: import('@playwright/test').Page): Promise<void> {
  const replaced = await page.evaluate(async (title) => {
    let count = 0;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (!path.endsWith('/') && !path.endsWith('index.html')) continue;
        await cache.put(
          request,
          new Response(`<!doctype html><title>${title}</title>`, {
            headers: { 'Content-Type': 'text/html' },
          }),
        );
        count++;
      }
    }
    return count;
  }, STALE_TITLE);

  // If nothing was cached the test would pass for the wrong reason.
  expect(replaced, 'the shell must be in the cache for this to mean anything').toBeGreaterThan(0);
}
