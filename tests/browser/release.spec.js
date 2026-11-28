// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { alignedObservations, observationsCsv } from '../../src/aligned-observations.js';

test('paired workbench restores the v0.14 feedwater law when reopening its recipe', async ({ page }) => {
  const fixture = new URL('../fixtures/v0.14.0-paired-recipe.json', import.meta.url);
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  await page.goto('experiments.html');
  await expect(page.locator('#feedwater-law')).toHaveText('Pressure-dependent (v3)');
  await expect(page.locator('#export-recipe')).toBeEnabled();
  await page.locator('#import-recipe').setInputFiles(fileURLToPath(fixture));
  await expect(page.locator('#feedwater-law')).toHaveText('Saturation curve (v2)');
  await expect(page.locator('[data-reading="alternative"]')).toHaveText('630.1 MWe');
  const pending = page.waitForEvent('download');
  await page.locator('#export-recipe').click();
  const downloaded = await pending;
  expect(JSON.parse(await readFile(await downloaded.path(), 'utf8'))).toEqual(original);
});

test('open-loop startup shows discrete station readings and the uninterrupted native trajectory', async ({ page, request }) => {
  const response = await request.get('open-loop-startup.json');
  expect(response.ok()).toBe(true);
  const data = await response.json();
  const format = new Intl.NumberFormat('en', {maximumFractionDigits: 3});
  await page.goto('startup-evidence.html#open-loop');
  await expect(page.locator('#ol-results')).toBeVisible();
  for (const key of ['ohi', 'westinghouse']) {
    const event = data[key];
    await page.locator('#ol-event').selectOption(key);
    for (const [channel, unit] of [['primaryPressureMPa', 'MPa abs'], ['averageCoolantTemperatureC', '°C']]) {
      await page.locator('#ol-channel').selectOption(channel);
      await expect(page.locator('#ol-chart .observed-point')).toHaveCount(event.rows.length);
      await expect(page.locator('#ol-chart path')).toHaveCount(1);
      await expect(page.locator('#ol-score')).toContainText(format.format(event.scores[channel].native.rmse) + ' ' + unit);
      const last = event.rows.at(-1);
      await page.locator('#ol-jump').selectOption(String(last.elapsedHours * 3600));
      await expect(page.locator('#ol-native-value')).toHaveText(format.format(last.native[channel]) + ' ' + unit);
      await expect(page.locator('#ol-station-value')).toHaveText(format.format(last.station[channel]) + ' ' + unit);
      await page.locator('#ol-time').press('ArrowLeft');
      await expect(page.locator('#ol-station-value')).toHaveText('No reading at this time');
    }
  }
  await expect(page.locator('#ol-channel option[value=power]')).toBeDisabled();
  await page.locator('#ol-event').selectOption('ohi');
  await page.locator('#ol-channel').selectOption('power');
  const available = data.ohi.rows.filter(row => row.stationGrossLoadFraction != null);
  await expect(page.locator('#ol-chart .observed-point')).toHaveCount(available.length);
  await page.locator('#ol-jump').selectOption(String(available.at(-1).elapsedHours * 3600));
  await expect(page.locator('#ol-station-value')).toHaveText(format.format(available.at(-1).stationGrossLoadFraction * 100) + ' % rated');
  await page.locator('#ol-window').selectOption('native');
  await page.locator('#ol-time').press('End');
  await expect(page.locator('#ol-elapsed')).toHaveText('500 h');
  await expect(page.locator('#ol-grid')).toHaveText('Rated power');
  await expect(page.locator('#ol-station-value')).toHaveText('No reading at this time');
  await page.locator('#ol-play').click();
  await expect(page.locator('#ol-play')).toHaveText('Pause');
  await expect(page.locator('#ol-time')).not.toHaveValue('0');
  await page.locator('#ol-play').click();
  await expect(page.locator('#ol-play')).toHaveText('Play');
  expect(await page.locator('#open-loop').evaluate(card => card.scrollWidth <= card.clientWidth + 1)).toBe(true);
});

test('startup forecasts show event-specific errors and forecast origins at each horizon', async ({ page, request }) => {
  const response = await request.get('startup-transfer.json');
  expect(response.ok()).toBe(true);
  const report = await response.json();
  expect(report.schema).toBe('openpwr-startup-transfer-v1');
  const format = new Intl.NumberFormat('en', { maximumFractionDigits: 3 });
  await page.goto('startup-evidence.html#startup-transfer');
  await expect(page.locator('#transfer-results')).toBeVisible();
  const primary = report.events.flatMap(e => e.groups.filter(g => g.primary).flatMap(g => g.channels));
  const wins = primary.filter(c => c.improved).length;
  await expect(page.locator('#transfer-status')).toContainText(wins + ' of ' + primary.length);
  await expect(page.locator('#transfer-primary tr')).toHaveCount(primary.length);
  await expect(page.locator('#transfer-scope')).toContainText(report.scope);
  await expect(page.locator('#startup-transfer [download]')).toHaveAttribute('href', './startup-transfer.json');
  await page.locator('#startup-transfer details summary').click();
  for (const event of report.events) {
    await page.locator('#transfer-event').selectOption(event.id);
    await expect(page.locator('#transfer-source')).toHaveAttribute('href', event.sourceUrl);
    for (const group of event.groups) {
      await page.locator('#transfer-group').selectOption(group.id);
      for (const ch of group.channels) {
        await page.locator('#transfer-channel').selectOption(ch.id);
        await expect(page.locator('#transfer-score')).toContainText(format.format(ch.candidate.rmse) + ' ' + ch.unit);
        await expect(page.locator('#transfer-score')).toContainText(format.format(ch.persistence.rmse) + ' ' + ch.unit);
        await expect(page.locator('#transfer-chart .forecast-mark')).toHaveCount(ch.n);
        const rows = page.locator('#transfer-points tr');
        await expect(rows).toHaveCount(ch.n);
        const point = ch.points[ch.n - 1];
        for (const [i, value] of [point.observed, point.forecast, point.persistence].entries()) {
          await expect(rows.last().locator('td').nth(i + 1)).toHaveText(format.format(value));
        }
      }
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

function recordPageTraffic(page) {
  const files = [];
  page.on('request', request => files.push(new URL(request.url()).pathname.split('/').at(-1)));
  return files;
}

test('Shippingport development shows withheld residuals and compares models on identical readings', async ({ page, request }) => {
  const response = await request.get('shippingport-development.json');
  expect(response.ok()).toBe(true);
  const report = await response.json();
  expect(report.schema).toBe('openpwr-shippingport-development-v1');
  const format = n => new Intl.NumberFormat('en', {maximumFractionDigits: 3}).format(n);
  await page.goto('startup-evidence.html#shippingport-development');
  await expect(page.locator('#development-results')).toBeVisible();
  if (report.channels.every(c => c.scores.withheld.persistence.rmse < c.scores.withheld.candidate.rmse)) {
    await expect(page.locator('#development-status')).toContainText('last available reading gave lower RMSE for both quantities');
  }
  await expect(page.locator('#development-plot .test-interval')).toHaveCount(report.withheldBlocks.length);
  await page.locator('#shippingport-development details summary').click();
  for (const channel of report.channels) {
    await page.locator('#development-channel').selectOption(channel.key);
    await page.locator('#development-group').selectOption('common');
    await page.locator('#development-view').selectOption('response');
    const held = channel.points.filter(p => p.split === 'withheldEarly' || p.split === 'withheldLate');
    await expect(page.locator('#development-plot .test-reading')).toHaveCount(held.length);
    await expect(page.locator('#development-rows tr')).toHaveCount(channel.points.length);
    const common = channel.scores.withheld.commonGeneric;
    for (const [i, key] of ['candidate', 'generic', 'persistence'].entries()) {
      const row = page.locator('#development-scores tr').nth(i);
      await expect(row.locator('td').first()).toHaveText(String(common[key].n));
      await expect(row.locator('td').last()).toHaveText(format(common[key].rmse));
    }
    await page.locator('#development-view').selectOption('residual');
    await expect(page.locator('#development-plot .historical-error')).toHaveCount(held.length);
    await expect(page.locator('#development-plot .generic-error')).toHaveCount(common.generic.n);
    await page.locator('#development-original').uncheck();
    await expect(page.locator('#development-plot .generic-error')).toHaveCount(0);
    await expect(page.locator('#development-plot .historical-error')).toHaveCount(held.length);
    await page.locator('#development-original').check();
    await page.locator('#development-group').selectOption('withheldLate');
    const late = channel.scores.withheldLate.candidate;
    await expect(page.locator('#development-scores tr')).toHaveCount(2);
    await expect(page.locator('#development-scores tr').first().locator('td').last()).toHaveText(format(late.rmse));
  }
});

test('Shippingport shows the full event, unpaired observations and an open station breaker', async ({ page, request }) => {
  const canonical = await request.get('shippingport-startup.json');
  expect(canonical.ok()).toBe(true);
  const report = await canonical.json();
  expect(report.milestone.breakerObserved).toBe(false);
  await page.goto('startup-evidence.html#shippingport');
  await expect(page.locator('#shippingport-status')).toContainText('inconclusive');
  await expect(page.locator('#shippingport-milestone')).toContainText('station breaker remained open');
  await expect(page.locator('#shippingport-source')).toHaveAttribute('href', report.source.url);
  await expect(page.locator('#shippingport-window')).toHaveValue('event');
  await page.locator('#shippingport details summary').click();
  let laterReadings = 0;
  for (const channel of report.channels) {
    await page.locator('#shippingport-channel').selectOption(channel.key);
    await expect(page.locator('#shippingport-table-caption')).toContainText(channel.unit);
    const rows = page.locator('#shippingport-rows tr');
    await expect(rows).toHaveCount(channel.points.length);
    const index = channel.points.findIndex(p => p.elapsedS > report.prediction.durationSeconds && !p.excluded);
    if (index >= 0) {
      expect(channel.points[index].predicted).toBeNull();
      await expect(rows.nth(index)).toContainText('Outside model coverage');
      laterReadings++;
    }
  }
  expect(laterReadings).toBeGreaterThan(0);
  await expect(page.locator('#shippingport-plot .uncovered')).toHaveCount(1);
  await page.locator('#shippingport-window').selectOption('native');
  await expect(page.locator('#shippingport-plot .uncovered')).toHaveCount(0);
  await expect(page.locator('#plant-channel')).toBeEnabled();
});

test('live feedwater reading, CSV and NIST comparison agree at rated load', async ({ page, request }) => {
  const { feedwaterComparison } = await (await request.get('benchmarks.json')).json();
  const rated = feedwaterComparison.rows.find(row => row.temperatureC === 220 && row.pressureMPa === 6);
  await page.goto('./');
  await page.locator('#play-pause').click();
  await page.locator('#feedwater-properties summary').click();
  await expect(page.locator('#feed-pressure')).toHaveText('6.0000 MPa');
  await expect(page.locator('#feed-enthalpy')).toHaveText(rated.current.toFixed(3) + ' kJ/kg');
  const downloading = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const download = await downloading;
  const csv = await readFile(await download.path(), 'utf8');
  const lines = csv.trimEnd().split('\n');
  const column = lines[0].split(',').indexOf('feedwaterEnthalpyKJkg_kJ_per_kg');
  expect(column).toBeGreaterThan(-1);
  expect(Number(lines.at(-1).split(',')[column])).toBeCloseTo(rated.current, 6);
  await page.goto('verification.html#feedwater-reference');
  await expect(page.locator('#feedwater-point option')).toHaveCount(feedwaterComparison.rows.length);
  await expect(page.locator('#water-reference')).toHaveText(rated.reference + ' kJ/kg');
  await page.locator('#feedwater-point').selectOption('0');
  await expect(page.locator('#water-reference')).toHaveText(feedwaterComparison.rows[0].reference + ' kJ/kg');
});

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
