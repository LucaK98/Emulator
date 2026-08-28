import { defineConfig } from '@playwright/test';

const PORT = 4173;
const BASE_PATH = '/Emulator/';

/**
 * The e2e suite runs against the production build served by `vite preview`,
 * because the things worth testing (service worker, cross-origin isolation,
 * the built manifest) only exist there.
 *
 * Viewports are declared explicitly rather than via Playwright's device
 * descriptors so the iPhone sizes we care about stay pinned across upgrades.
 * Only Chromium is available in this environment; WebKit would be closer to
 * Safari but is not installed, so device-specific behaviour still needs a
 * manual pass on a real iPhone.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: 'on-first-retry',
    // Sandboxes that ship their own Chromium can point at it with
    // PW_CHROMIUM_PATH instead of downloading a second copy. CI leaves this
    // unset and uses `npx playwright install chromium`.
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },

  projects: [
    {
      name: 'iphone-se',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'iphone-15-pro',
      use: {
        browserName: 'chromium',
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'iphone-15-pro-max-landscape',
      use: {
        browserName: 'chromium',
        viewport: { width: 932, height: 430 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],

  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
