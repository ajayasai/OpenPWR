// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { alignedObservations, observationsCsv } from '../../src/aligned-observations.js';

function recordPageTraffic(page) {
  const files = [];
  page.on('request', request => files.push(new URL(request.url()).pathname.split('/').at(-1)));
  return files;
}

async function compareDownloadedCsv(page, canonicalReport, channel) {
  const pending = page.waitForEvent('download');
  await page.locator('#observations-csv').click();
  const download = await pending;
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv).toBe(observationsCsv(alignedObservations(canonicalReport, channel)));
  return csv.trimEnd().split('\n').length - 1;
}

test('mobile pressure explorer exports the acquired samples from the original report', async ({ page, request }) => {
  const files = recordPageTraffic(page);
  await page.goto('plant-evidence.html?case=pressure-spray');
  const rows = page.locator('#observations-rows tr');
  await expect(rows).toHaveCount(8);
  await expect(page.locator('#observations-score')).toContainText('0.425981');
  const downloadUrl = await page.locator('#measured-report-link').getAttribute('href');
  expect(downloadUrl).toMatch(/krsko-pressure-development\.json$/);
  const original = await request.get(downloadUrl);
  expect(original.ok()).toBe(true);
  const bytes = await original.body();
  const projection = await request.get('krsko-pressure-development.view.json');
  const view = await projection.json();
  expect(view.source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(view.source.bytes).toBe(bytes.length);
  expect((await projection.body()).length).toBeLessThan(bytes.length / 10);
  const parent = JSON.parse(bytes);
  const report = { ...parent, ...parent.conditionalSpray, schema: 'openpwr-krsko-pressure-spray-development-v1' };
  for (const channel of report.channels) {
    await page.locator('#measured-channel').selectOption(channel.name);
    expect(await compareDownloadedCsv(page, report, channel)).toBe(8);
  }
  expect(files).toContain('krsko-pressure-development.view.json');
  expect(files).not.toContain('krsko-pressure-development.json');
  expect(files).not.toContain('plant-verification.json');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('PACTEL exports include all digitized positions after paging and changing experiment', async ({ page, request }) => {
  const files = recordPageTraffic(page);
  await page.goto('plant-evidence.html?case=pactel');
  const report = await (await request.get('pressurizer-validation.json')).json();
  for (const [choice, source, count] of [['pactel', report, 491], ['pactel-holdout', report.holdoutComparison, 291]]) {
    await page.locator('#measured-case').selectOption(choice);
    await expect(page.locator('#observations-page')).toContainText(String(count));
    const initialPage = await page.locator('#observations-page').textContent();
    await page.locator('#observations-next').click();
    await expect(page.locator('#observations-page')).not.toHaveText(initialPage);
    expect(await compareDownloadedCsv(page, source, source.channels[0])).toBe(count);
  }
  expect(files.filter(file => file === 'pressurizer-validation.view.json')).toHaveLength(1);
  expect(files).not.toContain('pressurizer-validation.json');
});

test('current startup recording and checks open without fetching the complete report', async ({ page, request }) => {
  const files = recordPageTraffic(page);
  await page.goto('continuous.html');
  const source = await (await request.get('continuous-verification.json')).json();
  await page.locator('#recording-source').selectOption('current');
  await page.locator('#recording-load').click();
  await expect(page.locator('#recording-player')).toBeVisible();
  await expect(page.locator('#continuous-identity')).toContainText(source.version);
  await expect(page.locator('#continuous-identity')).toContainText(source.runtime.fmuSha256);
  await page.locator('#recording-jump').selectOption({ index: 2 });
  expect(Number(await page.locator('#recording-time').inputValue())).toBeGreaterThan(0);
  await page.locator('#evidence-disclosure summary').click();
  await expect(page.locator('#continuous-checks li').first()).toBeVisible();
  expect(files).toContain('continuous-index.json');
  expect(files).toContain('continuous-recording.json');
  expect(files).not.toContain('continuous-verification.json');
});

test('a damaged current recording is rejected and the historical run remains selectable', async ({ page }) => {
  await page.route('**/continuous-recording.json', route => route.fulfill({
    contentType: 'application/json', body: '{}',
  }));
  await page.goto('continuous.html');
  await page.locator('#recording-load').click();
  await expect(page.locator('#recording-status')).toContainText('Could not open');
  await expect(page.locator('#recording-player')).toBeHidden();
  await page.locator('#recording-source').selectOption('archive');
  await page.locator('#recording-load').click();
  await expect(page.locator('#recording-player')).toBeVisible();
  await expect(page.locator('#continuous-identity')).toContainText('v0.11.0');
  await expect(page.locator('#recording-report')).toHaveAttribute('href', /v0\.11\.0\/continuous-verification\.json$/);
});
