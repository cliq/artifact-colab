import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3789',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bash e2e/start-server.sh',
    url: 'http://localhost:3789/healthz',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
