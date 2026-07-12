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
    // Serves the production build; run `npm run build` first (CI does this before playwright).
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173/ppt/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
