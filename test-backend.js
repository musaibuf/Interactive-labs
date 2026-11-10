/*
  Interactive Labs: live backend test
  Plays a small 2-person session end to end against your deployed backend,
  including real Claude scoring, report summaries, PDFs and exports.

  Run from the interactive-labs folder in PowerShell:
    node test-backend.js https://your-backend.onrender.com 1234
    node test-backend.js https://your-backend.onrender.com 1234 --keep   (keep the test session afterwards)

  Uses socket.io-client from frontend/node_modules, so run `npm install` in frontend first.
  Cost: about 4 email scorings, 2 summaries and 1 cohort call (a few cents).
*/

const fs = require('fs');
const path = require('path');
const readline = require('readline');

let io;
try { ({ io } = require('socket.io-client')); } catch (e) {
  try { ({ io } = require(path.join(__dirname, 'frontend', 'node_modules', 'socket.io-client'))); } catch (e2) {
    console.error('Could not find socket.io-client. Run "npm install" inside the frontend folder first.');
    process.exit(1);
  }
}

const OUT = path.join(__dirname, 'test-output');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let failed = 0;
const ok = (msg) => { passed++; console.log(`  [PASS] ${msg}`); };
const bad = (msg) => { failed++; console.log(`  [FAIL] ${msg}`); };
const info = (msg) => console.log(`         ${msg}`);
const section = (t) => console.log(`\n== ${t}`);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(300); }
  throw new Error(`Timed out waiting for ${label}`);
}

(async () => {
  let API = process.argv[2] || await ask('Backend URL (e.g. https://xxxx.onrender.com): ');
  API = API.replace(/\/$/, '');
  const PASSWORD = process.argv[3] || await ask('Facilitator password: ');
  const KEEP = process.argv.includes('--keep');
  fs.mkdirSync(OUT, { recursive: true });

  const req = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(API + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, ct, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const sockets = [];
  const connect = (auth) => new Promise((resolve, reject) => {
    const s = io(API, { transports: ['websocket', 'polling'], auth });
    s.st = null; s.on('state', (st) => { s.st = st; });
    s.call = (ev, p) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 15000); s.emit(ev, p, (r) => { clearTimeout(t); res(r || {}); }); });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket could not connect: ${e.message}`)));
    sockets.push(s);
  });

  let code = null; let T = null;
  const t0 = Date.now();
  try {
    section('1. Backend health');
    const h = await req('/');
    if (h.status === 200 && h.data.ok) ok(`Backend is up (${API})`); else throw new Error(`Backend not responding properly (status ${h.status})`);
    h.data.db ? ok('Database connected') : bad('Database NOT connected (data would be lost on restart). Set DATABASE_URL on Render.');
    h.data.mockAI ? bad('MOCK_AI is on: emails get test scores, not Claude. Set MOCK_AI=false and ANTHROPIC_API_KEY on Render.') : ok('Real Claude scoring is on');

    section('2. Facilitator login and session');
    const lg = await req('/api/login', { method: 'POST', body: { password: PASSWORD } });
    if (lg.status !== 200) throw new Error(`Login failed: ${lg.data && lg.data.error}`);
    T = lg.data.token; ok('Signed in');
    const cs = await req('/api/sessions', { method: 'POST', token: T, body: { client: 'TEST RUN', program: 'Backend test', date: new Date().toISOString().slice(0, 10), tableCount: 2, roundACount: 1 } });
    code = cs.data.code; ok(`Test session created: ${code}`);

    section('3. Participants join');
    const people = [{ name: 'Test Ayesha', table: 1 }, { name: 'Test Bilal', table: 2 }];
    for (const p of people) {
      const j = await req('/api/join', { method: 'POST', body: { code, name: p.name, tableNumber: p.table, consent: true } });
      if (!j.data.token) throw new Error(`Join failed: ${j.data.error}`);
      p.s = await connect();
      const r = await p.s.call('participant:resume', { code, token: j.data.token });
      if (!r.ok) throw new Error(`Resume failed: ${r.error}`);
      await waitFor(() => p.s.st && p.s.st.me, 8000, 'participant state');
      if (p.s.st.me.captainOffer) await p.s.call('captain:respond', { accept: true });
      ok(`${p.name} joined table ${p.table}`);
    }
    const con = await connect({ facToken: T });
    const w = await con.call('console:watch', { code });
    if (!w.ok) throw new Error(`Console could not connect: ${w.error}`);
    await waitFor(() => con.st, 8000, 'console state');
    ok('Console connected');
    const fac = async (action, p = {}) => { const r = await con.call('fac', { action, ...p }); if (!r.ok) throw new Error(`${action}: ${r.error}`); return r; };
    const step = () => con.st.step;
    const next = async () => { const c = con.st.cursor; await fac('next'); await waitFor(() => con.st.cursor === c + 1 && people.every((p) => p.s.st.step.key === con.st.step.key && p.s.st.step.index === con.st.step.index), 10000, 'next step'); };

    section('4. Lab 1');
    await next();
    if (step().key !== 'a_play') throw new Error(`Expected Spot the Slip, got ${step().key}`);
    for (const [i, p] of people.entries()) {
      const em = p.s.st.data.email;
      const flags = em.segments.filter((_, k) => (k + i) % 2 === 0).map((sg) => sg.id);
      const r = await p.s.call('a:submit', { emailId: em.id, segmentIds: flags });
      if (!r.ok) throw new Error(`Spot the Slip submit: ${r.error}`);
    }
    ok('Spot the Slip answers submitted');
    await fac('timerEnd'); await next();
    await waitFor(() => people.every((p) => p.s.st.data && p.s.st.data.totalMistakes), 5000, 'reveal');
    ok(`Spot the Slip scored (${people.map((p) => `${p.name}: ${p.s.st.data.points} pts`).join(', ')})`);
    const ch = ['call', 'message', 'email', 'face'];
    let n = 0;
    while (true) {
      await next();
      if (step().key !== 'b_play') break;
      const sit = people[0].s.st.data.situation;
      for (const [i, p] of people.entries()) await p.s.call('b:choose', { situationId: sit.id, choice: ch[(i + n) % 4] });
      await fac('timerEnd'); await next(); n++;
    }
    ok(`Pick the Channel: ${n} situations answered`);
    if (step().key === 'lab1_debrief') ok(`Leaderboard: ${con.st.data.leaderboard.map((r) => `Table ${r.number} ${r.avg}`).join(', ')}`);

    section('5. Lab 2 writing and Claude scoring');
    const emailText = (sc, name, good) => (good
      ? { subject: `${sc.title}: please reply by Thursday`, body: `Dear ${sc.recipientName},\n\nI hope you are well. I am writing about the following: ${sc.situation}\n\nCould you please let me know by Thursday 3 pm? I have attached the relevant details and I am happy to discuss on a quick call if that helps.\n\nThank you,\n${name}\n${sc.writerRole}` }
      : { subject: '', body: `hi ${sc.recipientName.split(' ')[0].toLowerCase()} need this asap thanks` });
    for (let slot = 0; slot < 2; slot++) {
      await next();
      if (step().key !== 'lab2_write') throw new Error(`Expected Lab 2 writing, got ${step().key}`);
      for (const [i, p] of people.entries()) {
        const sc = p.s.st.data.scenario;
        const r = await p.s.call('w:submit', { slot, ...emailText(sc, p.name, (i + slot) % 2 === 0) });
        if (!r.ok) throw new Error(`Email submit: ${r.error}`);
      }
      await fac('timerEnd');
    }
    ok('4 emails submitted (2 well written, 2 weak on purpose)');
    info('Waiting for Claude to score them (usually under a minute)...');
    const ts = Date.now();
    await waitFor(() => (con.st.ai || []).length === 4 && con.st.ai.every((a) => ['done', 'failed'].includes(a.status)), 180000, 'AI scoring');
    const failedAI = con.st.ai.filter((a) => a.status === 'failed');
    if (failedAI.length) { bad(`${failedAI.length} email(s) failed to score: ${failedAI[0].error}`); } else ok(`Claude scored all 4 emails in ${Math.round((Date.now() - ts) / 1000)}s`);
    for (const a of con.st.ai.filter((x) => x.status === 'done')) {
      const d = await fac('getAI', { emailId: a.emailId });
      info(`${a.participantName}, "${a.scenarioTitle}": ${d.ai.total}/30. ${d.ai.one_line_summary}`);
      if (/test mode/i.test(d.ai.one_line_summary)) bad('This is a test-mode score, not Claude');
    }
    const totals = con.st.ai.filter((a) => a.status === 'done').map((a) => a.total);
    if (totals.length === 4 && Math.max(...totals) - Math.min(...totals) >= 5) ok('Scores separate good emails from weak ones');

    section('6. Group review and reveal');
    await next();
    const sel = con.st.reviewSelection || [];
    sel.length === 2 && sel.every((r) => r.writerTable !== r.tableNumber) ? ok('Each table got an email from the other table') : bad('Review selection looks wrong');
    await next();
    for (const p of people) {
      if (!p.s.st.me.isCaptain) continue;
      const r = await p.s.call('review:submit', { scores: { clear_ask: 4, context: 3, courtesy_tone: 4, structure_length: 3, completeness: 3, subject_line: 4 }, doesWell: 'Polite and clear opening.', oneFix: 'Add a specific deadline.' });
      r.ok ? ok(`Table ${p.table} captain submitted peer scores`) : bad(`Peer review failed: ${r.error}`);
    }
    await next();
    const it = con.st.data.item;
    it && it.peer && it.ai ? ok(`Room versus AI shows both: room ${Object.values(it.peer.scores).reduce((a, b) => a + b, 0)} vs AI ${it.ai.total}`) : bad('Reveal is missing peer or AI scores');

    section('7. Reports');
    while (step().key !== 'reports') await next();
    info('Waiting for Claude to write the report summaries...');
    await waitFor(() => people.every((p) => p.s.st.data && p.s.st.data.report && p.s.st.data.report.headline), 180000, 'reports');
    for (const p of people) {
      const r = p.s.st.data.report;
      info(`${p.name}: "${r.headline}"`);
      info(`  Strengths: ${(r.strengths || []).join(' | ')}`);
      info(`  Next steps: ${(r.nextSteps || []).join(' | ')}`);
      if (/test mode/i.test(r.headline)) bad('Report summary is test mode, not Claude');
    }
    ok('Reports released to both phones');

    section('8. PDFs and exports');
    const pid = people[0].s.st.me.id;
    const pdf = await req(`/api/report/${pid}.pdf?t=${encodeURIComponent(T)}&dl=1`);
    if (pdf.status === 200 && pdf.ct.includes('pdf')) { fs.writeFileSync(path.join(OUT, 'personal-report.pdf'), pdf.data); ok('Personal report PDF downloaded'); } else bad(`Personal PDF failed (${pdf.status})`);
    info('Building the cohort report (one more Claude call)...');
    const co = await req(`/api/export/${code}/cohort.pdf?t=${encodeURIComponent(T)}`);
    if (co.status === 200 && co.ct.includes('pdf')) { fs.writeFileSync(path.join(OUT, 'cohort-report.pdf'), co.data); ok('Cohort report PDF downloaded'); } else bad(`Cohort PDF failed (${co.status})`);
    for (const f of ['scores.csv', 'reports.zip']) {
      const r = await req(`/api/export/${code}/${f}?t=${encodeURIComponent(T)}`);
      if (r.status === 200) { fs.writeFileSync(path.join(OUT, f), r.data); ok(`${f} downloaded`); } else bad(`${f} failed (${r.status})`);
    }
  } catch (e) {
    bad(e.message);
  } finally {
    sockets.forEach((s) => s.close());
    if (code && T && !KEEP) {
      const d = await req(`/api/sessions/${code}`, { method: 'DELETE', token: T }).catch(() => null);
      if (d && d.status === 200) info(`\nTest session ${code} deleted (use --keep to keep it).`);
    } else if (code) info(`\nTest session ${code} kept. Delete it from the console when done.`);
    console.log(`\nResult: ${passed} passed, ${failed} failed, ${Math.round((Date.now() - t0) / 1000)}s`);
    if (fs.existsSync(OUT)) console.log(`Files saved in: ${OUT}`);
    process.exit(failed ? 1 : 0);
  }
})();