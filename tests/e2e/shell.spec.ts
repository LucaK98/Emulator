import { expect, test } from '@playwright/test';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test.describe('app shell', () => {
  test('boots into the library on a non-iOS client', async ({ page }) => {
    await page.goto('./');

    await expect(page.getByRole('heading', { name: 'Emulator', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Systemstatus' })).toBeVisible();
  });

  test('reports cross-origin isolation and SharedArrayBuffer as available', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'Systemstatus' })).toBeVisible();

    // The preview server sends real COOP/COEP headers, so isolation must hold
    // without the service worker fallback kicking in.
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined')).toBe(true);

    await expect(page.getByText('Cross-Origin-Isolation')).toBeVisible();
    await expect(page.locator('.row', { hasText: 'SharedArrayBuffer' })).toContainText('Verfügbar');
  });

  test('requests persistent storage on launch', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('.row', { hasText: 'Dauerhafter Speicher' })).toBeVisible();
    // Chromium grants persistence headlessly only sometimes; what must hold is
    // that the app asked and rendered a definite answer rather than hanging.
    await expect(page.locator('.row', { hasText: 'Dauerhafter Speicher' })).not.toContainText('—');
  });

  test('serves an installable manifest', async ({ page, request }) => {
    await page.goto('./');
    const response = await request.get('./manifest.webmanifest');
    expect(response.ok()).toBe(true);

    const manifest = await response.json();
    // standalone is what exempts the app from WebKit's 7-day storage eviction.
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  });

  test('does not scroll horizontally', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'Systemstatus' })).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test.describe('install gate on iOS', () => {
  test.use({ userAgent: IPHONE_UA });

  test('blocks the library until the app is installed', async ({ page }) => {
    await page.goto('./');

    await expect(
      page.getByRole('heading', { name: 'Zum Home-Bildschirm hinzufügen' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Systemstatus' })).toBeHidden();
  });

  test('lets the user continue anyway, and remembers that choice', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Ohne Installation fortfahren' }).click();

    await expect(page.getByRole('heading', { name: 'Systemstatus' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Systemstatus' })).toBeVisible();
  });
});
