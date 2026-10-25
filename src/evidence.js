// SPDX-License-Identifier: Apache-2.0
const $ = (id) => document.getElementById(id);
function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function number(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  return Math.abs(value) >= 1e5 || Math.abs(value) < .0001 ? value.toExponential(5) : Number(value.toPrecision(7)).toString();
}
function reportStatus(id, report) {
  const checks = report.checks;
  if (!Array.isArray(checks) || !checks.length) throw new Error('The report contains no check results.');
  const passed = checks.filter(check => check.pass === true).length;
  const status = $(id);
  status.replaceChildren();
  status.append(element('strong', `${passed}/${checks.length} checks passed`, passed === checks.length ? 'pass' : 'fail'));
  const metadata = [
    report.version ? `OpenPWR ${report.version}` : '',
    report.gitRevision ? `Commit ${report.gitRevision.slice(0, 12)}` : 'Uncommitted build',
    report.workingTreeDirty ? 'Local changes' : '',
    report.generatedAt ? `Generated ${report.generatedAt}` : '',
    report.runtime || '',
  ].filter(Boolean).join(' · ');
  status.append(element('span', metadata, 'report-metadata'));
}
async function loadReport(url, statusId, render) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Report unavailable. Generate the reports and rebuild the site.');
    const report = await response.json();
    reportStatus(statusId, report);
    render(report);
  } catch (error) {
    $(statusId).textContent = error.message;
    $(statusId).classList.add('fail');
  }
}
function sourceLink(source) {
  if (!source || typeof source !== 'object') return null;
  try {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const link = element('a', source.title || 'Published source', 'benchmark-source');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  } catch { return null; }
}

await Promise.all([
  loadReport('./benchmarks.json', 'benchmark-status', (report) => {
    $('benchmark-scope').textContent = report.scope || '';
    for (const check of report.checks) {
      const row = document.createElement('tr');
      const description = document.createElement('td');
      description.append(element('strong', check.name));
      if (check.conditions) description.append(element('span', check.conditions, 'case-conditions'));
      const source = sourceLink(check.source);
      if (source) description.append(source);
      if (check.source?.table) description.append(element('span', check.source.table, 'source-location'));
      const reference = element('td', number(check.reference), 'numeric-cell');
      const measured = element('td', number(check.measured), 'numeric-cell');
      if (check.units) {
        reference.append(element('small', check.units, 'value-unit'));
        measured.append(element('small', check.units, 'value-unit'));
      }
      const error = document.createElement('td'); error.className = 'numeric-cell';
      error.append(element('span', number(check.error)));
      error.append(element('small', `Limit ${number(check.tolerance)} ${check.units || ''}`, 'value-unit'));
      const result = element('td', check.pass ? 'PASS' : 'FAIL', check.pass ? 'pass' : 'fail');
      row.append(description, reference, measured, error, result);
      $('benchmark-checks').append(row);
    }
  }),
  loadReport('./verification.json', 'status', (report) => {
    for (const check of report.checks) {
      const row = document.createElement('tr');
      row.append(element('td', check.name), element('td', check.pass ? 'PASS' : 'FAIL', check.pass ? 'pass' : 'fail'), element('td', check.evidence));
      $('checks').append(row);
    }
  }),
]);
