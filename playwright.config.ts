import { defineConfig, devices } from '@playwright/test';

// Local runs can point at a pre-installed Chromium (e.g. /opt/pw-browsers/chromium)
// via CHROMIUM_PATH; CI installs browsers with `npx playwright install`.
const chromiumPath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173/ppt/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
  ],
  webServer: {
    // Builds and serves in one step so the bundle always carries the settings
    // below, whatever the caller built beforehand.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173/ppt/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // The proxy URL is baked in at build time, so the only way to exercise
      // the recognition / web-lyrics / learning paths end to end is to build
      // with one. It points back at the preview server: every test intercepts
      // the routes it cares about, and anything left unintercepted gets the
      // SPA's HTML, which every caller already treats as "no proxy answer".
      VITE_RECOGNITION_PROXY_URL: 'http://localhost:4173/ppt/__proxy',
    },
  },
});
