// SPDX-License-Identifier: Apache-2.0
const status = document.querySelector('#status');
try {
  const response = await fetch('./verification.json');
  if (!response.ok) throw new Error('Verification report is unavailable. Run npm run verify and npm run build.');
  const report = await response.json();
  status.textContent = `${report.passed}/${report.checks.length} checks passed · OpenPWR ${report.version} · ${report.gitRevision ? 'Commit ' + report.gitRevision.slice(0, 12) : 'Uncommitted build'}${report.workingTreeDirty ? ' (local changes)' : ''} · Generated ${report.generatedAt} · ${report.runtime}`;
  status.className = report.passed === report.checks.length ? 'pass' : 'fail';
  for (const check of report.checks) {
    const row = document.createElement('tr');
    for (const [i, text] of [check.name, check.pass ? 'PASS' : 'FAIL', check.evidence].entries()) {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (i === 1) cell.className = check.pass ? 'pass' : 'fail';
      row.append(cell);
    }
    document.querySelector('#checks').append(row);
  }
} catch(error) { status.textContent = error.message; status.className = 'fail'; }
