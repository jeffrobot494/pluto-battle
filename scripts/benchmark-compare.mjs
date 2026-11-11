// A/B browser frame benchmark between two commits (or a commit and the working tree).
//
//   npm run benchmark:compare -- <base> [head]
//
// <base>/<head> are any git refs; head defaults to the current working tree (uncommitted changes included).
// Each ref is checked out into a temporary detached worktree that borrows this checkout's node_modules through a
// junction, then scripts/terrain-benchmark.mjs runs against it. Runs alternate base/head so drift (thermals,
// background load) hits both sides equally; medians are reported.
//
// Env: COMPARE_RUNS (default 3), BATTLE_COUNT (default 500), BATTLE_UNCAPPED (default 1 — with vsync on, every
// build reads as the display's refresh rate and real differences are hidden).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const [baseRef, headRef] = process.argv.slice(2);
if (!baseRef || baseRef.startsWith('-')) {
  console.error('Usage: npm run benchmark:compare -- <base-ref> [head-ref]   (head defaults to the working tree)');
  process.exit(2);
}
const runs = Math.max(1, Number(process.env.COMPARE_RUNS ?? 3));
const count = process.env.BATTLE_COUNT ?? '500';
const uncapped = process.env.BATTLE_UNCAPPED ?? '1';

const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(ref) {
  try { return git('rev-parse', '--short', '--verify', `${ref}^{commit}`); }
  catch { console.error(`Unknown git ref: ${ref}`); process.exit(2); }
}

const scratch = mkdtempSync(join(tmpdir(), 'pluto-bench-'));
const worktrees = [];
/** Removes the node_modules junction first so nothing can delete through it into the real node_modules. */
function cleanup() {
  for (const tree of worktrees.splice(0)) {
    const link = join(tree, 'node_modules');
    if (existsSync(link)) {
      try { unlinkSync(link); } catch { try { rmdirSync(link); } catch {} }
      if (existsSync(link)) { console.error(`Could not remove the node_modules link in ${tree}; leaving that worktree in place. Remove the link, then run: git worktree remove --force "${tree}"`); continue; }
    }
    try { git('worktree', 'remove', '--force', tree); } catch (error) { console.error(`git worktree remove failed for ${tree}: ${error.message}`); }
  }
  try { git('worktree', 'prune'); } catch {}
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function checkout(ref) {
  const sha = commit(ref), tree = join(scratch, sha);
  git('worktree', 'add', '--detach', tree, sha);
  worktrees.push(tree);
  symlinkSync(join(project, 'node_modules'), join(tree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { label: sha.startsWith(ref) || ref.startsWith(sha) ? sha : `${ref} (${sha})`, source: tree };
}

function benchmark(side, run) {
  const report = join(scratch, `report-${side.key}-${run}.json`);
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(project, 'scripts/terrain-benchmark.mjs')], {
      cwd: project, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, BATTLE_SOURCE: side.source, BATTLE_REPORT: report, BATTLE_COUNT: count, BATTLE_UNCAPPED: uncapped },
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun(JSON.parse(readFileSync(report, 'utf8'))) : reject(new Error(`benchmark of ${side.label} exited with ${code}`)));
  });
}

const METRICS = [
  { key: 'fps', label: 'FPS', better: 'higher', digits: 1 },
  { key: 'p95', label: 'Frame p95 ms', better: 'lower', digits: 2 },
  { key: 'p99', label: 'Frame p99 ms', better: 'lower', digits: 2 },
  { key: 'simulationMs', label: 'Sim ms/frame', better: 'lower', digits: 2 },
  { key: 'renderMs', label: 'Render ms/frame', better: 'lower', digits: 2 },
];
const median = values => { const s = values.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Run-to-run spread on a dev machine easily reaches ±20% (thermals, background load), so a fixed threshold misleads.
// A change only counts when the two sides' min–max ranges don't overlap; more runs tighten the call.

try {
  git('worktree', 'prune');
  const sides = [{ key: 'base', ...checkout(baseRef) }, headRef ? { key: 'head', ...checkout(headRef) } : { key: 'head', label: 'working tree', source: project }];
  console.log(`Comparing ${sides[0].label} → ${sides[1].label}: ${runs} run(s) each, ${count} per team, ${uncapped === '1' ? 'uncapped' : 'vsync-capped'}`);
  const results = { base: [], head: [] };
  for (let run = 0; run < runs; run++) {
    // Alternate which side goes first so neither always gets the cooler machine.
    for (const side of run % 2 ? [...sides].reverse() : sides) {
      process.stdout.write(`  run ${run + 1}/${runs} ${side.label}… `);
      const r = await benchmark(side, run); results[side.key].push(r);
      console.log(`${r.fps.toFixed(1)} fps, p95 ${r.p95.toFixed(2)} ms`);
    }
  }
  const rows = METRICS.map(m => {
    const b = results.base.map(r => r[m.key]), h = results.head.map(r => r[m.key]);
    const base = median(b), head = median(h), range = v => `${Math.min(...v).toFixed(m.digits)}–${Math.max(...v).toFixed(m.digits)}`;
    const change = base ? (head - base) / base : 0, improved = m.better === 'higher' ? change > 0 : change < 0;
    const separated = Math.min(...h) > Math.max(...b) || Math.max(...h) < Math.min(...b);
    const verdict = runs < 2 ? '(1 run)' : !separated ? 'noise' : improved ? 'better' : 'WORSE';
    return { metric: m.label, base: +base.toFixed(m.digits), head: +head.toFixed(m.digits), change: `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`, 'base range': range(b), 'head range': range(h), verdict };
  });
  console.log(`\nMedians (base = ${sides[0].label}, head = ${sides[1].label}). A change is noise unless the run ranges don't overlap.`);
  console.table(rows);
  await mkdir(join(project, 'artifacts'), { recursive: true });
  await writeFile(join(project, 'artifacts/benchmark-compare.json'), JSON.stringify({ base: sides[0].label, head: sides[1].label, count: Number(count), uncapped: uncapped === '1', runs, rows, raw: results }, null, 2));
} catch (error) {
  console.error(`\n${error.message}`); process.exitCode = 1;
} finally { cleanup(); }
