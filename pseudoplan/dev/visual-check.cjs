#!/usr/bin/env node
/* Keeps the review page honest about how it looks.
   1. Parity: the standalone render (what demos and screenshots show) and the live server page must be pixel-identical,
      apart from the agent status badge that only exists live.
   2. Golden: each example, in a fixed state, must match the approved screenshot in dev/golden/.

   node dev/visual-check.cjs            compare; exit 1 on any mismatch, writes dev/out/*.png for failures
   node dev/visual-check.cjs --update   approve the current look as the new golden images

   Needs the dev-only package "playwright" (npm i -D playwright && npx playwright install chromium).
   Set PLAN_REVIEW_CHROME to use an existing Chromium. The plugin itself still has no dependencies.
   Golden images are rasterized by the OS, so approve them once on the machine (or CI image) that will run this. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync, spawnSync } = require('child_process');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.error('playwright is not installed. Run: npm i -D playwright && npx playwright install chromium'); process.exit(2); }
const root = path.join(__dirname, '..'), S = path.join(root, 'skills/pseudocode-plan'), CLI = path.join(S, 'scripts/plan-review.cjs');
const update = process.argv.includes('--update'), outDir = path.join(__dirname, 'out'), goldDir = path.join(__dirname, 'golden');
const TOLERANCE = 0.002;   // share of pixels allowed to differ
const cases = [
  { ex:'upload', name:'upload-failure-walk', trace:2, steps:8, click:null },
  { ex:'order-flow', name:'order-flow-fork', trace:1, steps:4, click:null },
  { ex:'job-lease', name:'job-lease-frozen-worker', trace:1, steps:8, click:null },
  { ex:'job-lease', name:'job-lease-decisions', trace:0, steps:0, click:'#tabLog' },
];
const DIFF = `async ([a, b, mask]) => { const load = s => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
  const [A, B] = await Promise.all([load(a), load(b)]); if (A.width !== B.width || A.height !== B.height) return { size:[A.width, A.height, B.width, B.height] };
  const c = document.createElement('canvas'); c.width = A.width; c.height = A.height; const x = c.getContext('2d');
  x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data; x.clearRect(0, 0, c.width, c.height); x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < da.length; i += 4){ const p = i / 4, px = p % c.width, py = Math.floor(p / c.width);
    if (mask && px >= mask.x && px <= mask.x + mask.width && py >= mask.y && py <= mask.y + mask.height) continue;
    if (Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]) > 24) n++; }
  return { diff:n, total:c.width * c.height }; }`;

(async () => {
  const browser = await chromium.launch(process.env.PLAN_REVIEW_CHROME ? { executablePath:process.env.PLAN_REVIEW_CHROME } : {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-visual-')); fs.mkdirSync(outDir, { recursive:true });
  let failed = 0; const report = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
  const shoot = async (target, c, scheme) => {
    const pg = await browser.newPage({ viewport:{ width:1440, height:2600 }, colorScheme:scheme || 'light' });
    await pg.goto(target); await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(300);
    if (c.trace) await pg.click(`[data-trace="${c.trace}"]`);
    for (let i = 0; i < c.steps; i++) await pg.click('#nextBtn');
    if (c.click) await pg.click(c.click);
    await pg.waitForTimeout(250);
    const badge = await pg.$('#agentStat'); const box = badge && !(await badge.isHidden()) ? await badge.boundingBox() : null;
    const png = (await pg.screenshot()).toString('base64'); await pg.close(); return { png, box };
  };
  const compare = async (a, b, mask) => { const pg = await browser.newPage(); const r = await pg.evaluate(`(${DIFF})(${JSON.stringify([a, b, mask || null])})`); await pg.close(); return r; };

  for (const c of cases){
    const plan = path.join(tmp, c.ex + '.plan'), html = path.join(tmp, c.ex + '.html');
    fs.copyFileSync(path.join(S, 'examples', c.ex + '.plan'), plan);
    execFileSync(process.execPath, [CLI, 'render', plan, '-o', html]);
    execFileSync(process.execPath, [CLI, 'open', plan, '--no-browser']);
    const url = /http:\/\/[\d.:]+\//.exec(spawnSync(process.execPath, [CLI, 'status', plan], { encoding:'utf8' }).stdout)[0];
    try {
      for (const scheme of ['light', 'dark']){
        const stat = await shoot('file://' + html, c, scheme), live = await shoot(url, c, scheme);
        const pad = live.box ? { x:live.box.x - 8, y:live.box.y - 4, width:live.box.width + 16, height:live.box.height + 8 } : null;
        const r = await compare(stat.png, live.png, pad);
        report(!r.size && r.diff === 0, `parity  ${c.name} (${scheme})`, r.size ? 'sizes differ ' + r.size.join('x') : r.diff + ' px differ outside the agent badge');
        if (scheme === 'light'){
          const gold = path.join(goldDir, c.name + '.png');
          if (update){ fs.writeFileSync(gold, Buffer.from(stat.png, 'base64')); console.log(`new   golden  ${c.name}`); }
          else if (!fs.existsSync(gold)) report(false, `golden  ${c.name}`, 'no golden image yet: run with --update');
          else { const g = await compare(fs.readFileSync(gold).toString('base64'), stat.png); const share = g.size ? 1 : g.diff / g.total;
            report(share <= TOLERANCE, `golden  ${c.name}`, g.size ? 'size changed ' + g.size.join('x') : (share * 100).toFixed(3) + '% of pixels differ');
            if (share > TOLERANCE) fs.writeFileSync(path.join(outDir, c.name + '.actual.png'), Buffer.from(stat.png, 'base64')); }
        }
      }
    } finally { spawnSync(process.execPath, [CLI, 'stop', plan]); }
  }
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed. Actual screenshots are in dev/out/.` : '\nThe page looks the way it was approved, live and standalone.');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
