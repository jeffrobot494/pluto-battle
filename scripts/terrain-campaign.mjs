import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareTerrain } from '../src/navigation.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
const battles=[];
for(const seed of[1,189423,74319]) {
  const tuning={...DEFAULT_TUNING,count:500,columns:23},p=prepareTerrain(tuning,seed),sim=new BattleSimulation(500,74319,2048,tuning,p.terrain,p.navigation);
  for(let tick=0;tick<15000&&sim.result==='running';tick++) {
    sim.step();
    if(tick%120===0)for(let i=0;i<sim.used;i++)if(sim.hp[i]>0) {
      assert.ok(p.terrain.canStand(sim.x[i],sim.z[i],sim.radius[i]),`unsupported seed=${seed} tick=${tick} slot=${i} x=${sim.x[i]} z=${sim.z[i]}`);
      const reach=sim.radius[i]*2;
      for(let z=sim.grid.row(sim.z[i]-reach);z<=sim.grid.row(sim.z[i]+reach);z++)for(let x=sim.grid.column(sim.x[i]-reach);x<=sim.grid.column(sim.x[i]+reach);x++)
        for(let j=sim.grid.heads[z*sim.grid.columns+x];j>=0;j=sim.grid.next[j])if(j>i)assert.ok(Math.hypot(sim.x[i]-sim.x[j],sim.z[i]-sim.z[j])>=sim.radius[i]+sim.radius[j]-1e-6);
    }
  }
  assert.notEqual(sim.result,'running',`stalled terrain seed ${seed}`);
  const result={terrainSeed:seed,ticks:sim.tick,result:sim.result,live:Array.from(sim.alive),shots:sim.totalShots};battles.push(result);console.log(JSON.stringify(result));
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/terrain-campaign.json',JSON.stringify({passed:true,battles},null,2));
