// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test';

const baseURL = process.env.OPENPWR_TEST_ORIGIN || 'http://127.0.0.1:4483/';

export default defineConfig({
  testDir: '.',
  testMatch: 'release.spec.js',
  outputDir: '../../artifacts/browser-results',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'firefox',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
  webServer: process.env.OPENPWR_TEST_ORIGIN ? undefined : {
    command: 'node ../../scripts/serve.mjs --port=4483',
    url: baseURL,
  },
});
