#!/usr/bin/env node
/* plan-review: check a pseudocode plan, show it to a human on localhost, and hand their review back.
   Zero dependencies. Node 18+.

   plan-review check  <plan>              run the deterministic checks; exit 1 if any error
   plan-review open   <plan>              start (or reuse) the review server and open the browser
   plan-review wait   <plan> [--timeout S] block until the reviewer responds; prints the review
                                          exit 0 approved, 2 changes requested, 3 nothing yet, 4 server not running
   plan-review status <plan>              is a server running, is a review pending
   plan-review stop   <plan>              stop the server
   plan-review render <plan> [-o file]    write a standalone HTML copy (no server, review by copy and paste)
   plan-review hunks  [range]             list what a git range changed, by file and line, to write a review plan from */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const core = require('./core.js');

const args = process.argv.slice(2), cmd = args[0];
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const planArg = args.slice(1).find((a, i, all) => !a.startsWith('-') && !(all[i - 1] || '').startsWith('-'));
const usage = () => { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(4, 13).map(l => l.replace(/^ {3}/, '')).join('\n')); process.exit(64); };
if (cmd === 'hunks') { hunksCommand(args[1] || 'HEAD'); process.exit(0); }
if (!cmd || !planArg) usage();
const planPath = path.resolve(planArg);
if (cmd !== 'stop' && cmd !== 'status' && !fs.existsSync(planPath)) { console.error(`No plan file at ${planPath}`); process.exit(66); }

const key = crypto.createHash('sha1').update(planPath).digest('hex').slice(0, 12);
const stateFile = path.join(os.tmpdir(), `plan-review-${key}.json`);
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return null; } };
const writeState = s => fs.writeFileSync(stateFile, JSON.stringify(s));
const reviewFile = planPath.replace(/(\.[^./\\]+)?$/, '.review.md');
const draftFile = path.join(os.tmpdir(), `plan-review-${key}.draft.json`);

function summarize(P) {
  const e = P.checks.filter(c => c.level === 'error').length, w = P.checks.length - e;
  return { e, w, text: `${e} ${e === 1 ? 'error' : 'errors'}, ${w} ${w === 1 ? 'warning' : 'warnings'}` };
}
function loadPlan() { const P = core.parsePlan(fs.readFileSync(planPath, 'utf8')); return core.analyze(P, P.diff ? diffContext(P, path.dirname(planPath)).ctx : null); }

/* ---------------- git: what really changed ---------------- */
function git(cwd, a) { return execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
function rangeArgs(range) {
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  const bad = parts.find(x => x.startsWith('-') && x !== '--cached' && x !== '--staged');
  if (bad) throw new Error(`"${bad}" is not allowed in a diff range`);
  return parts;
}
function parseDiff(text) {
  const hunks = {}, deleted = []; let oldPath = null, cur = null, lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if (l.startsWith('--- ')) { oldPath = l.slice(4).replace(/^a\//, ''); continue; }
    if (l.startsWith('+++ ')) { const np = l.slice(4); if (np === '/dev/null') { deleted.push(oldPath); cur = null; } else { cur = np.replace(/^b\//, ''); hunks[cur] = hunks[cur] || []; } continue; }
    if (cur && (m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) {
      const b = m[2] == null ? 1 : +m[2], c = +m[3], d = m[4] == null ? 1 : +m[4];
      const removed = lines.slice(i + 1, i + 1 + b).map(x => x.slice(1)); i += b + d;
      hunks[cur].push(d ? { s: c, e: c + d - 1, added: d, removed, before: c } : { s: Math.max(1, c), e: c + 1, added: 0, removed, before: c + 1 });
    }
  }
  return { hunks, deleted };
}
function diffContext(P, cwd) {
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel']).trim(), ra = rangeArgs(P.diff);
    const d = parseDiff(git(root, ['diff', '-U0', '--no-color', '-M', ...ra]));
    const rev = ra.find(x => x.includes('..')), newRev = rev ? (rev.split(/\.{2,3}/)[1] || 'HEAD') : null;
    const files = {}, read = p => { if (!(p in files)) { try { files[p] = (newRev ? git(root, ['show', `${newRev}:${p}`]) : fs.readFileSync(path.join(root, p), 'utf8')).split('\n'); if (files[p][files[p].length - 1] === '') files[p].pop(); } catch (e) { files[p] = null; } } return files[p]; };
    const lineCounts = {};
    [...Object.keys(d.hunks), ...P.fns.filter(f => f.anchor).map(f => f.anchor.path)].forEach(p => { const c = read(p); if (c) lineCounts[p] = c.length; });
    const code = {};
    P.fns.filter(f => f.anchor && read(f.anchor.path)).forEach(f => {
      const a = f.anchor, src = read(a.path), hs = d.hunks[a.path] || [], rows = [];
      for (let n = Math.max(1, a.start); n <= Math.min(src.length, a.end); n++) {
        hs.filter(h => h.before === n).forEach(h => h.removed.forEach(text => rows.push({ kind: 'del', text })));
        rows.push({ kind: hs.some(h => h.added && h.s <= n && h.e >= n) ? 'add' : 'ctx', n, text: src[n - 1] });
      }
      code[f.id] = rows;
    });
    const light = {}; Object.keys(d.hunks).forEach(p => { const src = read(p) || []; light[p] = d.hunks[p].map(h => ({ s: h.s, e: h.e, added: h.added, lines: h.added ? Array.from({ length: h.added }, (_, k) => h.s + k).filter(n => (src[n - 1] || '').trim() !== '') : null })); });
    return { ctx: { hunks: light, lineCounts, deleted: d.deleted }, code };
  } catch (e) {
    return { ctx: { error: `Could not read the diff "${P.diff}": ${String(e.stderr || e.message || e).trim().split('\n')[0]}` }, code: {} };
  }
}
function hunksCommand(range) {
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim(), d = parseDiff(git(root, ['diff', '-U0', '--no-color', '-M', ...rangeArgs(range)]));
    console.log(`Changes in ${range} (line numbers are on the new side):`);
    Object.keys(d.hunks).forEach(p => { console.log(`\n${p}`); d.hunks[p].forEach(h => console.log(h.added ? `  ${h.s}-${h.e}  +${h.added} -${h.removed.length}` : `  after ${h.before - 1}  -${h.removed.length} (deletion only)`)); });
    d.deleted.forEach(p => console.log(`\n${p}\n  deleted`));
  } catch (e) { console.error(String(e.stderr || e.message || e).trim()); process.exit(1); }
}
function review(source) { const P = core.parsePlan(source); return P.diff ? diffContext(P, path.dirname(planPath)) : { ctx: null, code: {} }; }
function request(port, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', 'X-Plan-Review': '1', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let buf = ''; res.on('data', d => buf += d); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.setTimeout(timeoutMs || 3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function alive() {
  const st = readState(); if (!st) return null;
  try { const r = await request(st.port, 'GET', '/api/ping'); const j = JSON.parse(r.body); return j.plan === planPath ? { ...st, ...j } : null; } catch (e) { return null; }
}
function page(boot) {
  const html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8'), coreSrc = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  const safe = JSON.stringify(boot).replace(/</g, '\\u003c');
  return html.replace('/*__BOOT__*/', () => `window.__BOOT__ = ${safe};`).replace('/*__CORE__*/', () => coreSrc.replace(/<\/script/gi, '<\\/script'));
}
function openBrowser(url) {
  const c = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const ch = spawn(c[0], c[1], { stdio: 'ignore', detached: true }); ch.on('error', () => {}); ch.unref(); } catch (e) {}
}

/* ---------------- commands ---------------- */
(async () => {
  if (cmd === 'check') {
    const P = loadPlan(), s = summarize(P);
    if (args.includes('--json')) console.log(JSON.stringify(P.checks.map(c => ({ level: c.level, msg: c.msg, fn: c.fnId || null, channel: c.chanId || null }))));
    else { console.log(`${P.title}: ${P.fns.length} functions, ${P.channels.length} contracts, ${P.traces.length} scenarios. ${s.text}.`); P.checks.forEach(c => console.log(`  ${c.level === 'error' ? 'error  ' : 'warning'}  ${c.msg}`)); }
    process.exit(s.e ? 1 : 0);
  }
  if (cmd === 'render') {
    const out = path.resolve(flag('-o', planPath.replace(/(\.[^./\\]+)?$/, '.review.html')));
    const src = fs.readFileSync(planPath, 'utf8');
    fs.writeFileSync(out, page({ mode: 'static', source: src, ...review(src) })); console.log(out); process.exit(0);
  }
  if (cmd === 'serve') return serve();
  if (cmd === 'open') {
    let st = await alive();
    if (!st) {
      const child = spawn(process.execPath, [__filename, 'serve', planPath, '--port', flag('--port', String(4700 + parseInt(key.slice(0, 4), 16) % 200))], { detached: true, stdio: 'ignore' });
      child.unref();
      for (let i = 0; i < 50 && !st; i++) { await new Promise(r => setTimeout(r, 100)); st = await alive(); }
      if (!st) { console.error('The review server did not start.'); process.exit(70); }
    }
    const url = `http://127.0.0.1:${st.port}/`;
    if (!st.viewers && !args.includes('--no-browser')) openBrowser(url);
    console.log(`Review page: ${url}${st.viewers ? ' (already open in the reviewer\'s browser; it follows the plan file live)' : ''}`);
    console.log(`Checks: ${summarize(loadPlan()).text}.`);
    console.log(`Now run: plan-review wait ${JSON.stringify(planArg)}`);
    process.exit(0);
  }
  if (cmd === 'wait') {
    const st = await alive();
    if (!st) { console.error(`No review server is running for this plan. Run: plan-review open ${JSON.stringify(planArg)}`); process.exit(4); }
    const secs = Math.max(5, parseInt(flag('--timeout', '540'), 10) || 540);
    let r;
    try { r = await request(st.port, 'GET', `/api/wait?after=${st.consumed || 0}&timeout=${secs}`, null, (secs + 15) * 1000); }
    catch (e) { console.error('Lost the review server while waiting.'); process.exit(4); }
    if (r.status === 204) { console.log('No review yet. The reviewer still has the page open. Run the same wait command again.'); process.exit(3); }
    const fb = JSON.parse(r.body);
    writeState({ ...readState(), consumed: fb.seq });
    console.log(fb.review); console.log(`\n(Also saved to ${reviewFile})`);
    process.exit(fb.verdict === 'approve' ? 0 : 2);
  }
  if (cmd === 'status') {
    const st = await alive();
    console.log(st ? `Running at http://127.0.0.1:${st.port}/ with ${st.viewers} viewer(s). ${st.seq > (st.consumed || 0) ? 'A review is ready: run wait.' : 'No unread review.'}` : 'Not running.');
    process.exit(st ? 0 : 4);
  }
  if (cmd === 'stop') {
    const st = await alive();
    if (st) { try { await request(st.port, 'POST', '/api/stop'); } catch (e) {} }
    try { fs.unlinkSync(stateFile); } catch (e) {}
    console.log(st ? 'Stopped.' : 'Nothing was running.'); process.exit(0);
  }
  usage();
})();

/* ---------------- server ---------------- */
function serve() {
  let source = fs.readFileSync(planPath, 'utf8'), feedback = null, seq = 0;
  const viewers = new Set(), waiters = new Set();
  const consumed = () => (readState() || {}).consumed || 0;
  const agent = () => ({ waiting: waiters.size > 0, pending: seq > consumed() });
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => viewers.forEach(v => send(v, event, data));
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
  const body = req => new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 4e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); });

  fs.watchFile(planPath, { interval: 300 }, () => {
    let next; try { next = fs.readFileSync(planPath, 'utf8'); } catch (e) { return; }
    if (next !== source) { source = next; broadcast('plan', { source }); }
  });

  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'local only' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' && req.headers['x-plan-review'] !== '1') return json(res, 403, { error: 'missing header' });
    try {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page({ mode: 'server', source, ...review(source) })); }
      if (url.pathname === '/api/ping') return json(res, 200, { plan: planPath, viewers: viewers.size, seq });
      if (url.pathname === '/api/state') { let draft = null; try { draft = JSON.parse(fs.readFileSync(draftFile, 'utf8')); } catch (e) {} return json(res, 200, { source, draft, agent: agent(), path: planPath, ...review(source) }); }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1500\n\n'); viewers.add(res); send(res, 'agent', agent());
        req.on('close', () => viewers.delete(res)); return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/draft') { fs.writeFileSync(draftFile, JSON.stringify(await body(req))); return json(res, 200, { ok: true }); }
      if (req.method === 'PUT' && url.pathname === '/api/plan') { const b = await body(req); if (typeof b.source !== 'string') return json(res, 400, { error: 'source' }); source = b.source; fs.writeFileSync(planPath, source); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const b = await body(req); if (!b.review) return json(res, 400, { error: 'review' });
        seq += 1; feedback = { seq, verdict: b.verdict === 'approve' ? 'approve' : 'changes', review: String(b.review) };
        if (Array.isArray(b.decisions) && b.decisions.length) {
          const tidy = x => String(x == null ? '' : x).replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim(), day = new Date().toISOString().slice(0, 10);
          const rows = b.decisions.map(d => `  - ${day} | ${tidy(d.where)} | ${tidy(d.why)} | chose: ${tidy(d.chose)}${(d.over || []).length ? ' | over: ' + d.over.map(tidy).join('; ') : ''}`);
          const lines = source.replace(/\s+$/, '').split('\n'), at = lines.findIndex(l => /^decided:?\s*$/i.test(l));
          if (at < 0) lines.push('', 'decided:', ...rows);
          else { let end = at + 1; while (end < lines.length && (/^\s+\S/.test(lines[end]) || !lines[end].trim())) end++; while (end > at + 1 && !lines[end - 1].trim()) end--; lines.splice(end, 0, ...rows); }
          source = lines.join('\n') + '\n'; fs.writeFileSync(planPath, source); broadcast('plan', { source });
        }
        fs.writeFileSync(reviewFile, `<!-- round ${seq}, ${new Date().toISOString()} -->\n${feedback.review}\n`);
        try { fs.unlinkSync(draftFile); } catch (e) {}
        waiters.forEach(w => w(feedback)); waiters.clear(); broadcast('agent', agent());
        return json(res, 200, { ok: true, seq });
      }
      if (url.pathname === '/api/wait') {
        const after = parseInt(url.searchParams.get('after') || '0', 10), secs = Math.min(3600, parseInt(url.searchParams.get('timeout') || '540', 10));
        if (feedback && feedback.seq > after) return json(res, 200, feedback);
        let done = false;
        const finish = fb => { if (done) return; done = true; clearTimeout(t); waiters.delete(finish); fb ? json(res, 200, fb) : (res.writeHead(204), res.end()); setTimeout(() => broadcast('agent', agent()), 1200); };
        const t = setTimeout(() => finish(null), secs * 1000);
        waiters.add(finish); broadcast('agent', agent());
        req.on('close', () => { if (!done) { done = true; clearTimeout(t); waiters.delete(finish); broadcast('agent', agent()); } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') { json(res, 200, { ok: true }); return setTimeout(() => process.exit(0), 50); }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
  });
  let port = parseInt(flag('--port', '4700'), 10), tries = 0;
  server.on('error', e => { if (e.code === 'EADDRINUSE' && tries++ < 40) server.listen(++port, '127.0.0.1'); else { console.error(e.message); process.exit(70); } });
  server.on('listening', () => { writeState({ port, pid: process.pid, plan: planPath, consumed: 0 }); console.log(`plan-review serving ${planPath} at http://127.0.0.1:${port}/`); });
  server.listen(port, '127.0.0.1');
  setTimeout(() => process.exit(0), 12 * 3600 * 1000).unref();
}
