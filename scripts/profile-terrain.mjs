import { Session } from 'node:inspector';
import { writeFile, mkdir } from 'node:fs/promises';
import { prepareTerrain } from '../src/navigation.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
const tuning={...DEFAULT_TUNING,count:500,columns:23},p=prepareTerrain(tuning,189423),sim=new BattleSimulation(500,74319,2048,tuning,p.terrain,p.navigation);
sim.hp.fill(1e8,0,1000);for(let i=0;i<600;i++)sim.step();
const session=new Session();session.connect();const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(e,r)=>e?reject(e):resolve(r)));
await post('Profiler.enable');await post('Profiler.start');
const start=performance.now();for(let i=0;i<600;i++)sim.step();
const{profile}=await post('Profiler.stop');session.disconnect();
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/terrain.cpuprofile',JSON.stringify(profile));
const hits=new Map();for(const n of profile.nodes){const key=n.callFrame.functionName||'(anonymous)';hits.set(key,(hits.get(key)||0)+(n.hitCount||0));}
console.log(JSON.stringify({msPerStep:(performance.now()-start)/600,functions:[...hits].sort((a,b)=>b[1]-a[1]).slice(0,25)},null,2));
