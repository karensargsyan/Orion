import { defineConfig } from '@playwright/test'
import path from 'path'

export default defineConfig({
  testDir: path.join(__dirname, 'e2e/tests'),
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  outputDir: path.join(__dirname, 'test-results'),
})
