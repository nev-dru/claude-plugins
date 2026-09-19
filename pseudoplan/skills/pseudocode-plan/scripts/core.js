/* pseudoplan core: parse, analyze, check and lay out a plan. No DOM, no dependencies.
   Loaded as a plain script by the review page and required by the CLI. */


const TAG_NAMES = ['db','network','throws','mutates'];

function dur(v){ const m = String(v || '').trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|min|m|h|d)?$/i); if (!m) return null; return +m[1] * ({ ms:1, s:1000, sec:1000, m:60000, min:60000, h:3600000, d:86400000 }[(m[2] || 's').toLowerCase()]); }
function fmtDur(ms){ if (ms == null) return ''; if (ms < 1000) return ms + 'ms'; const sec = ms / 1000; if (sec < 120) return (+sec.toFixed(1)) + 's'; if (sec < 7200) return (+(sec / 60).toFixed(1)) + 'm'; if (sec < 172800) return (+(sec / 3600).toFixed(1)) + 'h'; return (+(sec / 86400).toFixed(1)) + 'd'; }
function takeTags(text){
  const tags = [], chips = [], res = [], vals = {};
  const out = text.replace(/\[(db|network|throws|mutates|async|ttl|timeout)(?::\s*([\w.-]+))?\]/gi, (_, t, r) => {
    t = t.toLowerCase(); tags.push(t); chips.push(r ? t + ': ' + r : t);
    if (r && (t === 'db' || t === 'network')) res.push({ kind:t, name:r });
    if (r && (t === 'ttl' || t === 'timeout')) vals[t] = dur(r);
    return '';
  });
  return { text: out.replace(/\s+$/,'').replace(/\s{2,}/g,' '), tags, chips, res, vals };
}
function statusOf(mark){ return mark === '+' ? 'new' : mark === '~' ? 'mod' : mark === '-' ? 'gone' : 'same'; }
function baseOf(path){ return path.split('/').pop().replace(/\.[^.]+$/,''); }

function parsePlan(src){
  const P = { title:'Untitled plan', intent:'', diff:'', ignore:[], machines:[], decided:[], types:[], channels:[], files:[], fns:[], traces:[], notDoing:[], problems:[] };
  let file = null, fn = null, trace = null, section = null, type = null, chan = null, machine = null, service = '';
  src.replace(/\t/g,'    ').split(/\r?\n/).forEach((raw, idx) => {
    if (!raw.trim()) return;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    let m;
    if (indent === 0){
      fn = null; trace = null; section = null; type = null; chan = null; machine = null;
      if ((m = t.match(/^#\s+(.*)/))) { P.title = m[1]; return; }
      if ((m = t.match(/^intent:\s*(.*)/i))) { P.intent = m[1]; return; }
      if ((m = t.match(/^diff:\s*(.+)/i))) { P.diff = m[1].trim(); return; }
      if ((m = t.match(/^ignore:\s*(.+)/i))) { P.ignore.push(...m[1].split(',').map(x => x.trim()).filter(Boolean)); return; }
      if ((m = t.match(/^(?:([+~])\s+)?type\s+([\w$]+)\s*(?:=\s*(.*))?$/))) {
        type = { name:m[2], status:statusOf(m[1]), alias:(m[3] || '').trim(), fields:[] };
        P.types.push(type); file = null; return;
      }
      if ((m = t.match(/^(?:([+~])\s+)?machine\s+([\w$]+)/i))) { machine = { name:m[2], status:statusOf(m[1]), states:[], initial:'', final:[], transitions:[] }; P.machines.push(machine); file = null; return; }
      if (/^decided:?$/i.test(t)) { section = 'decided'; file = null; return; }
      if ((m = t.match(/^(?:service|group)\s+(.+)/i))) { service = m[1].trim(); file = null; return; }
      if ((m = t.match(/^(?:([+~])\s+)?channel\s+(\S+)(.*)$/i))) {
        chan = { id:m[2], kind:m[2].split(':')[0], name:m[2].slice(m[2].indexOf(':')+1), status:statusOf(m[1]), external:/\[external\]/i.test(m[3]), props:[] };
        P.channels.push(chan); file = null; return;
      }
      if ((m = t.match(/^(?:([+~-])\s+)?file\s+(\S+)/))) {
        file = { path:m[2], base:baseOf(m[2]), status:statusOf(m[1]), service, fns:[] };
        P.files.push(file); return;
      }
      if ((m = t.match(/^trace\s+(.*)/i))) { trace = { name:m[1], steps:[] }; P.traces.push(trace); file = null; return; }
      if (/^not doing:?$/i.test(t)) { section = 'notdoing'; file = null; return; }
      P.problems.push({ msg:`Source line ${idx+1} is not a file, type, trace or section: "${t}"` });
      return;
    }
    if (section === 'decided') {
      const parts = t.replace(/^-\s*/, '').split(/\s+\|\s+/), d = { date:parts[0] || '', where:parts[1] || '', why:parts[2] || '', chose:'', over:[], note:'' };
      parts.slice(3).forEach(x => { let k; if ((k = x.match(/^chose:\s*(.*)/i))) d.chose = k[1]; else if ((k = x.match(/^over:\s*(.*)/i))) d.over = k[1].split(/;\s+/).filter(Boolean); else if ((k = x.match(/^note:\s*(.*)/i))) d.note = k[1]; });
      P.decided.push(d); return;
    }
    if (machine){
      let k;
      if ((k = t.match(/^states:\s*(.+)/i))) { machine.states = k[1].split(',').map(x => x.trim()).filter(Boolean); return; }
      if ((k = t.match(/^initial:\s*(\S+)/i))) { machine.initial = k[1]; return; }
      if ((k = t.match(/^final:\s*(.+)/i))) { machine.final = k[1].split(',').map(x => x.trim()).filter(Boolean); return; }
      if ((k = t.match(/^(\*|[\w-]+)\s*->\s*([\w-]+)(.*)$/))) {
        let rest = k[3]; const tr = { from:k[1], to:k[2], on:'', guard:'', after:null, external:false, raw:t };
        rest = rest.replace(/\[external\]/i, () => { tr.external = true; return ''; });
        rest = rest.replace(/\bafter\s+(\d+(?:\.\d+)?\s*(?:ms|sec|min|s|m|h|d))\b/i, (_, v) => { tr.after = dur(v.replace(/\s+/g, '')); return ''; });
        rest = rest.replace(/\bif\s+(.+)$/i, (_, g) => { tr.guard = g.trim(); return ''; });
        rest = rest.replace(/\bon\s+(.+)$/i, (_, e) => { tr.on = e.trim(); return ''; });
        machine.transitions.push(tr); return;
      }
      P.problems.push({ msg:`Source line ${idx+1} is not a state list or a transition: "${t}"` }); return;
    }
    if (section === 'notdoing') { P.notDoing.push(t.replace(/^-\s*/,'')); return; }
    if (chan){
      const cm = t.match(/^([\w-]+)\s*:\s*(.+)$/);
      chan.props.push(cm ? { key:cm[1].toLowerCase(), value:cm[2] } : { key:'', value:t });
      return;
    }
    if (type){
      let body = t, comment = '';
      const ci = body.indexOf('//');
      if (ci >= 0){ comment = body.slice(ci+2).trim(); body = body.slice(0, ci).trim(); }
      const fm = body.match(/^([\w$?]+)\s*:\s*(.+)$/);
      type.fields.push(fm ? { name:fm[1], type:fm[2], comment } : { rule:body, comment });
      return;
    }
    if (trace){
      const bar = t.indexOf('|');
      const left = (bar >= 0 ? t.slice(0, bar) : t).trim();
      let note = bar >= 0 ? t.slice(bar+1).trim() : '';
      const gt = left.indexOf('>');
      const bad = note.startsWith('!');
      if (bad) note = note.slice(1).trim();
      let dt = 0; const tm = note.match(/^\+(\d+(?:\.\d+)?)\s*(ms|sec|min|s|m|h|d)\b:?\s*(.*)$/i);
      if (tm){ dt = dur(tm[1] + tm[2]); note = tm[3]; }
      trace.steps.push({ ref:(gt>=0?left.slice(0,gt):left).trim(), frag:(gt>=0?left.slice(gt+1):'').trim(), note, bad, dt });
      return;
    }
    if (file){
      if ((m = t.match(/^(?:([+~])\s+)?(fn|region)\s+(.*)/))) {
        const isRegion = m[2] === 'region';
        let rest = m[3], comment = '';
        const ci = rest.indexOf('//');
        if (ci >= 0) { comment = rest.slice(ci+2).trim(); rest = rest.slice(0, ci); }
        let anchor = null;
        rest = rest.replace(/\s@\s*(?:(\S+):)?L?(\d+)(?:-L?(\d+))?(?=\s|$)/, (_, pth, a, b) => { anchor = { path: pth || file.path, start:+a, end:+(b || a) }; return ''; });
        let entry = false; rest = rest.replace(/\[entry\]/i, () => { entry = true; return ''; });
        const on = [];
        rest = rest.replace(/\[on\s+([^\]\s]+)\]/gi, (_, c) => { on.push(c); return ''; });
        const h = takeTags(rest);
        const nm = h.text.trim().match(/^([\w$]+)/);
        const name = isRegion ? h.text.trim().split(/\s+/).slice(0, 4).join('_').replace(/[^\w$]/g, '') || 'region' : nm ? nm[1] : 'anonymous';
        fn = { id:file.base+'.'+name, name, sig:h.text.trim(), status:statusOf(m[1]), tags:h.tags, chips:h.chips, res:h.res, on, entry, anchor, isRegion, comment, file, lines:[], _st:[] };
        file.fns.push(fn); P.fns.push(fn); return;
      }
      if (fn){
        const st = fn._st;
        if (!st.length) st.push(indent);
        while (st.length > 1 && indent < st[st.length-1]) st.pop();
        if (indent > st[st.length-1]) st.push(indent);
        fn.lines.push(parseLine(t, st.length-1)); return;
      }
    }
    P.problems.push({ msg:`Source line ${idx+1} is outside any function: "${t}"` });
  });
  return P;
}

function parseLine(t, level){
  if (t.startsWith('??')){
    let why = '';
    const parts = t.slice(2).split('|').map(s => s.trim()).filter(Boolean).filter(p => {
      if (/^WHY:?\s+/i.test(p)) { why = p.replace(/^WHY:?\s+/i,''); return false; }
      return true;
    });
    const options = parts.map((p, i) => i === 0 ? p.replace(/^ASSUMED:?\s*/i,'') : p.replace(/^ALT:?\s*/i,''));
    return { kind:'decision', raw:t, text:t, level, options, why, tags:[], chips:[], res:[], jumps:[] };
  }
  let at = null;
  const h = takeTags(t.replace(/\s@\s*L?(\d+)(?:-L?(\d+))?(?=\s|$)/, (_, a, b) => { at = { start:+a, end:+(b || a) }; return ''; }));
  const jumps = [];
  const re = /->\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  let m;
  while ((m = re.exec(h.text))) jumps.push({ ref:m[1], at:m.index, len:m[0].length - 1 });
  let msg = null;
  const mm = h.text.match(/\b(emit|call)\s+([a-z][\w-]*:\S+)(?:\s*\{([^}]*)\})?/i);
  if (mm) msg = { mode:mm[1].toLowerCase(), chan:mm[2], at:mm.index + mm[0].indexOf(mm[2]), len:mm[2].length,
    fields: mm[3] != null ? mm[3].split(',').map(x => x.trim()).filter(Boolean) : null };
  return {
    kind:'code', raw:t, text:h.text, level, tags:h.tags, chips:h.chips, res:h.res, jumps, msg, at, ttl:h.vals.ttl || null, timeout:h.vals.timeout || null,
    isLoop:/^(for each|for |while |loop\b)/i.test(h.text),
    isParallel:/^(parallel|in parallel|concurrently|await all)\b.*:$/i.test(h.text),
    isHandler:/^(on\b.*\b(fail|failure|error)|catch\b|rescue\b|except\b)/i.test(h.text)
  };
}

const EXIT_RE = /^(return|throw|rethrow|raise|continue|break|exit|skip|reject|abort|bail|stop)\b/i;
function armOf(l){
  if (l.kind !== 'code' || l.isLoop || l.isParallel) return null;
  const t = l.text, ci = t.search(/:(\s|$)/); let m;
  const head = ci >= 0 ? t.slice(0, ci) : t, action = ci >= 0 ? t.slice(ci + 1).trim() : '';
  if (ci >= 0 && (m = head.match(/^(if|else if|elif|elsif|unless|when|case)\s+(.*)/i)))
    return { kind: /^el/i.test(m[1]) ? 'elif' : m[1].toLowerCase() === 'case' ? 'case' : 'if', cond:(/^unless$/i.test(m[1]) ? 'not ' : '') + m[2], action, from:ci + 1, to:t.length };
  if (ci >= 0 && /^(after|every)\s+\S/i.test(head)) return { kind:'timer', cond:head, action, from:ci + 1, to:t.length };
  if (ci >= 0 && /^(else|otherwise|default)$/i.test(head.trim())) return { kind:'else', cond:'otherwise', action, from:ci + 1, to:t.length };
  if (l.isHandler) return { kind:'handler', cond:head, action, from:ci >= 0 ? ci + 1 : t.length, to:t.length };
  if (EXIT_RE.test(t) && (m = t.match(/^(.*\S)\s+(if|unless|when)\s+(.+)$/i))) return { kind:'if', cond:(/^unless$/i.test(m[2]) ? 'not ' : '') + m[3], action:m[1], from:0, to:m[1].length };
  if ((m = t.match(/^(.*?),\s*(else|otherwise)\s+(.+)$/i))) return { kind:'else', cond:'otherwise', action:m[3], from:t.length - m[3].length, to:t.length };
  return null;
}
function findArms(f){
  const open = [];
  f.lines.forEach((l, i) => {
    while (open.length && l.level <= f.lines[open[open.length-1]].level) open.pop();
    l.inArm = open.length ? open[open.length-1] : null;
    const a = armOf(l); l.arm = null;
    if (!a) return;
    let end = i; while (end + 1 < f.lines.length && f.lines[end + 1].level > l.level) end++;
    if (end === i && !a.action) return;
    if (a.kind === 'else' && a.cond === 'otherwise' && !/,\s*(else|otherwise)\s/i.test(l.text)){ for (let k = i - 1; k >= 0; k--){ const pl = f.lines[k]; if (pl.level < l.level) break; if (pl.level === l.level && pl.arm){ a.cond = 'not ' + pl.arm.cond.replace(/^not /, ''); break; } } }
    a.end = end; a.inline = end === i; a.exits = EXIT_RE.test(a.action); a.walkedBy = [];
    l.arm = a; if (!a.inline) open.push(i);
  });
}
/* which branch does something at character `at` of line i hang on? null = unconditional */
function armFor(f, i, at){
  const l = f.lines[i];
  if (l.arm && l.arm.inline && at >= l.arm.from && at <= l.arm.to) return i;
  return l.inArm;
}
function analyze(P, ctx){
  const byId = new Map(P.fns.map(f => [f.id, f]));
  const resolve = (ref, from) => {
    if (ref.includes('.')){
      if (byId.has(ref)) return ref;
      const [b, n] = ref.split('.');
      const f = P.fns.find(f => f.name === n && f.file.base === b);
      return f ? f.id : null;
    }
    if (from && byId.has(from.file.base+'.'+ref)) return from.file.base+'.'+ref;
    const any = P.fns.find(f => f.name === ref);
    return any ? any.id : null;
  };
  P.byId = byId; P.ghosts = []; P.edgeFlags = new Map();
  P.fns.forEach(f => {
    const open = [];
    f.lines.forEach(l => {
      while (open.length && l.level <= open[open.length-1]) open.pop();
      l.inPar = open.length > 0;
      if (l.isParallel) open.push(l.level);
    });
    findArms(f);
  });
  P.resources = new Map();
  const useRes = (f, r) => {
    if (!P.resources.has(r.name)) P.resources.set(r.name, { name:r.name, kind:r.kind, users:[] });
    const R = P.resources.get(r.name);
    if (!R.users.includes(f.id)) R.users.push(f.id);
  };
  P.fns.forEach(f => { f.callees = []; f.callers = []; f.allTags = new Set(f.tags); f.res.forEach(r => useRes(f, r)); });
  P.fns.forEach(f => f.lines.forEach(l => {
    l.tags.forEach(t => f.allTags.add(t));
    l.res.forEach(r => useRes(f, r));
    l.jumps.forEach(j => {
      const id = resolve(j.ref, f);
      const ek = f.id + '>' + (id || '?'+j.ref), fl = P.edgeFlags.get(ek) || { par:false, async:false };
      if (l.inPar) fl.par = true;
      if (l.tags.includes('async')) fl.async = true;
      { const ai = armFor(f, f.lines.indexOf(l), j.at); if (ai == null) fl.always = true; else (fl.arms = fl.arms || []).push(f.id + '#' + ai); }
      P.edgeFlags.set(ek, fl);
      if (id){
        j.target = id;
        if (!f.callees.includes(id)) f.callees.push(id);
        const g = byId.get(id);
        if (!g.callers.includes(f.id)) g.callers.push(f.id);
      } else {
        j.target = null; j.ghost = '?'+j.ref;
        if (!f.callees.includes(j.ghost)) f.callees.push(j.ghost);
        if (!P.ghosts.includes(j.ghost)) P.ghosts.push(j.ghost);
      }
    });
  }));
  P.traces.forEach(tr => tr.steps.forEach(s => {
    s.fnId = resolve(s.ref, null); s.lineIdx = -1;
    if (s.fnId){
      const f = byId.get(s.fnId), frag = s.frag.toLowerCase();
      s.lineIdx = f.lines.findIndex(l => l.kind === 'code' && l.raw.toLowerCase().includes(frag));
    }
  }));
  P.chanById = new Map(P.channels.map(c => [c.id, c]));
  const chanOf = id => {
    if (!P.chanById.has(id)){
      const c = { id, kind:id.split(':')[0], name:id.slice(id.indexOf(':')+1), status:'same', external:false, undeclared:true, props:[] };
      P.channels.push(c); P.chanById.set(id, c);
    }
    return P.chanById.get(id);
  };
  P.channels.forEach(c => { c.senders = []; c.handlers = []; c.prop = k => (c.props.find(p => p.key === k) || {}).value || ''; });
  P.fns.forEach(f => {
    (f.on || []).forEach(id => { const c = chanOf(id); if (!c.senders) { c.senders = []; c.handlers = []; c.prop = k => ''; } c.handlers.push(f.id); });
    f.lines.forEach((l, i) => { if (l.msg){ const c = chanOf(l.msg.chan); if (!c.senders) { c.senders = []; c.handlers = []; c.prop = k => ''; } c.senders.push({ fnId:f.id, lineIdx:i, mode:l.msg.mode, fields:l.msg.fields }); } });
  });
  P.branch = P.traces.map(tr => {
    const taken = new Set(), skipped = new Set(), dim = new Set(), seq = new Map();
    tr.steps.forEach(st => { if (st.fnId && st.lineIdx >= 0){ if (!seq.has(st.fnId)) seq.set(st.fnId, []); seq.get(st.fnId).push(st.lineIdx); } });
    seq.forEach((idxs, fnId) => {
      const f = byId.get(fnId), vis = new Set(idxs), minV = Math.min(...idxs), maxV = Math.max(...idxs);
      let chainTaken = false;
      f.lines.forEach((l, i) => {
        const a = l.arm; if (!a) return;
        if (a.kind === 'if' || a.kind === 'handler' || a.kind === 'timer') chainTaken = false;
        let t, ev;
        if (a.inline){ ev = vis.has(i); t = ev && (!a.exits || !idxs.slice(idxs.lastIndexOf(i) + 1).some(k => k > i)); }
        else { t = false; for (let k = i + 1; k <= a.end; k++) if (vis.has(k)){ t = true; break; }
          ev = t || vis.has(i) || chainTaken || (minV < i && (maxV > a.end || a.kind === 'handler')); }
        if (chainTaken && !t) ev = true;
        if (t){ taken.add(fnId + '#' + i); chainTaken = true; if (!a.walkedBy.includes(tr.name)) a.walkedBy.push(tr.name); }
        else if (ev){ skipped.add(fnId + '#' + i); for (let k = i + 1; k <= a.end; k++) dim.add(fnId + '#' + k); }
      });
    });
    return { taken, skipped, dim, entered:new Set(seq.keys()) };
  });
  const mByName = new Map(P.machines.map(M => [M.name, M]));
  P.fns.forEach(f => f.lines.forEach(l => {
    l.move = null; if (l.kind !== 'code') return;
    const mv = l.text.match(/\b(?:transition|move|set)\s+([\w$]+)\s+to\s+([\w-]+)/i);
    if (mv && mByName.has(mv[1])) l.move = { machine:mv[1], to:mv[2] };
  }));
  P.machines.forEach(M => {
    M.transitions.forEach(t => { t.performedBy = []; t.walkedBy = []; });
    P.fns.forEach(f => f.lines.forEach(l => { if (l.move && l.move.machine === M.name) M.transitions.filter(t => t.to === l.move.to && !t.external).forEach(t => { if (!t.performedBy.includes(f.id)) t.performedBy.push(f.id); }); }));
    P.traces.forEach(tr => tr.steps.forEach(st => {
      const l = st.fnId && st.lineIdx >= 0 ? byId.get(st.fnId).lines[st.lineIdx] : null;
      if (l && l.move && l.move.machine === M.name) M.transitions.filter(t => t.to === l.move.to && !t.external).forEach(t => { if (!t.walkedBy.includes(tr.name)) t.walkedBy.push(tr.name); });
    }));
    M.layout = layoutMachine(M);
  });
  P.clock = P.traces.map(tr => { let T = 0; const at = tr.steps.map(st => (T += st.dt || 0)); const leases = [];
    tr.steps.forEach((st, i) => { const l = st.fnId && st.lineIdx >= 0 ? byId.get(st.fnId).lines[st.lineIdx] : null; if (l && l.ttl) leases.push({ step:i, from:at[i], to:at[i] + l.ttl, ttl:l.ttl, what:l.res.map(r => r.name).join(', ') || l.text }); });
    return { at, total:T, timed:tr.steps.some(st => st.dt), leases }; });
  P.types.forEach(T => {
    const re = new RegExp('\\b' + T.name.replace(/[$]/g,'\\$&') + '\\b');
    T.usedBy = P.fns.filter(f => re.test(f.sig) || f.lines.some(l => re.test(l.text))).map(f => f.id);
  });
  P.checks = runChecks(P, ctx);
  P.graph = layoutGraph(P);
  return P;
}

function runChecks(P, ctx){
  const out = P.problems.map(p => ({ level:'error', msg:p.msg }));
  const throwsFn = f => f.tags.includes('throws') || f.lines.some(l => l.tags.includes('throws'));
  const reach = (id, seen) => {
    const names = new Set(); if (seen.has(id)) return names; seen.add(id);
    const g = P.byId.get(id); if (!g) return names;
    g.res.forEach(r => names.add(r.name));
    g.lines.forEach(l => { l.res.forEach(r => names.add(r.name)); l.jumps.forEach(j => { if (j.target) reach(j.target, seen).forEach(n => names.add(n)); }); });
    return names;
  };
  P.fns.forEach(f => {
    const handles = f.lines.some(l => l.isHandler);
    f.lines.forEach((l, i) => {
      l.jumps.forEach(j => {
        if (!j.target){
          out.push({ level:'error', fnId:f.id, lineIdx:i, msg:`${f.name} calls ${j.ref}, which is not defined anywhere in this plan` });
        } else if (l.tags.includes('async')){
          if (throwsFn(P.byId.get(j.target)))
            out.push({ level:'warn', fnId:f.id, lineIdx:i, msg:`${f.name} does not wait for ${P.byId.get(j.target).name}, so any error it throws is lost` });
        } else if (j.target !== f.id && throwsFn(P.byId.get(j.target)) && !l.tags.includes('throws') && !handles){
          out.push({ level:'warn', fnId:f.id, lineIdx:i, msg:`${P.byId.get(j.target).name} can throw, and ${f.name} neither handles it nor marks the call [throws]` });
        }
      });
      if (l.isParallel){
        const branches = [];
        for (let k = i+1; k < f.lines.length && f.lines[k].level > l.level; k++){
          if (f.lines[k].level === l.level + 1) branches.push(new Set());
          const b = branches[branches.length-1]; if (!b) continue;
          f.lines[k].res.forEach(r => b.add(r.name));
          f.lines[k].jumps.forEach(j => { if (j.target) reach(j.target, new Set()).forEach(n => b.add(n)); });
        }
        const seen = new Map();
        branches.forEach(b => b.forEach(n => seen.set(n, (seen.get(n) || 0) + 1)));
        const shared = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
        if (shared.length) out.push({ level:'warn', fnId:f.id, lineIdx:i, msg:`${f.name} runs branches in parallel that both touch ${shared.join(' and ')}: confirm the order cannot matter` });
      }
      if (l.isLoop){
        const inside = new Set();
        for (let k = i+1; k < f.lines.length && f.lines[k].level > l.level; k++)
          f.lines[k].tags.forEach(t => { if (t === 'db' || t === 'network') inside.add(t); });
        if (inside.size) out.push({ level:'warn', fnId:f.id, lineIdx:i, msg:`${f.name} does ${[...inside].join(' and ')} work inside a loop: one round trip per iteration` });
      }
    });
    if (f.status === 'new' && !f.callers.length && !(f.on || []).length && !f.entry && !f.isRegion && !P.diff)
      out.push({ level:'warn', fnId:f.id, lineIdx:-1, msg:`${f.name} is new but nothing in this plan calls it` });
  });
  if (P.diff && P.files.length >= 4 && !P.files.some(f => f.service))
    out.push({ level:'warn', msg:`${P.files.length} files and no group lines: add "group Name" above each area of responsibility so the diagram shows lanes` });
  const typeByName = new Map(P.types.map(T => [T.name, T]));
  P.channels.forEach(c => {
    const at = c.senders[0] || {};
    if (c.undeclared){ out.push({ level:'error', chanId:c.id, fnId:at.fnId || c.handlers[0], lineIdx:at.lineIdx, msg:`${c.id} is used but the plan declares no contract for it` }); return; }
    if (c.senders.length && !c.handlers.length && !c.external) out.push({ level:'warn', chanId:c.id, msg:`${c.id} is sent to, but nothing in the plan handles it and it is not marked [external]` });
    if (c.handlers.length && !c.senders.length && !c.external) out.push({ level:'warn', chanId:c.id, msg:`${c.id} has a handler, but nothing in the plan sends to it and it is not marked [external]` });
    const payload = typeByName.get((c.prop('payload') || c.prop('request')).trim());
    c.senders.forEach(sd => {
      const f = P.byId.get(sd.fnId);
      if (payload && sd.fields){
        const known = new Set(payload.fields.filter(x => x.name).map(x => x.name.replace(/\?$/, '')));
        sd.fields.filter(x => !known.has(x)).forEach(x => out.push({ level:'error', chanId:c.id, fnId:f.id, lineIdx:sd.lineIdx, msg:`${f.name} sends "${x}" on ${c.id}, but ${payload.name} has no such field` }));
        const missing = payload.fields.filter(x => x.name && !x.name.endsWith('?') && !sd.fields.includes(x.name)).map(x => x.name);
        if (missing.length) out.push({ level:'warn', chanId:c.id, fnId:f.id, lineIdx:sd.lineIdx, msg:`${f.name} leaves out required ${payload.name} ${missing.length === 1 ? 'field' : 'fields'} ${missing.join(', ')} on ${c.id}` });
      }
      const text = f.lines.map(l => l.text).join(' ');
      if (sd.mode === 'emit' && f.lines.some(l => l.tags.includes('db')) && !/outbox|transaction/i.test(text))
        out.push({ level:'warn', chanId:c.id, fnId:f.id, lineIdx:sd.lineIdx, msg:`${f.name} writes to a database and emits ${c.id} with no outbox or transaction: a crash between the two leaves them disagreeing` });
      if (sd.mode === 'call' && (c.prop('timeout') || c.handlers.some(h => throwsFn(P.byId.get(h)))) && !f.lines.some(l => l.isHandler) && !f.lines[sd.lineIdx].tags.includes('throws'))
        out.push({ level:'warn', chanId:c.id, fnId:f.id, lineIdx:sd.lineIdx, msg:`${c.id} can fail or time out, and ${f.name} does not say what happens then` });
    });
    const delivery = c.prop('delivery');
    if (/at-least-once/i.test(delivery) || c.prop('retries')) c.handlers.forEach(h => {
      const f = P.byId.get(h), text = f.sig + ' ' + f.lines.map(l => l.text).join(' ');
      if (f.lines.some(l => l.tags.includes('db') || l.tags.includes('mutates') || l.msg) && !/idempot|dedupe|already (seen|processed|exists)|exists for|upsert/i.test(text))
        out.push({ level:'warn', chanId:c.id, fnId:f.id, lineIdx:-1, msg:`${c.id} ${/at-least-once/i.test(delivery) ? 'delivers at-least-once' : 'is retried'}, and ${f.name} has side effects with nothing that makes a repeat harmless` });
    });
    if (/at-most-once/i.test(delivery) && !c.prop('loss'))
      out.push({ level:'warn', chanId:c.id, msg:`${c.id} is at-most-once, so messages can vanish. The contract does not say that loss is acceptable or who retries` });
    if (c.status === 'mod' && c.external) out.push({ level:'warn', chanId:c.id, msg:`${c.id} is changing and the other side is outside this plan: say how old and new versions coexist` });
    ['payload','request','response'].forEach(k => { const T = typeByName.get(c.prop(k).trim()); if (T && T.status === 'mod' && c.external) out.push({ level:'warn', chanId:c.id, msg:`${T.name} is changing and travels on ${c.id}, whose other side is outside this plan` }); });
  });
  P.fns.forEach(f => {
    const budgets = (f.on || []).map(id => ({ id, ms:dur((P.chanById.get(id) || { prop:() => '' }).prop('timeout')) })).filter(b => b.ms);
    if (!budgets.length) return;
    const b = budgets.reduce((x, y) => (y.ms < x.ms ? y : x));
    f.lines.forEach((l, i) => {
      const waits = [];
      if (l.timeout) waits.push({ ms:l.timeout, what:l.res.map(r => r.name).join(', ') || 'this step' });
      if (l.msg && l.msg.mode === 'call'){ const c = P.chanById.get(l.msg.chan), ms = c && dur(c.prop('timeout')); if (ms) waits.push({ ms, what:c.id }); }
      waits.filter(w => w.ms > b.ms).forEach(w => out.push({ level:'warn', fnId:f.id, lineIdx:i, msg:`${f.name} has ${fmtDur(b.ms)} to answer ${b.id}, but can wait ${fmtDur(w.ms)} on ${w.what}` }));
    });
  });
  P.machines.forEach(M => {
    const has = st => M.states.includes(st), where = `State machine ${M.name}`;
    if (!M.initial || !has(M.initial)) out.push({ level:'warn', machine:M.name, msg:`${where} has no valid initial state` });
    M.transitions.forEach(t => { [t.from, t.to].forEach(st => { if (st !== '*' && !has(st)) out.push({ level:'error', machine:M.name, msg:`${where}: "${t.raw}" uses "${st}", which is not in its states list` }); }); });
    const seen = new Set(has(M.initial) ? [M.initial] : []); let grew = true;
    while (grew){ grew = false; M.transitions.forEach(t => { if ((t.from === '*' ? seen.size : seen.has(t.from)) && has(t.to) && !seen.has(t.to)){ seen.add(t.to); grew = true; } }); }
    M.states.filter(st => !seen.has(st)).forEach(st => out.push({ level:'warn', machine:M.name, msg:`${where}: nothing leads to "${st}" from "${M.initial}"` }));
    M.states.filter(st => !M.final.includes(st) && !M.transitions.some(t => t.from === st)).forEach(st => out.push({ level:'warn', machine:M.name, msg:`${where}: "${st}" is a dead end. Nothing leaves it and it is not listed as final` }));
    M.transitions.forEach((t, i) => { const twin = M.transitions.slice(i + 1).find(u => u.from === t.from && u.on === t.on && !t.guard && !u.guard && t.to !== u.to); if (twin) out.push({ level:'warn', machine:M.name, msg:`${where}: from "${t.from}", "${t.on}" leads to both "${t.to}" and "${twin.to}" with no condition to choose` }); });
    P.fns.forEach(f => f.lines.forEach((l, i) => { if (!l.move || l.move.machine !== M.name) return;
      if (!has(l.move.to)) out.push({ level:'error', fnId:f.id, lineIdx:i, msg:`${f.name} moves ${M.name} to "${l.move.to}", which is not one of its states` });
      else if (!M.transitions.some(t => t.to === l.move.to)) out.push({ level:'error', fnId:f.id, lineIdx:i, msg:`${f.name} moves ${M.name} to "${l.move.to}", but the machine declares no transition into it` }); }));
    M.transitions.filter(t => !t.external && !t.performedBy.length).forEach(t => out.push({ level:'warn', machine:M.name, msg:`${where}: nothing in the plan performs "${t.from} -> ${t.to}". Mark it [external] if something outside does` }));
    const cold = M.transitions.filter(t => t.performedBy.length && !t.walkedBy.length);
    if (P.traces.length && cold.length) out.push({ level:'warn', machine:M.name, msg:`No scenario takes ${cold.length === 1 ? 'this transition' : 'these transitions'} of ${M.name}: ${cold.map(t => t.from + ' -> ' + t.to).join(', ')}` });
  });
  if (P.traces.length) P.fns.forEach(f => {
    if (f.status === 'same' || f.isRegion || !f.lines.some(l => l.kind === 'code')) return;
    if (!P.branch.some(b => b.entered.has(f.id))){ out.push({ level:'warn', fnId:f.id, lineIdx:-1, msg:`No scenario walks through ${f.name} at all` }); return; }
    const cold = f.lines.map((l, i) => ({ l, i })).filter(x => x.l.arm && !x.l.arm.walkedBy.length);
    if (cold.length) out.push({ level:'warn', fnId:f.id, lineIdx:cold[0].i, msg:`No scenario takes ${cold.length === 1 ? 'this branch' : 'these branches'} of ${f.name}: ${cold.map(x => '"' + (x.l.arm.kind === 'else' ? x.l.text : x.l.arm.cond) + '"').join(', ')}` });
  });
  if (P.diff && ctx) diffChecks(P, ctx, out);
  P.traces.forEach(tr => tr.steps.forEach((s, i) => {
    if (!s.fnId || s.lineIdx < 0)
      out.push({ level:'error', msg:`Scenario "${tr.name}", step ${i+1}: no line in ${s.ref} matches "${s.frag}"` });
  }));
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/* Review mode: hold the plan against the real diff. ctx = { error?, hunks:{path:[{s,e,added}]}, lineCounts:{path:n}, deleted:[path] } */
function diffChecks(P, ctx, out){
  if (ctx.error){ out.push({ level:'error', msg:ctx.error }); return; }
  const ignore = P.ignore.map(g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + (g.endsWith('/') ? '.*' : '') + '$'));
  const ignored = p => ignore.some(re => re.test(p));
  const span = hs => (hs.length === 1 && hs[0].s === hs[0].e ? 'line ' : 'lines ') + hs.map(h => h.s === h.e ? String(h.s) : h.s + '-' + h.e).join(', ');
  const anchored = P.fns.filter(f => f.anchor);
  anchored.forEach(f => {
    const a = f.anchor, n = ctx.lineCounts[a.path];
    if (n == null){ out.push({ level:'error', fnId:f.id, lineIdx:-1, msg:`${f.name} points at ${a.path}, which does not exist in the reviewed revision` }); return; }
    if (a.start < 1 || a.end > n || a.start > a.end) out.push({ level:'error', fnId:f.id, lineIdx:-1, msg:`${f.name} is anchored at lines ${a.start}-${a.end}, but ${a.path} has ${n} lines` });
    f.lines.forEach((l, i) => { if (l.at && (l.at.start < a.start || l.at.end > a.end)) out.push({ level:'warn', fnId:f.id, lineIdx:i, msg:`A line of ${f.name} is anchored at ${l.at.start}-${l.at.end}, outside the function's own range ${a.start}-${a.end}` }); });
    const hs = (ctx.hunks[a.path] || []).filter(h => h.s <= a.end && h.e >= a.start);
    if (f.status === 'same' && hs.length) out.push({ level:'error', fnId:f.id, lineIdx:-1, msg:`${f.name} is marked unchanged, but ${a.path} ${span(hs)} changed inside it` });
    if (f.status === 'mod' && !hs.length) out.push({ level:'warn', fnId:f.id, lineIdx:-1, msg:`${f.name} is marked modified, but the diff changes nothing in ${a.path}:${a.start}-${a.end}` });
    if (f.status === 'new'){
      const added = hs.reduce((t, h) => t + Math.max(0, Math.min(h.e, a.end) - Math.max(h.s, a.start) + 1) * (h.added ? 1 : 0), 0);
      if (added < 0.6 * (a.end - a.start + 1)) out.push({ level:'warn', fnId:f.id, lineIdx:-1, msg:`${f.name} is marked new, but most of ${a.path}:${a.start}-${a.end} already existed` });
    }
  });
  P.fns.filter(f => !f.anchor && f.status !== 'same').forEach(f => out.push({ level:'warn', fnId:f.id, lineIdx:-1, msg:`${f.name} is marked changed but has no @ anchor, so its code cannot be shown or checked against the diff` }));
  Object.keys(ctx.hunks).forEach(p => {
    if (ignored(p)) return;
    const inPlan = n => anchored.some(f => f.anchor.path === p && f.anchor.start <= n && f.anchor.end >= n);
    const nums = [];
    ctx.hunks[p].forEach(h => {
      if (h.lines) h.lines.forEach(n => { if (!inPlan(n)) nums.push(n); });
      else if (!anchored.some(f => f.anchor.path === p && f.anchor.start <= h.e && f.anchor.end >= h.s)) nums.push(h.s);
    });
    const runs = [];
    nums.sort((x, y) => x - y).forEach(n => { const last = runs[runs.length - 1]; if (last && n <= last.e + 1) last.e = Math.max(last.e, n); else runs.push({ s:n, e:n }); });
    if (runs.length) out.push({ level:'error', msg:`${p} ${span(runs)} changed, but nothing in the plan covers them. Describe them, or list the file under ignore:` });
  });
  (ctx.deleted || []).forEach(p => { if (!ignored(p) && !P.files.some(f => f.path === p && f.status === 'gone')) out.push({ level:'error', msg:`${p} was deleted, but the plan does not list it as "- file ${p}"` }); });
}

function layoutMachine(M){
  const W = 118, H = 34, GX = 150, GY = 34, PADX = 16, TOP = 58;
  const ids = M.states.slice(); if (M.transitions.some(t => t.from === '*')) ids.push('*');
  const layer = {}; if (M.states.includes(M.initial)) layer[M.initial] = 0;
  let grew = true; while (grew){ grew = false; M.transitions.forEach(t => { if (t.from !== '*' && layer[t.from] != null && layer[t.to] == null && M.states.includes(t.to)){ layer[t.to] = layer[t.from] + 1; grew = true; } }); }
  const deepest = Math.max(0, ...Object.values(layer));
  ids.forEach(id => { if (layer[id] == null) layer[id] = id === '*' ? 0 : deepest + 1; });
  const cols = []; ids.forEach(id => { (cols[layer[id]] = cols[layer[id]] || []).push(id); });
  const tallest = Math.max(...cols.map(c => (c || []).length)), nodes = {};
  cols.forEach((col, ci) => (col || []).forEach((id, ri) => { nodes[id] = { id, x:PADX + ci * (W + GX), y:TOP + ri * (H + GY) + (tallest - col.length) * (H + GY) / 2, w:W, h:H, initial:id === M.initial, final:M.final.includes(id), any:id === '*' }; }));
  const pairCount = {};
  const edges = M.transitions.map((t, i) => {
    const a = nodes[t.from], b = nodes[t.to]; if (!a || !b) return null;
    const k = t.from + '>' + t.to, n = (pairCount[k] = (pairCount[k] || 0) + 1) - 1;
    let d, lx, ly;
    if (a === b){ const x = a.x + a.w / 2, y = a.y; d = `M${x-14},${y} C${x-30},${y-42} ${x+30},${y-42} ${x+14},${y}`; lx = x; ly = y - 36; }
    else if (b.x > a.x){ const x1 = a.x + a.w, y1 = a.y + a.h / 2 + n * 8, x2 = b.x - 2, y2 = b.y + b.h / 2 + n * 8, c = (x2 - x1) * 0.45; d = `M${x1},${y1} C${x1+c},${y1} ${x2-c},${y2} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 6 - n * 12; }
    else { const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x + b.w / 2 + 10, y2 = b.y - 2, lift = 34 + n * 16 + Math.abs(a.x - b.x) / 14; d = `M${x1},${y1} C${x1},${Math.min(y1, y2) - lift} ${x2},${Math.min(y1, y2) - lift} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = Math.min(y1, y2) - lift * 0.75 - 2; }
    return { i, from:t.from, to:t.to, d, lx, ly };
  }).filter(Boolean);
  return { nodes, edges, width:PADX * 2 + cols.length * W + (cols.length - 1) * GX, height:TOP + tallest * (H + GY) - GY + 16 };
}

const NODE_W = 168, RES_W = 112, CH_W = 204, NODE_H = 44, GAP_X = 52, GAP_Y = 16, PAD = 12;
function layoutGraph(P){
  const nodes = new Map();
  P.fns.forEach(f => {
    if ((f.status !== 'same' && !f.isRegion) || f.callers.length || f.callees.length || (f.on || []).length || f.lines.some(l => l.msg))
      nodes.set(f.id, { id:f.id, fn:f, w:NODE_W, callers:f.callers.filter(c => c !== f.id), callees:f.callees.filter(c => c !== f.id) });
  });
  P.channels.forEach(c => {
    const id = 'ch:' + c.id, senders = [...new Set(c.senders.map(x => x.fnId))].filter(x => nodes.has(x)), handlers = c.handlers.filter(x => nodes.has(x));
    nodes.set(id, { id, channel:c, w:CH_W, callers:senders, callees:handlers.slice() });
    senders.forEach(x => nodes.get(x).callees.push(id));
    handlers.forEach(x => nodes.get(x).callers.push(id));
    c.senders.forEach(x => { const f = P.byId.get(x.fnId), ai = armFor(f, x.lineIdx, f.lines[x.lineIdx].msg.at); P.edgeFlags.set(x.fnId + '>' + id, { call:x.mode === 'call', chan:true, always:ai == null, arms:ai == null ? null : [x.fnId + '#' + ai] }); });
    handlers.forEach(x => P.edgeFlags.set(id + '>' + x, { chan:true }));
  });
  P.ghosts.forEach(g => nodes.set(g, { id:g, ghost:true, w:NODE_W, label:g.slice(1), callers:[], callees:[] }));
  nodes.forEach(n => n.callees.forEach(c => { const t = nodes.get(c); if (t && t.ghost && !t.callers.includes(n.id)) t.callers.push(n.id); }));

  const memo = {}, on = new Set();
  const depth = id => {
    if (id in memo) return memo[id];
    if (on.has(id)) return -1;
    on.add(id);
    let d = 0;
    nodes.get(id).callers.forEach(c => { if (nodes.has(c)) d = Math.max(d, depth(c) + 1); });
    on.delete(id);
    return (memo[id] = d);
  };
  nodes.forEach(n => { n.layer = depth(n.id); });
  P.resources.forEach(R => {
    const id = 'res:' + R.name, users = R.users.filter(u => nodes.has(u));
    nodes.set(id, { id, resource:true, w:RES_W, kind:R.kind, label:R.name, callers:users, callees:[], layer:Math.max(0, ...users.map(u => nodes.get(u).layer)) + 1 });
    users.forEach(u => {
      nodes.get(u).callees.push(id);
      const f = P.byId.get(u), arms = []; let always = f.res.some(r => r.name === R.name);
      f.lines.forEach((l, i) => { if (!l.res.some(r => r.name === R.name)) return; const ai = armFor(f, i, l.text.length); if (ai == null) always = true; else arms.push(u + '#' + ai); });
      P.edgeFlags.set(u + '>' + id, { always, arms });
    });
  });

  let counter = 0;
  const visit = id => {
    const n = nodes.get(id);
    if (!n || n.order != null) return;
    n.order = counter++;
    n.callees.forEach(visit);
  };
  [...nodes.values()].filter(n => n.layer === 0).forEach(n => visit(n.id));
  nodes.forEach(n => visit(n.id));

  // Lanes: one horizontal band per group (a `group` or `service` line), in plan order. Files with no group share
  // an unnamed lane. Columns (layers) are shared by every lane so a call between lanes still reads left to right.
  const laneOf = n => {
    if (n.fn) return n.fn.file.service || '';
    if (n.channel){ const s = n.callers[0] || n.callees[0]; return s ? laneOf(nodes.get(s)) : ''; }
    if (n.resource || n.ghost){ const u = n.callers[0]; return u ? laneOf(nodes.get(u)) : ''; }
    return '';
  };
  const laneNames = [];
  P.files.forEach(f => { if (f.service && !laneNames.includes(f.service)) laneNames.push(f.service); });
  nodes.forEach(n => { n.lane = laneOf(n); n.isolated = !n.callers.some(c => nodes.has(c)) && !n.callees.some(c => nodes.has(c)); });
  if (nodes.size && [...nodes.values()].some(n => n.lane === '')) laneNames.push('');
  if (!laneNames.length) laneNames.push('');

  const layers = [];
  nodes.forEach(n => { (layers[n.layer] = layers[n.layer] || []).push(n); });
  for (let i = 0; i < layers.length; i++) layers[i] = (layers[i] || []).sort((a, b) => a.order - b.order);
  const colX = []; let run = PAD;
  layers.forEach((l, i) => { colX[i] = run; run += Math.max(NODE_W, ...l.map(n => n.w)) + GAP_X; });
  const width = Math.max(PAD*2 + NODE_W, run - GAP_X + PAD);
  const STEP = NODE_H + GAP_Y;
  const named = laneNames.some(Boolean);
  const LANE_HEAD = named ? 24 : 0, LANE_GAP = named ? 14 : 0;

  const lanes = []; let laneY = PAD;
  laneNames.forEach(name => {
    const mine = [...nodes.values()].filter(n => n.lane === name);
    const flow = mine.filter(n => !n.isolated), lone = mine.filter(n => n.isolated).sort((a, b) => a.order - b.order);
    const top = laneY + LANE_HEAD;
    // The connected part: the same layered placement as before, but only among this lane's nodes.
    const ls = [];
    flow.forEach(n => { (ls[n.layer] = ls[n.layer] || []).push(n); });
    const idx = []; ls.forEach((l, i) => { if (l) idx.push(i); });
    let widest = idx[0];
    idx.forEach(i => { if (ls[i].length > ls[widest].length) widest = i; });
    const here = new Set(flow.map(n => n.id));
    const place = (layer, neighbours) => {
      const want = layer.sort((a, b) => a.order - b.order).map((n, i) => {
        const ys = neighbours(n).filter(id => here.has(id)).map(id => nodes.get(id)).filter(x => x.y != null).map(x => x.y);
        return { n, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : i * STEP };
      }).sort((a, b) => a.y - b.y || a.n.order - b.n.order);
      want.forEach((w, i) => { w.n.y = i === 0 ? w.y : Math.max(w.y, want[i-1].n.y + STEP); });
    };
    let bottom = top;
    if (idx.length){
      ls[widest].sort((a, b) => a.order - b.order).forEach((n, i) => { n.y = i * STEP; });
      idx.filter(i => i > widest).forEach(i => place(ls[i], n => n.callers));
      idx.filter(i => i < widest).reverse().forEach(i => place(ls[i], n => n.callees));
      let minY = Infinity, maxY = -Infinity;
      flow.forEach(n => { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); });
      flow.forEach(n => { n.y = n.y - minY + top; n.x = colX[n.layer]; });
      bottom = maxY - minY + top + NODE_H;
    }
    // Nodes with no edges at all: a wrapped grid on the shared columns, below the flow, not one tall column.
    if (lone.length){
      const cols = Math.max(1, colX.length);
      const y0 = idx.length ? bottom + GAP_Y * 2 : top;
      lone.forEach((n, i) => { n.x = colX[i % cols]; n.y = y0 + Math.floor(i / cols) * STEP; });
      bottom = y0 + (Math.ceil(lone.length / cols) - 1) * STEP + NODE_H;
    }
    const h = Math.max(bottom - laneY, LANE_HEAD + NODE_H) + (named ? PAD : 0);
    lanes.push({ name, y:laneY, h });
    laneY += h + LANE_GAP;
  });
  const height = nodes.size ? laneY - LANE_GAP + PAD : 60;
  const edges = [];
  nodes.forEach(n => n.callees.forEach(c => { if (nodes.has(c)) {
    const fl = P.edgeFlags.get(n.id+'>'+c) || {}, e = { from:n.id, to:c, ghost:!!nodes.get(c).ghost, res:!!nodes.get(c).resource, ...fl };
    if (!fl.always && fl.arms && fl.arms.length){ const [fid, ai] = [fl.arms[0].slice(0, fl.arms[0].lastIndexOf('#')), +fl.arms[0].slice(fl.arms[0].lastIndexOf('#') + 1)]; e.cond = P.byId.get(fid).lines[ai].arm.cond; e.condArms = fl.arms; }
    edges.push(e);
  } }));
  return { nodes, edges, lanes, named, width, height };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parsePlan, analyze, runChecks, diffChecks, layoutGraph, layoutMachine, armOf, dur, fmtDur };
