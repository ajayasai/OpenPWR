// SPDX-License-Identifier: Apache-2.0
import {controls, outputs, validateState, validateHealth, validateEvidence, motion, operatingState, synchronization, formatReading} from './continuous-state.js';
const $ = id => document.getElementById(id);
const fmt = formatReading;
const clock = seconds => [Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60].map(n=>String(n).padStart(2,'0')).join(':');
let state=null, health=null, connected=false, running=false, busy=false, pendingAction=null, pendingControls={};
let history=[], scenarios=[], evidence=null, nextStep=0, lastFrame=performance.now(), rotor=0, turbineRotor=0;
const flowPhases={primary:0,steam:0,exhaust:0,feed:0,cooling:0,electrical:0};
let historyQueued=false;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const planned=()=>['ready','running'].includes(state?.experiment?.status);
const halted=()=>state && (state.halted || !state.outputs.valid);
const message=text=>{ $('continuous-notice').textContent=text; $('continuous-notice').hidden=!text; };
const controlLabel=(c,v)=>c.discrete ? (c.options||['Disabled','Enabled'])[v] : `${fmt(v*(c.scale||1),c.digits)} ${c.unit}`;
const controlGroups=new Map();
for(const name of [...new Set(controls.map(c=>c.group))]){
  const group=document.createElement('details');group.open=name!=='Thermal and inventory';
  const title=document.createElement('summary');title.textContent=name;group.append(title);
  const fields=document.createElement('div');fields.className='control-fields';group.append(fields);
  $('continuous-controls').append(group);controlGroups.set(name,fields);
}
for(const c of controls){
  const label=document.createElement('label');label.className='range-field';label.htmlFor=c.key;
  const line=document.createElement('span');line.textContent=c.label;
  const out=document.createElement('output');out.id=`${c.key}-value`;out.textContent='—';line.append(out);label.append(line);
  const input=document.createElement(c.discrete?'select':'input');input.id=c.key;input.disabled=true;
  if(c.discrete){for(const [v,t] of (c.options||['Disabled','Enabled']).entries()){const o=document.createElement('option');o.value=v;o.textContent=t;input.append(o);}}
  else{input.type='range';input.min=c.min;input.max=c.max;input.step=c.step;input.value=c.min;}
  input.addEventListener('input',()=>{out.textContent=controlLabel(c,Number(input.value));});
  input.addEventListener('change',()=>{pendingControls[c.key]=Number(input.value);});
  label.append(input);if(c.help){const hint=document.createElement('small');hint.textContent=c.help;label.append(hint);}controlGroups.get(c.group).append(label);
}
function availability(){
  const disabled=!connected || !state || halted() || Boolean(pendingAction);
  controls.forEach(c=>{$(c.key).disabled=disabled || planned();});
  for(const id of ['continuous-reset','continuous-csv','continuous-save','continuous-replay','continuous-prepare','continuous-scenario']) $(id).disabled=!connected || Boolean(pendingAction);
  $('continuous-manual').disabled=!connected || !state?.experiment || Boolean(pendingAction);
  $('continuous-run').disabled=disabled || state?.experiment?.status==='complete';
  $('continuous-speed').disabled=disabled;
  $('continuous-connect').disabled=busy;
  $('continuous-run').textContent=running?'Pause':'Run model';$('continuous-run').setAttribute('aria-pressed',String(running));
}
function connection(ok,detail){
  connected=ok;if(!ok)running=false;
  $('continuous-connection').classList.toggle('unavailable',!ok);
  $('connection-title').textContent=ok?'Connected to the continuous native plant':'Continuous native plant service unavailable';
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
    if(!r.headers.get('content-type')?.includes('application/json'))throw new Error('This address serves the static interface. Start the local continuous-start service.');
    return r.json();
  }catch(e){if(e.name==='AbortError')throw new Error('The service timed out. Reconnect to read the native state before continuing.');throw e;}
  finally{clearTimeout(timer);}
}
function accept(next,reset=false){
  validateState(next);
  if(reset || (state && next.time<state.time)){history=[];message('');}
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
  for(const el of document.querySelectorAll('[data-reading]'))el.textContent=fmt(state.outputs[el.dataset.reading]*Number(el.dataset.scale??1),Number(el.dataset.digits??1),el.dataset.format);
  for(const c of controls){if(!(c.key in pendingControls) && document.activeElement!==$(c.key)){$(c.key).value=state.controls[c.key];$(`${c.key}-value`).textContent=controlLabel(c,state.controls[c.key]);}}
  const phase=operatingState(state), sync=synchronization(state), o=state.outputs;
  $('continuous-clock').textContent=clock(state.time);$('continuous-stage').textContent=phase.label;
  $('continuous-stage').className=`status-pill ${phase.tone}`;
  for(const el of document.querySelectorAll('[data-stage]')){if(Number(el.dataset.stage)===phase.stage)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');}
  $('sync-status').textContent=sync.label;$('sync-status').className=`status-pill ${sync.tone}`;
  $('sync-permissive').textContent=sync.permitted;$('sync-explanation').textContent=sync.detail;
  $('last-close-time').textContent=o.breakerClosingTimeS>=0?clock(o.breakerClosingTimeS):'No closure recorded';
  $('closing-observations').hidden=o.breakerClosingTimeS<0;
  $('phase-reading').textContent=`${fmt(o.phaseDifferenceDeg,1)}°`;
  $('phase-needle').setAttribute('transform',`rotate(${o.phaseDifferenceDeg} 110 88)`);
  $('grid-status').textContent=o.gridConnected===1?'Native breaker closed':'Native breaker open';
  $('breaker-light').style.fill=o.gridConnected?'#bcd995':'#59717d';
  $('generator-body').classList.toggle('generator-live',o.gridConnected===1);
  $('core-glow').style.opacity=String(Math.max(0,Math.min(1,o.fissionPowerMW/3000)));
  for(const [id,value,bottom,height] of [['pzr-water',o.pressurizerLevelPercent,186,136],['secondary-water',o.secondaryLevelPercent,324,190]]){
    const h=Math.max(0,Math.min(100,value))/100*height;$(id).setAttribute('height',h);$(id).setAttribute('y',bottom-h);
  }
  const e=state.experiment;
  $('continuous-progress').textContent=e?`${e.label} · ${e.status} · ${clock(state.time)} / ${clock(e.duration)} · ${e.appliedEvents}/${e.eventCount} events${e.comparison?` · replay ${e.comparison.pass===true?'matched':'mismatch'}`:''}`:'Manual experiment · continuous native state';
  $('continuous-progress-bar').max=e?.duration||1;$('continuous-progress-bar').value=e?Math.min(state.time,e.duration):0;
  if(halted())message(state.haltReason||'Declared model domain reached. Reset the model to continue.');
  drawCharts();availability();
}
function draw(id,keys,unit,logarithmic=false){
  const svg=$(id), ns='http://www.w3.org/2000/svg', w=560,h=190, pad={l:49,r:12,t:15,b:32};
  svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  if(!history.length)return;
  const data=history.filter((_,i)=>i%Math.max(1,Math.ceil(history.length/650))===0 || i===history.length-1);
  const value=n=>logarithmic?(n>0?Math.log10(n):null):n;
  const values=data.flatMap(r=>keys.map(k=>value(r[k]))).filter(v=>v!==null);if(!values.length)return;
  let min=Math.min(...values),max=Math.max(...values);
  if(max-min<1){min-=.5;max+=.5;}const margin=(max-min)*.08;min-=margin;max+=margin;
  const t0=data[0].time,t1=Math.max(t0+1,data.at(-1).time),x=t=>pad.l+(t-t0)/(t1-t0)*(w-pad.l-pad.r),y=v=>h-pad.b-(v-min)/(max-min)*(h-pad.t-pad.b);
  const add=(tag,attrs,text)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;svg.append(e);return e;};
  for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;add('line',{x1:pad.l,x2:w-pad.r,y1:y(v),y2:y(v),stroke:'#29414d','stroke-width':.6});add('text',{x:pad.l-7,y:y(v)+3,'text-anchor':'end',fill:'#8ca7b7','font-size':10},logarithmic?`10^${fmt(v,1)}`:fmt(v,unit==='MPa'?1:0));}
  [0,.5,1].forEach(f=>add('text',{x:x(t0+(t1-t0)*f),y:h-10,'text-anchor':'middle',fill:'#8ca7b7','font-size':10},clock(t0+(t1-t0)*f)));
  keys.forEach((key,i)=>{let segment=false;const path=data.map(r=>{const v=value(r[key]);if(v===null){segment=false;return '';}const point=`${segment?'L':'M'}${x(r.time).toFixed(2)} ${y(v).toFixed(2)}`;segment=true;return point;}).join(' ');add('path',{d:path,fill:'none',stroke:i?'#83bdf4':logarithmic?'#93d9cb':'#e9b47a','stroke-width':2});});
}
function drawCharts(){
  draw('neutron-chart',['neutronPowerFraction'],'fraction',true);draw('power-chart',['reactorPowerMW','netPowerMW'],'MW');
  draw('temperature-chart',['hotLegTemperatureC','secondaryTemperatureC'],'C');draw('pressure-chart',['primaryPressureMPa','secondaryPressureMPa'],'MPa');
  $('continuous-samples').textContent=`${history.length} retained native observations · ${clock(history[0]?.time||0)}–${clock(history.at(-1)?.time||0)} simulated · zero neutron power is omitted from the logarithmic axis`;
}
async function loadEvidence(){
  try{
    const r=validateEvidence(await request('./continuous-verification.json'));
    evidence=r;showEvidence();
    $('continuous-checks').replaceChildren();for(const c of r.checks){const li=document.createElement('li');li.textContent=`${c.pass?'✓':'✕'} ${c.name}`;$('continuous-checks').append(li);}
  }catch{$('continuous-evidence').textContent='No current numerical report is available. Run npm run engineering:continuous:verify to generate it.';}
}
function showEvidence(){if(evidence)$('continuous-evidence').textContent=`${evidence.passed}/${evidence.total} native continuous-start checks passed${health?(health.fmuSha256===evidence.runtime.fmuSha256?' for this running FMU':' in the published report; this running FMU differs'):' in the published report'}. This is numerical verification, not measured plant validation.`;}
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
    if(catalog.profile!=='continuous'||!Array.isArray(catalog.scenarios))throw new Error('Invalid continuous-start scenario catalogue.');
    scenarios=catalog.scenarios;$('continuous-scenario').replaceChildren();for(const s of scenarios){const o=document.createElement('option');o.value=s.id;o.textContent=s.label;$('continuous-scenario').append(o);}describe();
    accept(current);await restoreHistory();
    $('continuous-timing').textContent=`Native FMI · ${health.stepSize} s communication steps`;
    $('continuous-identity').textContent=`${health.model} · ${health.compiler}\nFMU SHA-256: ${health.fmuSha256}`;
    connection(true,'Controls and observations are connected to the local FMU. Run advances simulated time.');message('');showEvidence();
  }catch(e){connection(false,`${e.message}${state?' Last confirmed observations are retained.':''}`);}
  finally{busy=false;availability();}
}
function describe(){$('scenario-description').textContent=scenarios.find(s=>s.id===$('continuous-scenario').value)?.description||'No experiment selected.';}
function queue(path,body,reset=false){running=false;pendingControls={};pendingAction={path,body,reset};availability();}
function save(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
async function work(){
  if(!connected||busy)return;let action;
  if(pendingAction){action=pendingAction;pendingAction=null;}
  else if(historyQueued){historyQueued=false;action={history:true};}
  else if(Object.keys(pendingControls).length){action={path:'/api/control',body:pendingControls};pendingControls={};}
  else if(running&&!halted()&&performance.now()>=nextStep){const speed=Number($('continuous-speed').value),seconds=Math.min(health.maxStepSeconds,Math.max(health.stepSize,Math.round(speed*.25/health.stepSize)*health.stepSize));action={path:'/api/step',body:{seconds},speed};}
  if(!action)return;busy=true;
  try{
    const began=performance.now();
    if(action.history){await restoreHistory();}
    else if(action.download){save(await request(action.path,undefined,true),action.download);}
    else {accept(await request(action.path,action.body),action.reset);if(action.path==='/api/step'){$('continuous-performance').textContent=`${fmt(performance.now()-began,0)} ms request / ${action.body.seconds} s simulated`;nextStep=began+action.body.seconds/action.speed*1000;if(state.experiment?.status==='complete' || halted())historyQueued=true;}}
  }catch(e){connection(false,e.message);message(e.message);pendingControls={};}
  finally{busy=false;availability();}
}
$('continuous-connect').addEventListener('click',connect);
$('continuous-run').addEventListener('click',()=>{running=!running;if(!running)historyQueued=true;nextStep=0;availability();});
$('continuous-reset').addEventListener('click',()=>queue('/api/reset',{},true));
$('continuous-prepare').addEventListener('click',()=>queue('/api/experiment',{scenario:$('continuous-scenario').value},true));
$('continuous-manual').addEventListener('click',()=>queue('/api/experiment/stop',{}));
$('continuous-scenario').addEventListener('change',describe);
$('continuous-csv').addEventListener('click',()=>{pendingAction={path:'/api/export',download:`openpwr-continuous-${Math.floor(state.time)}s.csv`};availability();});
$('continuous-save').addEventListener('click',()=>{pendingAction={path:'/api/commands',download:`openpwr-continuous-${Math.floor(state.time)}s.commands.json`};availability();});
$('continuous-replay').addEventListener('click',()=>$('continuous-file').click());
$('continuous-file').addEventListener('change',async()=>{const f=$('continuous-file').files[0];$('continuous-file').value='';if(!f)return;try{if(f.size>4*1024*1024)throw new Error('Command files must be at most 4 MiB.');queue('/api/replay',JSON.parse(await f.text()),true);}catch(e){message(e.message);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){running=false;availability();}});
function animate(now){
  const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;
  const rates=motion(state,running&&connected&&!document.hidden,reducedMotion.matches);
  rotor=(rotor+dt*rates.pump*150)%360;turbineRotor=(turbineRotor+dt*rates.turbine*190)%360;
  $('primary-rotor').setAttribute('transform',`rotate(${rotor} 291 365)`);$('turbine-rotor').setAttribute('transform',`rotate(${turbineRotor} 675 195)`);
  const observed=state?motion(state,true,false):{};
  for(const key of Object.keys(flowPhases)){
    const field=key==='exhaust'?'steam':key,rate=rates[field];flowPhases[key]=(flowPhases[key]+dt*rate*42)%28;
    const path=$(key==='electrical'?'electric-motion':`${key}-motion`);path.style.strokeDashoffset=String(-flowPhases[key]);
    // A paused cue stays visible, with motion frozen. No cue precedes a native observation.
    path.style.opacity=observed[field]>0?String(.25+.65*observed[field]):'0';
  }
  requestAnimationFrame(animate);
}
setInterval(work,100);requestAnimationFrame(animate);loadEvidence();connect();
