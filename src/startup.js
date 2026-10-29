// SPDX-License-Identifier: Apache-2.0
import {controls, outputs, validateState, validateHealth, motion, milestone, validHash} from './cold-state.js';
const $ = id => document.getElementById(id);
const fmt = (n,d=1) => Number.isFinite(n) ? (Math.abs(n)<.5*10**-d?0:n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const clock = seconds => [Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60].map(n=>String(n).padStart(2,'0')).join(':');
let state=null, health=null, connected=false, running=false, busy=false, pendingAction=null, pendingControls={};
let history=[], scenarios=[], evidence=null, nextStep=0, lastFrame=performance.now(), rotor=0, phase=0;
let historyQueued=false;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const planned=()=>['ready','running'].includes(state?.experiment?.status);
const halted=()=>state && (state.halted || !state.outputs.valid);
const message=text=>{ $('cold-notice').textContent=text; $('cold-notice').hidden=!text; };
const controlLabel=(c,v)=>c.discrete ? (v===1?'Enabled':'Disabled') : `${fmt(v*(c.scale||1),c.digits)} ${c.unit}`;
for(const c of controls){
  const label=document.createElement('label');label.className='range-field';label.htmlFor=c.key;
  const line=document.createElement('span');line.textContent=c.label;
  const out=document.createElement('output');out.id=`${c.key}-value`;out.textContent='—';line.append(out);label.append(line);
  const input=document.createElement(c.discrete?'select':'input');input.id=c.key;input.disabled=true;
  if(c.discrete){for(const [v,t] of [[0,'Disabled'],[1,'Enabled']]){const o=document.createElement('option');o.value=v;o.textContent=t;input.append(o);}}
  else{input.type='range';input.min=c.min;input.max=c.max;input.step=c.step;input.value=c.min;}
  input.addEventListener('input',()=>{out.textContent=controlLabel(c,Number(input.value));});
  input.addEventListener('change',()=>{pendingControls[c.key]=Number(input.value);});
  label.append(input);$('cold-controls').append(label);
}
function availability(){
  const disabled=!connected || !state || halted() || Boolean(pendingAction);
  controls.forEach(c=>{$(c.key).disabled=disabled || planned();});
  for(const id of ['cold-reset','cold-csv','cold-save','cold-replay','cold-prepare','cold-scenario']) $(id).disabled=!connected || Boolean(pendingAction);
  $('cold-manual').disabled=!connected || !state?.experiment || Boolean(pendingAction);
  $('cold-run').disabled=disabled || state?.experiment?.status==='complete';
  $('cold-speed').disabled=disabled;
  $('cold-connect').disabled=busy;
  $('cold-run').textContent=running?'Pause':'Run model';$('cold-run').setAttribute('aria-pressed',String(running));
}
function connection(ok,detail){
  connected=ok;if(!ok)running=false;
  $('cold-connection').classList.toggle('unavailable',!ok);
  $('connection-title').textContent=ok?'Connected to local native cold-start model':'Native cold-start service unavailable';
  $('connection-message').textContent=detail;
  $('local-instructions').hidden=ok;
  availability();
}
async function request(path,body,download=false){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(!r.ok){let m=r.status===404&&path.startsWith('/api/')?'Start the local native service to connect this workbench.':`Local service returned HTTP ${r.status}.`;try{m=(await r.json()).message||m;}catch{}throw new Error(m);}
    if(download)return r.blob();
    if(!r.headers.get('content-type')?.includes('application/json'))throw new Error('This address serves the static interface. Start the local cold-start service.');
    return r.json();
  }catch(e){if(e.name==='AbortError')throw new Error('The service timed out. Reconnect to read the native state before continuing.');throw e;}
  finally{clearTimeout(timer);}
}
function accept(next,reset=false){
  validateState(next);
  if(reset || (state && next.time<state.time)){history=[];}
  state=next;
  if(halted() || state.experiment?.status==='complete')running=false;
  const row={time:state.time,...state.outputs};
  if(history.at(-1)?.time===state.time)history[history.length-1]=row;else history.push(row);
  // Preserve the whole heatup span while bounding browser memory.
  if(history.length>6000)history=history.filter((_,i)=>i%2===0 || i===history.length-1);
  render();
}
function render(){
  if(!state){availability();return;}
  for(const el of document.querySelectorAll('[data-reading]'))el.textContent=fmt(state.outputs[el.dataset.reading],Number(el.dataset.digits??1));
  for(const c of controls){if(!(c.key in pendingControls) && document.activeElement!==$(c.key)){$(c.key).value=state.controls[c.key];$(`${c.key}-value`).textContent=controlLabel(c,state.controls[c.key]);}}
  $('cold-clock').textContent=clock(state.time);$('cold-stage').textContent=milestone(state);
  for(const [id,value,bottom,height] of [['pzr-water',state.outputs.pressurizerLevelPercent,231,166],['secondary-water',state.outputs.secondaryLevelPercent,325,215]]){
    const h=Math.max(0,Math.min(100,value))/100*height;$(id).setAttribute('height',h);$(id).setAttribute('y',bottom-h);
  }
  const e=state.experiment;
  $('cold-progress').textContent=e?`${e.label} · ${e.status} · ${clock(state.time)} / ${clock(e.duration)} · ${e.appliedEvents}/${e.eventCount} events${e.comparison?` · replay ${e.comparison.pass===true?'matched':'comparison available in report'}`:''}`:'Manual experiment · continuous native state';
  $('cold-progress-bar').max=e?.duration||1;$('cold-progress-bar').value=e?Math.min(state.time,e.duration):0;
  if(halted())message(state.haltReason||'Declared model domain reached. Reset the model to continue.');
  drawCharts();availability();
}
function draw(id,keys,unit){
  const svg=$(id), ns='http://www.w3.org/2000/svg', w=560,h=190, pad={l:49,r:12,t:15,b:32};
  svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  if(!history.length)return;
  const data=history.filter((_,i)=>i%Math.max(1,Math.ceil(history.length/650))===0 || i===history.length-1);
  const values=data.flatMap(r=>keys.map(k=>r[k]));let min=Math.min(...values),max=Math.max(...values);
  if(max-min<1){min-=.5;max+=.5;}const margin=(max-min)*.08;min-=margin;max+=margin;
  const t0=data[0].time,t1=Math.max(t0+1,data.at(-1).time),x=t=>pad.l+(t-t0)/(t1-t0)*(w-pad.l-pad.r),y=v=>h-pad.b-(v-min)/(max-min)*(h-pad.t-pad.b);
  const add=(tag,attrs,text)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;svg.append(e);return e;};
  for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;add('line',{x1:pad.l,x2:w-pad.r,y1:y(v),y2:y(v),stroke:'#29414d','stroke-width':.6});add('text',{x:pad.l-7,y:y(v)+3,'text-anchor':'end',fill:'#8ca7b7','font-size':10},fmt(v,unit==='MPa'?1:0));}
  [0,.5,1].forEach(f=>add('text',{x:x(t0+(t1-t0)*f),y:h-10,'text-anchor':'middle',fill:'#8ca7b7','font-size':10},clock(t0+(t1-t0)*f)));
  keys.forEach((key,i)=>add('path',{d:data.map((r,j)=>`${j?'L':'M'}${x(r.time).toFixed(2)} ${y(r[key]).toFixed(2)}`).join(' '),fill:'none',stroke:i?'#83bdf4':'#e9b47a','stroke-width':2}));
}
function drawCharts(){draw('cold-temperature-chart',['hotLegTemperatureC','secondaryTemperatureC'],'C');draw('cold-pressure-chart',['primaryPressureMPa','secondaryPressureMPa'],'MPa');$('cold-samples').textContent=`${history.length} retained native observations · ${clock(history[0]?.time||0)}–${clock(history.at(-1)?.time||0)} simulated`;}
async function loadEvidence(){
  try{
    const r=await request('./cold-verification.json');
    if(!Array.isArray(r.checks)||!r.checks.length||r.total!==r.checks.length||r.passed!==r.checks.filter(c=>c.pass===true).length||!validHash(r.runtime?.fmuSha256))throw new Error('Incomplete report');
    evidence=r;showEvidence();
    $('cold-checks').replaceChildren();for(const c of r.checks){const li=document.createElement('li');li.textContent=`${c.pass?'✓':'✕'} ${c.name}`;$('cold-checks').append(li);}
  }catch{$('cold-evidence').textContent='No current numerical report is available. Run npm run engineering:cold:verify to generate it.';}
}
function showEvidence(){if(evidence)$('cold-evidence').textContent=`${evidence.passed}/${evidence.total} native cold-start checks passed${health?(health.fmuSha256===evidence.runtime.fmuSha256?' for this running FMU':' in the published report; this running FMU differs'):' in the published report'}. This is numerical verification, not measured plant validation.`;}
async function restoreHistory(){
  const saved=await request('/api/history?maxPoints=1500');
  if(saved.fmuSha256!==health.fmuSha256 || !Array.isArray(saved.points) || saved.points.some(p=>!Number.isFinite(p.time)||outputs.some(k=>!Number.isFinite(p.outputs?.[k]))))throw new Error('Native history identity or observations are invalid.');
  history=saved.points.map(p=>({time:p.time,...p.outputs}));
  accept(saved.current);
}
async function connect(){
  if(busy)return;busy=true;running=false;pendingControls={};availability();
  try{
    health=validateHealth(await request('/api/health'));
    const current=validateState(await request('/api/state'));
    const catalog=await request('/api/scenarios');
    if(catalog.profile!=='cold'||!Array.isArray(catalog.scenarios))throw new Error('Invalid cold-start scenario catalogue.');
    scenarios=catalog.scenarios;$('cold-scenario').replaceChildren();for(const s of scenarios){const o=document.createElement('option');o.value=s.id;o.textContent=s.label;$('cold-scenario').append(o);}describe();
    accept(current);await restoreHistory();
    $('cold-timing').textContent=`Native FMI · ${health.stepSize} s communication steps`;
    $('cold-identity').textContent=`${health.model} · ${health.compiler}\nFMU SHA-256: ${health.fmuSha256}`;
    connection(true,'Controls and observations are connected to the local FMU. Run advances simulated time.');message('');showEvidence();
  }catch(e){connection(false,`${e.message}${state?' Last confirmed observations are retained.':''}`);}
  finally{busy=false;availability();}
}
function describe(){$('scenario-description').textContent=scenarios.find(s=>s.id===$('cold-scenario').value)?.description||'No experiment selected.';}
function queue(path,body,reset=false){running=false;pendingControls={};pendingAction={path,body,reset};availability();}
function save(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
async function work(){
  if(!connected||busy)return;let action;
  if(pendingAction){action=pendingAction;pendingAction=null;}
  else if(historyQueued){historyQueued=false;action={history:true};}
  else if(Object.keys(pendingControls).length){action={path:'/api/control',body:pendingControls};pendingControls={};}
  else if(running&&!halted()&&performance.now()>=nextStep){const speed=Number($('cold-speed').value),seconds=Math.min(health.maxStepSeconds,Math.max(health.stepSize,Math.round(speed*.25/health.stepSize)*health.stepSize));action={path:'/api/step',body:{seconds},speed};}
  if(!action)return;busy=true;
  try{
    const began=performance.now();
    if(action.history){await restoreHistory();}
    else if(action.download){save(await request(action.path,undefined,true),action.download);}
    else {accept(await request(action.path,action.body),action.reset);if(action.path==='/api/step'){$('cold-performance').textContent=`${fmt(performance.now()-began,0)} ms request / ${action.body.seconds} s simulated`;nextStep=began+action.body.seconds/action.speed*1000;if(state.experiment?.status==='complete' || halted())historyQueued=true;}}
  }catch(e){connection(false,e.message);message(e.message);pendingControls={};}
  finally{busy=false;availability();}
}
$('cold-connect').addEventListener('click',connect);
$('cold-run').addEventListener('click',()=>{running=!running;if(!running)historyQueued=true;nextStep=0;availability();});
$('cold-reset').addEventListener('click',()=>queue('/api/reset',{},true));
$('cold-prepare').addEventListener('click',()=>queue('/api/experiment',{scenario:$('cold-scenario').value},true));
$('cold-manual').addEventListener('click',()=>queue('/api/experiment/stop',{}));
$('cold-scenario').addEventListener('change',describe);
$('cold-csv').addEventListener('click',()=>{pendingAction={path:'/api/export',download:`openpwr-cold-${Math.floor(state.time)}s.csv`};availability();});
$('cold-save').addEventListener('click',()=>{pendingAction={path:'/api/commands',download:`openpwr-cold-${Math.floor(state.time)}s.commands.json`};availability();});
$('cold-replay').addEventListener('click',()=>$('cold-file').click());
$('cold-file').addEventListener('change',async()=>{const f=$('cold-file').files[0];$('cold-file').value='';if(!f)return;try{if(f.size>4*1024*1024)throw new Error('Command files must be at most 4 MiB.');queue('/api/replay',JSON.parse(await f.text()),true);}catch(e){message(e.message);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){running=false;availability();}});
function animate(now){const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;const rate=motion(state,running&&connected&&!document.hidden,reducedMotion.matches);rotor=(rotor+dt*rate*150)%360;phase=(phase+dt*rate*35)%29;$('cold-rotor').setAttribute('transform',`rotate(${rotor} 615 365)`);$('primary-motion').style.strokeDashoffset=String(-phase);requestAnimationFrame(animate);}
setInterval(work,100);requestAnimationFrame(animate);loadEvidence();connect();
