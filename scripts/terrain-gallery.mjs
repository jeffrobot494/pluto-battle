// Contact sheet of generated maps: shaded top-down heightmaps with stats.
// Usage: node --experimental-strip-types --no-warnings scripts/terrain-gallery.mjs [perArchetype=2] [count=100]
// Writes artifacts/terrain-gallery.html and, when Playwright is available, artifacts/terrain-gallery.png.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { prepareTerrain } from '../src/navigation.ts';
import { ARCHETYPES } from '../src/terrain-archetypes.ts';

const perArchetype = Number(process.argv[2] ?? 2), count = Number(process.argv[3] ?? 100);
const tuning = { ...DEFAULT_TUNING, count, columns: count > 200 ? 23 : DEFAULT_TUNING.columns };
const maps = [];
for (const a of ARCHETYPES) for (let i = 0; i < perArchetype; i++) {
  const seed = 1000 + i * 7919 + a.id.length * 31, start = performance.now(), { terrain, navigation } = prepareTerrain(tuning, seed, a.id), ms = performance.now() - start;
  let steep = 0; for (const s of terrain.slope) if (s > 0.85) steep++;
  maps.push({
    id: a.id, name: terrain.name, region: terrain.region, seed, defender: terrain.defender, columns: terrain.columns, rows: terrain.rows,
    heights: Array.from(terrain.heights, h => Math.round(h * 100) / 100), walkable: Array.from(navigation.walkable),
    rocks: terrain.rocks.map(r => [r.x, r.z, r.radius]), ramps: terrain.ramps.map(r => ({ repair: r.repair, points: Array.from(r.points) })),
    w: terrain.halfWidth, d: terrain.halfDepth, palette: terrain.palette,
    stats: `${(terrain.maxHeight - terrain.minHeight).toFixed(1)}u relief · ${(steep / terrain.slope.length * 100).toFixed(0)}% cliff · ${terrain.ramps.filter(r => r.repair).length} repair ramps${terrain.repairs >= 99 ? ' · FALLBACK' : ''} · ${ms.toFixed(0)} ms`,
  });
}
const html = `<!doctype html><meta charset="utf-8"><title>Terrain gallery</title>
<style>body{background:#1b1720;color:#ddd;font:12px system-ui;margin:12px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
figure{margin:0;background:#26212b;padding:6px;border-radius:6px}canvas{width:100%;image-rendering:pixelated;display:block}b{color:#fff}</style>
<main></main><script>const maps=${JSON.stringify(maps)};
const hex=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));
for(const m of maps){const f=document.createElement('figure'),c=document.createElement('canvas'),S=3,W=m.columns+1,H=m.rows+1;c.width=W*S;c.height=H*S;
const g=c.getContext('2d'),img=g.createImageData(W,H),h=m.heights;let lo=Infinity,hi=-Infinity;for(const v of h){lo=Math.min(lo,v);hi=Math.max(hi,v)}
const p=m.palette??{low:'#66333f',high:'#79607f',cliff:'#3a2a30'},L=hex(p.low),Hh=hex(p.high),C=hex(p.cliff);
for(let r=0;r<H;r++)for(let q=0;q<W;q++){const i=r*W+q,v=h[i],t=(v-lo)/(hi-lo||1),dx=(h[r*W+Math.min(W-1,q+1)]-h[r*W+Math.max(0,q-1)])/1.3,dz=(h[Math.min(H-1,r+1)*W+q]-h[Math.max(0,r-1)*W+q])/1.3;
const shade=Math.max(0.35,Math.min(1.3,0.85+(-dx*0.6-dz*0.4)*0.35)),steep=Math.hypot(dx,dz)>0.85,col=steep?C:L.map((a,k)=>a+(Hh[k]-a)*t);
const n=r<m.rows&&q<m.columns&&!m.walkable[r*m.columns+q];img.data.set([...col.map(x=>Math.min(255,x*shade*(n?0.8:1))),255],((H-1-r)*W+q)*4)}
const t=document.createElement('canvas');t.width=W;t.height=H;t.getContext('2d').putImageData(img,0,0);g.imageSmoothingEnabled=false;g.drawImage(t,0,0,W*S,H*S);
const X=x=>(x+m.w)/(2*m.w)*W*S,Z=z=>(1-(z+m.d)/(2*m.d))*H*S;
for(const r of m.ramps){g.strokeStyle=r.repair?'#ff3b6b':'#ffe066';g.lineWidth=2;g.beginPath();for(let i=0;i<r.points.length;i+=2)g[i?'lineTo':'moveTo'](X(r.points[i]),Z(r.points[i+1]));g.stroke()}
g.fillStyle='#111';for(const [x,z,rad] of m.rocks){g.beginPath();g.arc(X(x),Z(z),Math.max(1.5,rad/(2*m.w)*W*S),0,7);g.fill()}
f.append(c);const cap=document.createElement('figcaption');cap.innerHTML='<b>'+m.name+'</b> · '+m.region+(m.defender>=0?' · defender '+(m.defender?'south':'north'):'')+'<br>seed '+m.seed+' · '+m.stats;f.append(cap);document.querySelector('main').append(f)}
</script>`;
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/terrain-gallery.html', html);
console.log(`wrote artifacts/terrain-gallery.html (${maps.length} maps)`);
try {
  const { chromium } = await import('playwright');
  const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
  const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto('file://' + process.cwd().replace(/\\/g, '/') + '/artifacts/terrain-gallery.html');
  await page.screenshot({ path: 'artifacts/terrain-gallery.png', fullPage: true }); await browser.close();
  console.log('wrote artifacts/terrain-gallery.png');
} catch (e) { console.log('screenshot skipped:', e.message); }
