import { mkdir, writeFile } from 'node:fs/promises';
import { BattleSimulation } from '../src/simulation.ts';

const count = Number(process.env.BATTLE_BALANCE_SEEDS ?? 100);
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Choose 1–1000 seeds.');
const wins = { plutonians: 0, sectoids: 0, draw: 0, running: 0 }, battles = [];
for (let seed = 1; seed <= count; seed++) {
  const sim = new BattleSimulation(100, seed);
  for (let tick = 0; tick < 18000 && sim.result === 'running'; tick++) sim.step();
  wins[sim.result]++;
  battles.push({ seed, result: sim.result, alive: Array.from(sim.alive), seconds: +sim.time.toFixed(2), shots: sim.totalShots });
  if (seed % 20 === 0) console.log(JSON.stringify({ completed: seed, wins }));
}
const report = { checkedAt: new Date().toISOString(), count, wins, battles };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/balance-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ count, wins }, null, 2));
if (wins.running) process.exitCode = 1;
