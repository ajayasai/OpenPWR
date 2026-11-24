// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeRecording, sampleIndex, validateStartupIndex} from '../src/continuous-replay.js';
import {makeStartupViews} from '../scripts/startup-recording.mjs';
import {motion, operatingState} from '../src/continuous-state.js';

const bytes=await readFile(new URL('../validation/startup_output/replay.json',import.meta.url));
const model=JSON.parse(await readFile(new URL('../validation/startup_output/model.json',import.meta.url)));

test('the recorded workbench and published electrical comparison agree at all retained times',async()=>{
  const replay=await decodeRecording(bytes);
  assert.deepEqual(replay.source,model.source);
  assert.deepEqual(replay.points.map(({time,netPowerMW,grossPowerMW})=>({elapsedSeconds:time,netPowerMW,grossPowerMW})),model.points);
  const stateAt=t=>({outputs:{...replay.points[sampleIndex(replay,t)],valid:true}});
  assert.equal(stateAt(20000).outputs.gridConnected,0); // Last observation at 19,980 s.
  assert.equal(stateAt(20010).outputs.gridConnected,1);
  assert.equal(operatingState(stateAt(0)).stage,0);
  assert.equal(operatingState(stateAt(27000)).stage,4);
  assert.equal(sampleIndex(replay,1e6),900);
  for(const rate of Object.values(motion(stateAt(27000),true,true)))assert.equal(rate,0);
});

test('a changed sample in the pinned recording cannot be displayed',async()=>{
  const corrupt=Buffer.from(bytes);
  corrupt[corrupt.length-10]^=1;
  await assert.rejects(decodeRecording(corrupt),/differs from the published/);
});

function currentReport() {
  const {columns, rows, sampleIntervalSeconds, durationSeconds, source} = JSON.parse(bytes);
  const trace = rows.map(row => Object.fromEntries(columns.map((key, i) => [key, row[i]])));
  const version = '0.14.0', gitRevision = 'c'.repeat(40);
  const runtime = {model:'ContinuousPlant', fmuSha256:source.fmuSha256};
  return {schemaVersion:1, version, gitRevision, gitDirty:false, runtime, buildManifest:{version, gitRevision, ...runtime},
    physicalValidationPassed:false, passed:1, total:1, checks:[{name:'Fixture check', pass:true, evidence:'Full evidence'}],
    scenarios:[{id:'full-startup', complete:true, singleFmuInstance:true, resetCount:0, runtime,
      durationSeconds, sampleIntervalSeconds, trace}]};
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('the release recording preserves all retained channels, time points, source identity and check names',async()=>{
  const full = currentReport(), original = Buffer.from(JSON.stringify(full, null, 2));
  const views = makeStartupViews(original);
  const index = validateStartupIndex(JSON.parse(views.index));
  assert.equal(index.source.reportSha256, digest(original));
  assert.equal(index.source.reportBytes, original.length);
  assert.equal(index.source.release, 'v'+full.version);
  assert.equal(index.source.gitRevision, full.gitRevision);
  assert.equal(index.source.fmuSha256, full.runtime.fmuSha256);
  assert.deepEqual(index.checks,[{name:'Fixture check',pass:true}]);
  const recording = await decodeRecording(Buffer.from(views.recording),index);
  assert.deepEqual(recording.points,full.scenarios[0].trace);
  assert.equal(recording.sampleIntervalSeconds,30);
  assert.equal(recording.durationSeconds,27000);
  assert.deepEqual(recording.source,index.source);
  assert.equal(index.recording.bytes,Buffer.byteLength(views.recording));
  assert.equal(index.recording.sha256,digest(views.recording));
  assert.deepEqual(makeStartupViews(original),views);
});

test('mixed source reports and recordings fail identity checks even with matching recording checksums',async()=>{
  const full=currentReport();
  const {index:text, recording}=makeStartupViews(Buffer.from(JSON.stringify(full)));
  const index=JSON.parse(text), raw=Buffer.from(recording);
  for(const change of [
    adjusted=>{adjusted.source.gitRevision='b'.repeat(40);},
    adjusted=>{adjusted.source.reportSha256='b'.repeat(64);},
    adjusted=>{adjusted.source.fmuSha256=adjusted.runtime.fmuSha256='b'.repeat(64);},
    adjusted=>{adjusted.recording.sampleIntervalSeconds=60;},
    adjusted=>{adjusted.recording.bytes++;},
    adjusted=>{adjusted.recording.sha256='b'.repeat(64);},
  ]) {
    const adjusted=structuredClone(index); change(adjusted);
    await assert.rejects(decodeRecording(raw,adjusted),/different native runs|differs from the verified/);
  }
  const damaged=Buffer.from(raw);damaged[damaged.length-11]^=1;
  await assert.rejects(decodeRecording(damaged,index),/differs from the verified/);
  const invalid=JSON.parse(recording);
  invalid.rows.pop();
  const short=Buffer.from(JSON.stringify(invalid));
  await assert.rejects(decodeRecording(short,{...index,recording:{...index.recording,bytes:short.length,sha256:digest(short)}}),/incompatible/);
});

test('producing release views requires a single identified run and every retained native reading',()=>{
  const report=currentReport();
  const run=report.scenarios[0];
  const verify = () => makeStartupViews(Buffer.from(JSON.stringify(report)));
  report.scenarios.push(run);
  assert.throws(verify,/one complete native run/);
  report.scenarios.pop();
  run.runtime = {...run.runtime, fmuSha256:'d'.repeat(64)};
  assert.throws(verify,/matching report and executable/);
  run.runtime = report.runtime;
  delete run.trace[400].phaseDifferenceDeg;
  assert.throws(verify,/Incomplete native observation at sample 400/);
});
