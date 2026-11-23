// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeRecording, sampleIndex} from '../src/continuous-replay.js';
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
