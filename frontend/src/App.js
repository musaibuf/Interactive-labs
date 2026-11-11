/*
  INTERACTIVE LABS (Campus to Corporate)
  Lab 1: Choosing the Right Channel | Lab 2: Writing with Respect

  Views (query param):
    /?code=XXXX                      participant phone view (default)
    /?view=screen&code=XXXX          projector / big screen
    /?view=console[&code=XXXX]       facilitator console (login)

  Backend contract (backend/index.js implements this)
  REST
    GET    /api/sessions/:code/public                 -> { code, client, program, date, tableCount }
    POST   /api/join  { code, name, tableNumber, email, consent } -> { token }
    POST   /api/login { password }                    -> { token }
    GET    /api/sessions             (Bearer)         -> [{ code, client, program, date, tableCount, status, joined }]
    POST   /api/sessions             (Bearer) { client, program, date, tableCount, roundACount } -> { code }
    DELETE /api/sessions/:code       (Bearer)
    GET    /api/report/:participantId.pdf?pt=participantToken  (or ?t=facToken)
    GET    /api/export/:code/:file?t=facToken   file: scores.csv | reports.zip | cohort.pdf | cohort.csv | round-a
  Socket.io (every emit takes an ack callback -> { ok, error?, ... })
    participant:resume { code, token }
    screen:watch       { code }
    console:watch      { code }            handshake auth: { facToken }
    captain:respond    { accept }
    a:flags            { emailId, segmentIds }
    a:submit           { emailId, segmentIds }
    b:choose           { situationId, choice }      choice: call | message | email | face
    w:draft            { slot, subject, body }
    w:submit           { slot, subject, body }
    review:submit      { scores, doesWell, oneFix }
    showcase:respond   { emailId, accept }
    fac                { action, ...payload }
  Server pushes 'state' to every socket, shaped for its role.
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Crown, Download, Eye, EyeOff,
  FileText, Loader2, Lock, LogOut, Mail, MessageSquare, Monitor, Paperclip, Pause, Pencil, Phone,
  Play, Plus, RefreshCw, Send, ShieldCheck, Smartphone, Square, Star, Trash2, Trophy, Users,
  Wifi, WifiOff, X,
} from 'lucide-react';

/* ---------------------------------------------------------------- config */

const API = (process.env.REACT_APP_BACKEND_URL || 'http://localhost:4000').replace(/\/$/, '');

const AREAS = [
  { key: 'clear_ask', label: 'Clear ask', short: 'Ask' },
  { key: 'context', label: 'Context', short: 'Context' },
  { key: 'courtesy_tone', label: 'Courtesy and tone', short: 'Tone' },
  { key: 'structure_length', label: 'Structure and length', short: 'Structure' },
  { key: 'completeness', label: 'Completeness', short: 'Complete' },
  { key: 'subject_line', label: 'Subject line', short: 'Subject' },
];

const CHANNELS = [
  { key: 'call', label: 'Call', Icon: Phone },
  { key: 'message', label: 'Message', Icon: MessageSquare },
  { key: 'email', label: 'Email', Icon: Mail },
  { key: 'face', label: 'Face to face', Icon: Users },
];
const CHANNEL_LABEL = Object.fromEntries(CHANNELS.map((c) => [c.key, c.label]));

const STEP_META = {
  lobby: { lab: 'Welcome', title: 'Lobby' },
  a_play: { lab: 'Lab 1: Choosing the Right Channel', title: 'Spot the Slip' },
  a_reveal: { lab: 'Lab 1: Choosing the Right Channel', title: 'Spot the Slip: Reveal' },
  b_play: { lab: 'Lab 1: Choosing the Right Channel', title: 'Pick the Channel' },
  b_reveal: { lab: 'Lab 1: Choosing the Right Channel', title: 'Pick the Channel: Reveal' },
  lab1_debrief: { lab: 'Lab 1: Choosing the Right Channel', title: 'Debrief' },
  lab2_write: { lab: 'Lab 2: Writing with Respect', title: 'Write' },
  review_select: { lab: 'Lab 2: Writing with Respect', title: 'Preparing Group Review' },
  review: { lab: 'Lab 2: Writing with Respect', title: 'Group Review' },
  reveal: { lab: 'Lab 2: Writing with Respect', title: 'Room versus AI' },
  reports: { lab: 'Lab 2: Writing with Respect', title: 'Your Report' },
  close: { lab: 'Interactive Labs', title: 'Thank you' },
};

const qs = new URLSearchParams(window.location.search);
const VIEW = (qs.get('view') || 'participant').toLowerCase();
const SCREEN_LIGHT = qs.get('theme') === 'light';

const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  del(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

function setQuery(params) {
  const u = new URL(window.location.href);
  Object.entries(params).forEach(([k, v]) => (v ? u.searchParams.set(k, v) : u.searchParams.delete(k)));
  window.history.replaceState({}, '', u.toString());
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const fmtTime = (ms) => {
  if (ms == null) return '--:--';
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const wordCount = (t) => (t || '').trim().split(/\s+/).filter(Boolean).length;
const joinUrlFor = (code) => `${window.location.origin}${window.location.pathname}?code=${code}`;

/* ---------------------------------------------------------------- live socket hook */

function useLive({ auth, onConnect, enabled = true }) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const offsetRef = useRef(0);
  const socketRef = useRef(null);
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const authKey = JSON.stringify(auth || {});

  useEffect(() => {
    if (!enabled) return undefined;
    const s = io(API, { transports: ['websocket', 'polling'], auth: JSON.parse(authKey), reconnectionDelayMax: 4000 });
    socketRef.current = s;
    s.on('connect', () => { setConnected(true); if (onConnectRef.current) onConnectRef.current(s); });
    s.on('disconnect', () => setConnected(false));
    s.on('state', (st) => {
      if (st && st.serverNow) offsetRef.current = st.serverNow - Date.now();
      setState(st);
    });
    return () => { s.removeAllListeners(); s.disconnect(); };
  }, [authKey, enabled]);

  const emit = useCallback((event, payload) => new Promise((resolve) => {
    const s = socketRef.current;
    if (!s || !s.connected) { resolve({ ok: false, error: 'Not connected' }); return; }
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'Timed out' }); } }, 8000);
    s.emit(event, payload, (res) => { if (!done) { done = true; clearTimeout(t); resolve(res || { ok: true }); } });
  }), []);

  return { state, connected, emit, offsetRef };
}

function remainingMs(timer, offsetRef) {
  if (!timer) return null;
  if (timer.running && timer.endsAt) return Math.max(0, timer.endsAt - (Date.now() + offsetRef.current));
  return timer.remainingMs == null ? null : timer.remainingMs;
}

function useTimeUp(timer, offsetRef) {
  const [up, setUp] = useState(false);
  const running = timer ? !!timer.running : false;
  const endsAt = timer ? timer.endsAt : null;
  const rem = timer ? timer.remainingMs : null;
  useEffect(() => {
    if (endsAt == null && rem == null) { setUp(false); return undefined; }
    if (!running) { setUp(rem === 0); return undefined; }
    const ms = endsAt - (Date.now() + offsetRef.current);
    if (ms <= 0) { setUp(true); return undefined; }
    setUp(false);
    const t = setTimeout(() => setUp(true), ms);
    return () => clearTimeout(t);
  }, [running, endsAt, rem, offsetRef]);
  return up;
}

function Countdown({ timer, offsetRef, className = '' }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!timer || !timer.running) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [timer]);
  const ms = remainingMs(timer, offsetRef);
  if (ms == null) return null;
  const low = ms <= 15000;
  return (
    <span className={`countdown ${low ? 'low' : ''} ${timer && !timer.running ? 'paused' : ''} ${className}`}>
      {timer && !timer.running ? <Pause size={14} /> : <Clock size={14} />}
      {fmtTime(ms)}
    </span>
  );
}

/* ---------------------------------------------------------------- shared UI */

function Logos({ dark }) {
  return (
    <div className={`logos ${dark ? 'dark' : ''}`}>
      <img src="/logo.png" alt="Carnelian" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      <img src="/client-logo.png" alt="Client" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
    </div>
  );
}

function Waiting({ icon: Icon = Loader2, title, text, spin }) {
  return (
    <div className="waiting">
      <div className={`waiting-icon ${spin ? 'spin' : ''}`}><Icon size={28} /></div>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
    </div>
  );
}

function Modal({ children, onClose, wide }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        {onClose && <button className="modal-x" onClick={onClose} aria-label="Close"><X size={18} /></button>}
        {children}
      </div>
    </div>
  );
}

function ConnDot({ connected }) {
  return (
    <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Connected' : 'Reconnecting'}>
      {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
    </span>
  );
}

function Radar({ values = {}, compare, size = 240, dark }) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 38;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / AREAS.length;
    const rr = (r * Math.max(0, Math.min(5, v || 0))) / 5;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  };
  const poly = (vals) => AREAS.map((a, i) => pt(i, vals[a.key]).join(',')).join(' ');
  const stroke = dark ? 'rgba(255,255,255,.25)' : '#E4E7EC';
  const text = dark ? '#E6E9F0' : '#475467';
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: size }} role="img" aria-label="Writing profile chart">
      {[1, 2, 3, 4, 5].map((lvl) => (
        <polygon key={lvl} points={AREAS.map((a, i) => pt(i, lvl).join(',')).join(' ')} fill="none" stroke={stroke} />
      ))}
      {AREAS.map((a, i) => {
        const [x, y] = pt(i, 5);
        const [lx, ly] = pt(i, 6.15);
        return (
          <g key={a.key}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke={stroke} />
            <text x={lx} y={ly} fontSize="11" fill={text} textAnchor="middle" dominantBaseline="middle">{a.short}</text>
          </g>
        );
      })}
      {compare && <polygon points={poly(compare)} fill="rgba(40,37,71,.12)" stroke="#282547" strokeDasharray="4 3" strokeWidth="1.5" />}
      <polygon points={poly(values)} fill="rgba(188,24,35,.22)" stroke="#BC1823" strokeWidth="2" />
    </svg>
  );
}

/* Email laid out like a mail client, split into tappable segments.
   mode: tap | static | heat | reveal | review */
function EmailView({ email, mode = 'static', flags, onTap, heat, explainId, onSegmentClick, big }) {
  if (!email) return null;
  const segs = email.segments || [];
  const byField = (f) => segs.filter((s) => s.field === f);
  const flagSet = flags instanceof Set ? flags : new Set(flags || []);

  const segClass = (s) => {
    const c = ['seg'];
    if (mode === 'tap') { c.push('tap'); if (flagSet.has(s.id)) c.push('flagged'); }
    if (mode === 'reveal') {
      const f = flagSet.has(s.id);
      if (s.isMistake && f) c.push('caught');
      else if (s.isMistake) c.push('missed');
      else if (f) c.push('wrong');
      if (s.isMistake) c.push('clickable');
    }
    if (mode === 'heat') { c.push('heat'); if (s.isMistake) c.push('planted'); if (explainId === s.id) c.push('explaining'); }
    return c.join(' ');
  };

  const segStyle = (s) => {
    if (mode !== 'heat' || !heat) return undefined;
    const p = Math.max(0, Math.min(100, heat[s.id] || 0));
    return { background: `rgba(188,24,35,${(p / 100) * 0.75 + 0.04})` };
  };

  const renderSeg = (s) => {
    const empty = !s.text || !s.text.trim();
    const content = empty ? <em className="muted">(no subject)</em> : s.text;
    const click = () => {
      if (mode === 'tap' && onTap) onTap(s.id);
      if (onSegmentClick) onSegmentClick(s);
    };
    return (
      <span key={s.id} className={segClass(s)} style={segStyle(s)} onClick={click} role={mode === 'tap' ? 'button' : undefined}>
        {content}
        {mode === 'heat' && heat && <sup className="heat-pct">{Math.round(heat[s.id] || 0)}%</sup>}
      </span>
    );
  };

  const header = (label, field) => {
    const items = byField(field);
    if (!items.length) return null;
    return (
      <div className="mail-row">
        <span className="mail-label">{label}</span>
        <span className="mail-val">{items.map(renderSeg)}</span>
      </div>
    );
  };

  const body = byField('body');
  const signoff = byField('signoff');

  return (
    <div className={`mail ${big ? 'big' : ''}`}>
      <div className="mail-top">
        <span className="dot r" /><span className="dot y" /><span className="dot g" />
        <span className="mail-title">{email.title || 'Message'}</span>
      </div>
      {header('To', 'to')}
      {header('CC', 'cc')}
      {header('Subject', 'subject')}
      {email.attachment !== undefined && (
        <div className="mail-row attach">
          <Paperclip size={14} />
          {email.attachment ? <span className="att-chip">{email.attachment}</span> : <span className="muted">No attachment</span>}
        </div>
      )}
      <div className="mail-body">
        {body.map((s, i) => (
          <React.Fragment key={s.id}>
            {renderSeg(s)}
            {s.newLine || i === 0 ? <span className="br" /> : ' '}
          </React.Fragment>
        ))}
        {signoff.length > 0 && <div className="signoff">{signoff.map(renderSeg)}</div>}
      </div>
    </div>
  );
}

function ScorePicker({ value, onChange, disabled }) {
  return (
    <div className="picker">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={disabled} className={`pick ${value === n ? 'on' : ''}`} onClick={() => onChange(n)}>{n}</button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- report (in app) */

const VERDICT_UI = { best: ['Best answer', 'ok'], acceptable: ['Acceptable', 'warn'], other: ['Revisit', 'bad'], none: ['No answer', ''] };

function ReportView({ report, pdfUrl }) {
  if (!report) return null;
  const t = report.tiles || {};
  const lab1 = report.lab1 || { levels: [], caughtTypes: [], toWatch: [], channelRows: [] };
  const emails = report.emails || [];
  return (
    <div className="report">
      <div className="rep-head">
        <div>
          <div className="rep-kicker">Interactive Labs: Your Report</div>
          <h2>{report.name}</h2>
          <div className="muted small">Table {report.tableNumber} | {report.program} | {report.date}</div>
        </div>
        <Logos />
      </div>

      <p className="rep-headline">{report.headline}</p>
      <div className="tiles">
        <div className="tile"><div className="tile-v">{t.slipCaught ?? '-'}<span>/{t.slipTotal ?? '-'}</span></div><div className="tile-l">Spot the Slip</div></div>
        <div className="tile"><div className="tile-v">{t.channelPct ?? '-'}<span>%</span></div><div className="tile-l">Channel judgement</div></div>
        <div className="tile"><div className="tile-v">{t.writingAvg ?? '-'}<span>/30</span></div><div className="tile-l">Writing</div></div>
      </div>
      <div className="key">Key: Spot the Slip is planted mistakes you flagged out of the total. Channel judgement counts a best answer as full credit and an acceptable answer as half. Writing is the average of your two Lab 2 emails, out of 30.</div>

      <section className="rep-sec two">
        <div>
          <h3>Strengths</h3>
          <ul className="bul">{(report.strengths || []).map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
        <div>
          <h3>Development areas</h3>
          <ul className="bul">{(report.development || []).map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      </section>
      <div className="key">Key: what to keep doing, and the areas that will lift your communication most. Drawn from both labs.</div>

      <section className="rep-sec">
        <h3>Next steps</h3>
        <ol className="bul">{(report.nextSteps || []).map((s, i) => <li key={i}>{s}</li>)}</ol>
      </section>

      <div className="lab-band">Lab 1: Choosing the Right Channel</div>

      {lab1.levels.length > 0 && (
        <section className="rep-sec">
          <h3>Spot the Slip by level</h3>
          {lab1.levels.map((l) => (
            <div key={l.level} className="lvl">
              <div className="lvl-top">
                <span><b>L{l.level} {l.label}</b> <span className="muted">{l.title}</span></span>
                <b>{l.caught}/{l.total}</b>
              </div>
              <div className="lvl-track"><div className="lvl-fill" style={{ width: `${l.total ? (l.caught / l.total) * 100 : 0}%` }} /></div>
              {l.wrong > 0 && <div className="muted small">{l.wrong} extra flag{l.wrong > 1 ? 's' : ''}</div>}
            </div>
          ))}
          <div className="key">Key: emails get harder from level 1 upward. Extra flags are parts you flagged that were correct (5 points off each).</div>
        </section>
      )}

      <section className="rep-sec">
        <h3>Mistake types</h3>
        <p className="line"><b>Caught:</b> {lab1.caughtTypes.length ? lab1.caughtTypes.join(', ') : 'none this time'}</p>
        <p className="line"><b>To watch:</b> {lab1.toWatch.length ? lab1.toWatch.map((x) => `${x.type} (missed ${x.missed} of ${x.total})`).join(', ') : 'none, every planted mistake found'}</p>
        <div className="key">Key: a type is listed under To watch if you missed at least one mistake of that type.</div>
      </section>

      {lab1.channelRows.length > 0 && (
        <section className="rep-sec">
          <h3>Pick the Channel</h3>
          <table className="ch-table">
            <thead><tr><th>Situation</th><th>You</th><th>Best</th><th /></tr></thead>
            <tbody>
              {lab1.channelRows.map((c, i) => {
                const [label, tone] = VERDICT_UI[c.verdict] || VERDICT_UI.none;
                return <tr key={i}><td>{c.short}</td><td>{c.choice}</td><td>{c.best}</td><td><span className={`badge ${tone}`}>{label}</span></td></tr>;
              })}
            </tbody>
          </table>
          <div className="key">Key: Best answer gets full credit plus a speed bonus. Acceptable gets half. Revisit means a different channel would serve this situation better.</div>
        </section>
      )}

      {report.lab1Insight && (
        <section className="rep-sec">
          <h3>What Lab 1 shows</h3>
          <p className="line">{report.lab1Insight}</p>
        </section>
      )}

      <div className="lab-band">Lab 2: Writing with Respect</div>

      <section className="rep-sec">
        <h3>Writing profile</h3>
        <div className="profile">
          <Radar values={report.profile || {}} size={220} />
          <ul className="area-list">
            {AREAS.map((a) => (
              <li key={a.key}><span>{a.label}</span><b>{report.profile && report.profile[a.key] != null ? report.profile[a.key] : '-'}</b></li>
            ))}
          </ul>
        </div>
        <div className="key">Key: average of your two emails in each area. 1 is a development priority, 3 is adequate, 5 is strong.</div>
      </section>

      {emails.length > 0 && (
        <section className="rep-sec">
          <h3>Your two emails</h3>
          {emails.map((e) => (
            <div key={e.slot} className="em-card">
              <div className="em-top">
                <div><div className="rep-kicker">Email {e.slot + 1}</div><b>{e.scenarioTitle}</b></div>
                <div className="em-total">{e.total}<span>/30</span></div>
              </div>
              <div className="chips">
                {AREAS.map((a) => <div key={a.key} className="chip-s"><span>{a.short}</span><b>{e.scores[a.key]}</b></div>)}
              </div>
              <p className="line"><b>Worked well:</b> {e.strength}</p>
              <p className="line"><b>To improve:</b> {e.fix}</p>
              <p className="line"><b>Missing:</b> {(e.missing || []).length ? e.missing.join('; ') : 'nothing major'}</p>
            </div>
          ))}
          <div className="key">Key: each email is scored on six areas from 1 to 5. Feedback refers to what you actually wrote.</div>
        </section>
      )}

      {report.improved && (
        <section className="rep-sec">
          <h3>Your email, improved</h3>
          <div className="compare">
            <div className="cmp">
              <div className="cmp-l">You wrote</div>
              <div className="cmp-s">{report.improved.original.subject || '(no subject)'}</div>
              <div className="cmp-b">{report.improved.original.body || report.improved.original.opening}</div>
            </div>
            <div className="cmp better">
              <div className="cmp-l">A stronger version</div>
              <div className="cmp-s">{report.improved.polished.subject}</div>
              <div className="cmp-b">{report.improved.polished.body}</div>
            </div>
          </div>
          <div className="key">Key: your lower-scoring email{report.improved.scenarioTitle ? ` (${report.improved.scenarioTitle})` : ''} next to a polished version with the same intent. Use it as a model, not a script.</div>
        </section>
      )}

      {report.peer && (
        <section className="rep-sec peer">
          <h3>Peer note</h3>
          <p className="line"><b>What this email does well:</b> {report.peer.doesWell}</p>
          <p className="line"><b>One thing to fix:</b> {report.peer.oneFix}</p>
          {report.peer.total != null && <p className="muted small">Table total {report.peer.total}/30{report.peer.aiTotal != null ? `, AI total ${report.peer.aiTotal}/30` : ''}</p>}
          <div className="key">Key: feedback from the table that reviewed your email anonymously. It is kept separate from your scores.</div>
        </section>
      )}

      <div className="rep-foot">We will revisit this at your 30-day check-in.</div>
      {pdfUrl && <a className="btn accent block" href={pdfUrl} download><Download size={16} /> Download PDF</a>}
    </div>
  );
}

/* ================================================================ PARTICIPANT */

function CodeEntry({ onCode }) {
  const [code, setCode] = useState('');
  return (
    <div className="p-wrap center">
      <div className="card narrow">
        <Logos />
        <h1 className="h1">Interactive Labs</h1>
        <p className="muted">Enter the session code shown on the screen.</p>
        <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) onCode(code.trim().toUpperCase()); }}>
          <input className="input code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" maxLength={8} autoCapitalize="characters" />
          <button className="btn accent block" disabled={!code.trim()}>Continue <ChevronRight size={16} /></button>
        </form>
      </div>
    </div>
  );
}

function JoinForm({ code, onJoined, onBadCode }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [table, setTable] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/sessions/${code}/public`).then(setInfo).catch((e) => setErr(e.message));
  }, [code]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await api('/api/join', { method: 'POST', body: { code, name: name.trim(), tableNumber: Number(table), consent } });
      onJoined(res.token);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };

  if (err && !info) {
    return (
      <div className="p-wrap center"><div className="card narrow">
        <Waiting icon={AlertTriangle} title="Session not found" text={err} />
        <button className="btn ghost block" onClick={onBadCode}>Try another code</button>
      </div></div>
    );
  }
  if (!info) return <div className="p-wrap center"><Waiting spin title="Loading session" /></div>;

  const client = info.client || 'the client';
  return (
    <div className="p-wrap">
      <div className="card">
        <Logos />
        <div className="kicker">{info.program}</div>
        <h1 className="h1">Join Interactive Labs</h1>
        <form onSubmit={submit} className="form">
          <label>Full name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></label>
          <label>Table number
            <select className="input" value={table} onChange={(e) => setTable(e.target.value)} required>
              <option value="">Select your table</option>
              {Array.from({ length: info.tableCount || 7 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Table {n}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Your answers and report will be shared with {client}'s L&amp;D team. Your emails may be shown anonymously to other participants for discussion.</span>
          </label>
          {err && <div className="error">{err}</div>}
          <button className="btn accent block" disabled={busy || !name.trim() || !table || !consent}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Join
          </button>
        </form>
      </div>
    </div>
  );
}

function ParticipantApp() {
  const [code, setCode] = useState((qs.get('code') || '').toUpperCase());
  const [token, setToken] = useState(() => (code ? store.get(`il_pt_${code}`) : null));

  if (!code) return <CodeEntry onCode={(c) => { setQuery({ code: c }); setCode(c); setToken(store.get(`il_pt_${c}`)); }} />;
  if (!token) {
    return (
      <JoinForm
        code={code}
        onBadCode={() => { setQuery({ code: null }); setCode(''); }}
        onJoined={(t) => { store.set(`il_pt_${code}`, t); setToken(t); }}
      />
    );
  }
  return <ParticipantLive code={code} token={token} onInvalid={() => { store.del(`il_pt_${code}`); setToken(null); }} />;
}

function ParticipantLive({ code, token, onInvalid }) {
  const onConnect = useCallback((s) => {
    s.emit('participant:resume', { code, token }, (res) => { if (!res || !res.ok) onInvalid(); });
  }, [code, token, onInvalid]);
  const { state, connected, emit, offsetRef } = useLive({ onConnect });
  const timeUp = useTimeUp(state && state.timer, offsetRef);

  if (!state) return <div className="p-wrap center"><Waiting spin title="Connecting" /></div>;

  const { me = {}, step = {}, data = {} } = state;
  const meta = STEP_META[step.key] || { lab: '', title: '' };
  const pdfUrl = me.id ? `${API}/api/report/${me.id}.pdf?pt=${encodeURIComponent(token)}&dl=1` : null;

  let body;
  switch (step.key) {
    case 'lobby':
      body = <Waiting icon={Check} title={`You're in, ${(me.name || '').split(' ')[0]}`} text={`Table ${me.tableNumber}. Look up at the screen, we will start shortly.`} />;
      break;
    case 'a_play': body = <RoundAPlay key={data.email && data.email.id} data={data} step={step} emit={emit} timeUp={timeUp} />; break;
    case 'a_reveal': body = <RoundAReveal data={data} />; break;
    case 'b_play': body = <RoundBPlay key={data.situation && data.situation.id} data={data} emit={emit} timeUp={timeUp} />; break;
    case 'b_reveal': body = <RoundBReveal data={data} />; break;
    case 'lab1_debrief': body = <Lab1Debrief data={data} />; break;
    case 'lab2_write': body = <WriteEmail key={`${data.slot}-${data.scenario && data.scenario.id}`} code={code} data={data} emit={emit} timeUp={timeUp} />; break;
    case 'review_select': body = <Waiting spin icon={Loader2} title="Group review is coming up" text="Your table will receive an anonymous email from another table to discuss." />; break;
    case 'review': body = <GroupReview key={data.item && data.item.subject} data={data} me={me} emit={emit} timeUp={timeUp} />; break;
    case 'reveal': body = <Waiting icon={Monitor} title="Room versus AI" text="Look up at the screen to see how your table's scores compare." />; break;
    case 'reports':
    case 'close':
      body = data.report
        ? <ReportView report={data.report} pdfUrl={pdfUrl} />
        : <Waiting spin title="Your report is being prepared" text="It will appear here in a moment." />;
      break;
    default: body = <Waiting spin title="Waiting for the facilitator" />;
  }

  return (
    <div className="p-shell">
      <header className="p-top">
        <div className="p-id">
          <div className="p-name">{me.name}{me.isCaptain && <span className="badge cap"><Crown size={12} /> Captain</span>}</div>
          <div className="p-sub">Table {me.tableNumber} | {meta.title}</div>
        </div>
        <div className="p-right">
          {['a_play', 'a_reveal', 'b_play', 'b_reveal', 'lab1_debrief'].includes(step.key) && me.lab1Points != null && (
            <span className="pts"><Star size={13} /> {me.lab1Points}</span>
          )}
          <Countdown timer={state.timer} offsetRef={offsetRef} />
          <ConnDot connected={connected} />
        </div>
      </header>
      <main className="p-wrap">{body}</main>

      {me.captainOffer && (
        <Modal>
          <div className="modal-icon"><Crown size={26} /></div>
          <h2>Be the table captain?</h2>
          <p className="muted">You are the first to join from Table {me.tableNumber}. The captain submits your table's group scores in Lab 2. Everyone still discusses.</p>
          <div className="row gap">
            <button className="btn ghost" onClick={() => emit('captain:respond', { accept: false })}>Not me</button>
            <button className="btn accent" onClick={() => emit('captain:respond', { accept: true })}><Check size={16} /> I'll do it</button>
          </div>
        </Modal>
      )}

      {state.showcaseRequest && (
        <Modal>
          <div className="modal-icon"><Star size={26} /></div>
          <h2>Can we show your email?</h2>
          <p className="muted">Your email "{state.showcaseRequest.subject || 'untitled'}" scored highly. May we show it on the big screen, without your name?</p>
          <div className="row gap">
            <button className="btn ghost" onClick={() => emit('showcase:respond', { emailId: state.showcaseRequest.emailId, accept: false })}>No thanks</button>
            <button className="btn accent" onClick={() => emit('showcase:respond', { emailId: state.showcaseRequest.emailId, accept: true })}><Check size={16} /> Yes, show it</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RoundAPlay({ data, step, emit, timeUp }) {
  const [flags, setFlags] = useState(() => new Set(data.flags || []));
  const [submitted, setSubmitted] = useState(!!data.submitted);
  const locked = submitted || data.submitted || timeUp;

  useEffect(() => { if (data.submitted) setSubmitted(true); }, [data.submitted]);

  const toggle = (id) => {
    if (locked) return;
    const n = new Set(flags);
    if (n.has(id)) n.delete(id); else n.add(id);
    setFlags(n);
    emit('a:flags', { emailId: data.email.id, segmentIds: [...n] });
  };
  const submit = async () => {
    setSubmitted(true);
    const res = await emit('a:submit', { emailId: data.email.id, segmentIds: [...flags] });
    if (!res.ok) setSubmitted(false);
  };

  return (
    <div className="stack">
      <div className="step-head">
        <span className="kicker">Spot the Slip | Email {(step.index || 0) + 1} of {step.total || 1}{data.email.levelLabel ? ` | ${data.email.levelLabel}` : ''}</span>
        <h2>Tap every part of this email that has a mistake.</h2>
        <p className="muted small">Tap again to un-flag. Wrong flags cost points.</p>
      </div>
      <EmailView email={data.email} mode={locked ? 'static' : 'tap'} flags={flags} onTap={toggle} />
      <div className="sticky-bar">
        <span className="muted small">{flags.size} flagged</span>
        {locked
          ? <span className="badge ok"><Lock size={12} /> Answers locked</span>
          : <button className="btn accent" onClick={submit}><Send size={16} /> Submit</button>}
      </div>
    </div>
  );
}

function RoundAReveal({ data }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="stack">
      <div className="result-card">
        <div><div className="big-num">{data.points ?? 0}</div><div className="muted small">points this email</div></div>
        <div><div className="big-num">{data.caught ?? 0}<span>/{data.totalMistakes ?? 0}</span></div><div className="muted small">mistakes caught</div></div>
      </div>
      <div className="legend">
        <span><i className="lgd caught" /> Caught</span>
        <span><i className="lgd missed" /> Missed</span>
        <span><i className="lgd wrong" /> Not a mistake</span>
      </div>
      <EmailView email={data.email} mode="reveal" flags={data.flags} onSegmentClick={(s) => s.isMistake && setOpen(s)} />
      <p className="muted small center-t">Tap a highlighted mistake to see why.</p>
      {open && (
        <Modal onClose={() => setOpen(null)}>
          <div className="kicker">{open.mistakeType}</div>
          <h3 className="quote">"{open.text || '(no subject)'}"</h3>
          <p>{open.explanation}</p>
        </Modal>
      )}
    </div>
  );
}

function RoundBPlay({ data, emit, timeUp }) {
  const [choice, setChoice] = useState(data.choice || null);
  const locked = !!choice || timeUp;
  const pick = async (key) => {
    if (locked) return;
    setChoice(key);
    const res = await emit('b:choose', { situationId: data.situation.id, choice: key });
    if (!res.ok) setChoice(null);
  };
  return (
    <div className="stack">
      <div className="step-head">
        <span className="kicker">Pick the Channel | Situation {data.number} of {data.count}</span>
        <h2 className="situation">{data.situation && data.situation.text}</h2>
        <p className="muted small">Faster correct answers earn a speed bonus.</p>
      </div>
      <div className="channels">
        {CHANNELS.map(({ key, label, Icon }) => (
          <button key={key} className={`chan ${choice === key ? 'on' : ''}`} disabled={locked && choice !== key} onClick={() => pick(key)}>
            <Icon size={28} /><span>{label}</span>
          </button>
        ))}
      </div>
      {choice && <div className="badge ok center-self"><Lock size={12} /> Locked in: {CHANNEL_LABEL[choice]}</div>}
      {!choice && timeUp && <div className="badge warn center-self">Time is up</div>}
    </div>
  );
}

function RoundBReveal({ data }) {
  const s = data.situation || {};
  const best = s.best || [];
  const acc = s.acceptable || [];
  const verdict = !data.choice ? 'No answer' : best.includes(data.choice) ? 'Best answer' : acc.includes(data.choice) ? 'Acceptable' : 'Not the best fit';
  const tone = !data.choice ? 'warn' : best.includes(data.choice) ? 'ok' : acc.includes(data.choice) ? 'warn' : 'bad';
  return (
    <div className="stack">
      <div className="step-head"><h2 className="situation">{s.text}</h2></div>
      <div className={`verdict ${tone}`}>
        <div className="v-t">{verdict}</div>
        <div className="v-p">+{data.points ?? 0} points</div>
      </div>
      <div className="card flat">
        <div className="kicker">Best answer</div>
        <div className="best-row">{best.map((b) => { const C = CHANNELS.find((c) => c.key === b); return <span key={b} className="chip ok">{C && <C.Icon size={14} />} {CHANNEL_LABEL[b]}</span>; })}</div>
        {acc.length > 0 && <><div className="kicker mt">Also acceptable</div><div className="best-row">{acc.map((b) => <span key={b} className="chip">{CHANNEL_LABEL[b]}</span>)}</div></>}
        <p className="mt">{s.explanation}</p>
      </div>
    </div>
  );
}

function Lab1Debrief({ data }) {
  return (
    <div className="stack">
      <Waiting icon={Trophy} title="Lab 1 complete" text="Your individual score is private. Only table averages appear on the screen." />
      <div className="result-card">
        <div><div className="big-num">{data.points ?? 0}</div><div className="muted small">your Lab 1 points</div></div>
        <div><div className="big-num">{data.caught ?? 0}<span>/{data.totalMistakes ?? 0}</span></div><div className="muted small">mistakes caught</div></div>
        <div><div className="big-num">{data.channelPct ?? 0}<span>%</span></div><div className="muted small">channel judgement</div></div>
      </div>
    </div>
  );
}

function WriteEmail({ code, data, emit, timeUp }) {
  const { slot, scenario = {} } = data;
  const lsKey = `il_draft_${code}_${slot}_${scenario.id}`;
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitted, setSubmitted] = useState(!!data.submitted);
  const [savedAt, setSavedAt] = useState(null);
  const latest = useRef({ subject: '', body: '' });
  const dirty = useRef(false);

  useEffect(() => {
    let local = null;
    try { local = JSON.parse(store.get(lsKey) || 'null'); } catch (e) { local = null; }
    const server = data.draft || { subject: '', body: '' };
    const pick = local && (local.body || '').length > (server.body || '').length ? local : server;
    setSubject(pick.subject || ''); setBody(pick.body || '');
    latest.current = { subject: pick.subject || '', body: pick.body || '' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (data.submitted) setSubmitted(true); }, [data.submitted]);

  const update = (s, b) => {
    latest.current = { subject: s, body: b };
    dirty.current = true;
    store.set(lsKey, JSON.stringify(latest.current));
  };

  useEffect(() => {
    const t = setInterval(async () => {
      if (!dirty.current || submitted) return;
      dirty.current = false;
      const res = await emit('w:draft', { slot, ...latest.current });
      if (res.ok) setSavedAt(new Date()); else dirty.current = true;
    }, 10000);
    return () => clearInterval(t);
  }, [emit, slot, submitted]);

  useEffect(() => {
    if (timeUp && !submitted) { emit('w:draft', { slot, ...latest.current }); }
  }, [timeUp, submitted, emit, slot]);

  const submit = async () => {
    setSubmitted(true);
    const res = await emit('w:submit', { slot, ...latest.current });
    if (!res.ok) setSubmitted(false); else store.del(lsKey);
  };

  if (submitted || data.submitted) {
    return <Waiting icon={Check} title={`Email ${slot + 1} submitted`} text={slot === 0 ? 'Your next scenario will open when the facilitator starts it.' : 'Both emails are in. Group review is next.'} />;
  }

  const locked = timeUp;
  return (
    <div className="stack">
      <div className="scenario">
        <div className="kicker">Email {slot + 1} of 2 | {scenario.title}</div>
        <p className="sc-role"><b>You are:</b> {scenario.writerRole}</p>
        <p className="sc-role"><b>Writing to:</b> {scenario.recipientName}{scenario.recipientRole ? `, ${scenario.recipientRole}` : ''}</p>
        <p>{scenario.situation}</p>
      </div>
      <div className="compose">
        <div className="c-row"><span className="c-l">To</span><span className="c-v ro">{scenario.recipientName}{scenario.recipientRole ? ` (${scenario.recipientRole})` : ''}</span></div>
        <div className="c-row"><span className="c-l">Subject</span>
          <input className="c-in" value={subject} disabled={locked} onChange={(e) => { setSubject(e.target.value); update(e.target.value, body); }} placeholder="Subject" />
        </div>
        <textarea className="c-body" value={body} disabled={locked} onChange={(e) => { setBody(e.target.value); update(subject, e.target.value); }} placeholder="Write your email here" rows={12} />
        <div className="c-foot">
          <span className="muted small">{wordCount(body)} words</span>
          <span className="muted small">{savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Autosaves every 10 seconds'}</span>
        </div>
      </div>
      <button className="btn accent block" disabled={!body.trim() || locked} onClick={submit}><Send size={16} /> Submit email</button>
      {locked && <div className="badge warn center-self">Time is up, your draft has been submitted</div>}
    </div>
  );
}

function GroupReview({ data, me, emit, timeUp }) {
  const item = data.item;
  const [scores, setScores] = useState({});
  const [doesWell, setDoesWell] = useState('');
  const [oneFix, setOneFix] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!item && data.noEmail) return <Waiting icon={Users} title="No email for your table this round" text="Your facilitator will pair you with a neighbouring table for the discussion." />;
  if (!item) return <Waiting spin title="Waiting for your table's email" />;

  const complete = AREAS.every((a) => scores[a.key]) && doesWell.trim() && oneFix.trim();
  const submit = async () => {
    setBusy(true); setErr('');
    const res = await emit('review:submit', { scores, doesWell: doesWell.trim(), oneFix: oneFix.trim() });
    if (!res.ok) setErr(res.error || 'Could not submit, try again');
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="scenario">
        <div className="kicker">Group review | {item.scenario.title}</div>
        <p className="sc-role"><b>Writer:</b> {item.scenario.writerRole}</p>
        <p className="sc-role"><b>Writing to:</b> {item.scenario.recipientName}{item.scenario.recipientRole ? `, ${item.scenario.recipientRole}` : ''}</p>
        <p>{item.scenario.situation}</p>
      </div>
      <div className="mail">
        <div className="mail-top"><span className="dot r" /><span className="dot y" /><span className="dot g" /><span className="mail-title">Anonymous email</span></div>
        <div className="mail-row"><span className="mail-label">To</span><span className="mail-val">{item.to}</span></div>
        <div className="mail-row"><span className="mail-label">Subject</span><span className="mail-val">{item.subject || <em className="muted">(no subject)</em>}</span></div>
        <div className="mail-body pre">{item.body}</div>
      </div>

      {data.submitted ? (
        <Waiting icon={Check} title="Your table's scores are in" text="Watch the screen for the Room versus AI reveal." />
      ) : !me.isCaptain ? (
        <div className="card flat"><p className="muted"><Crown size={14} /> Discuss this email with your table. Your captain submits the scores.</p></div>
      ) : (
        <div className="card">
          <h3>Score this email (1 to 5)</h3>
          <div className="key">Key: 1 weak, 3 adequate, 5 strong.</div>
          {AREAS.map((a) => (
            <div key={a.key} className="score-row">
              <span>{a.label}</span>
              <ScorePicker value={scores[a.key]} disabled={timeUp} onChange={(n) => setScores({ ...scores, [a.key]: n })} />
            </div>
          ))}
          <label className="lbl">What this email does well<textarea className="input" rows={2} value={doesWell} onChange={(e) => setDoesWell(e.target.value)} /></label>
          <label className="lbl">One thing to fix<textarea className="input" rows={2} value={oneFix} onChange={(e) => setOneFix(e.target.value)} /></label>
          {err && <div className="error">{err}</div>}
          <button className="btn accent block" disabled={!complete || busy || timeUp} onClick={submit}><Send size={16} /> Submit table scores</button>
        </div>
      )}
    </div>
  );
}

/* ================================================================ BIG SCREEN */

function ScreenApp() {
  const [code, setCode] = useState((qs.get('code') || '').toUpperCase());
  if (!code) {
    return (
      <div className="screen center">
        <div className="card narrow">
          <h1 className="h1">Big screen</h1>
          <CodeInline onCode={(c) => { setQuery({ view: 'screen', code: c }); setCode(c); }} />
        </div>
      </div>
    );
  }
  return <ScreenLive code={code} />;
}

function CodeInline({ onCode }) {
  const [c, setC] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (c.trim()) onCode(c.trim().toUpperCase()); }}>
      <input className="input code" value={c} onChange={(e) => setC(e.target.value.toUpperCase())} placeholder="CODE" />
      <button className="btn accent block">Open</button>
    </form>
  );
}

function ScreenLive({ code }) {
  const onConnect = useCallback((s) => s.emit('screen:watch', { code }, () => {}), [code]);
  const { state, connected, offsetRef } = useLive({ onConnect });
  if (!state) return <div className="screen center"><Waiting spin title="Connecting" /></div>;
  const { session = {}, step = {}, data = {} } = state;
  const meta = STEP_META[step.key] || {};

  return (
    <div className={`screen ${SCREEN_LIGHT ? 'light' : ''}`}>
      <header className="s-top">
        <Logos dark />
        <div className="s-title">
          <div className="s-lab">{meta.lab}</div>
          <div className="s-step">{meta.title}{step.total > 1 ? ` | ${(step.index || 0) + 1} of ${step.total}` : ''}</div>
        </div>
        <div className="s-right">
          <Countdown timer={state.timer} offsetRef={offsetRef} className="xl" />
          <ConnDot connected={connected} />
        </div>
      </header>
      <main className="s-main">
        <ScreenBody step={step} data={data} session={session} code={code} />
      </main>
      {state.showcase && (
        <div className="showcase">
          <div className="showcase-in">
            <div className="kicker light"><Star size={14} /> Showcase | {state.showcase.scenarioTitle}</div>
            <div className="mail big">
              <div className="mail-row"><span className="mail-label">Subject</span><span className="mail-val">{state.showcase.subject}</span></div>
              <div className="mail-body pre">{state.showcase.body}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScreenBody({ step, data, session, code }) {
  switch (step.key) {
    case 'lobby': {
      const url = joinUrlFor(code);
      return (
        <div className="lobby">
          <div className="qr-card">
            <QRCodeSVG value={url} size={300} level="M" includeMargin />
            <div className="qr-code">{code}</div>
            <div className="qr-url">{url.replace(/^https?:\/\//, '')}</div>
          </div>
          <div className="lobby-right">
            <h1 className="s-h1">Scan to join</h1>
            <p className="s-p">{session.program} | {data.joined || 0} joined</p>
            <div className="tables">
              {(data.tables || []).map((t) => (
                <div key={t.number} className="tbl">
                  <div className="tbl-h">Table {t.number}<span>{t.names.length}</span></div>
                  {t.names.map((n, i) => <div key={i} className="tbl-n">{n}</div>)}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }
    case 'a_play':
      return (
        <div className="split">
          <div className="split-main"><EmailView email={data.email} big /></div>
          <aside className="split-side">
            {data.email && data.email.levelLabel && <div className="kicker light">Level {data.email.level}: {data.email.levelLabel}</div>}
            <h2 className="s-h2">Spot the Slip</h2>
            <p className="s-p">Tap every part of the email that has a mistake.</p>
            <Progress done={data.submitted} total={data.joined} label="submitted" />
          </aside>
        </div>
      );
    case 'a_reveal': {
      const ex = data.email && (data.email.segments || []).find((s) => s.id === data.explainId);
      return (
        <div className="split">
          <div className="split-main"><EmailView email={data.email} mode="heat" heat={data.heat} explainId={data.explainId} big /></div>
          <aside className="split-side">
            <h2 className="s-h2">How the room flagged it</h2>
            <div className="heat-key"><span>0%</span><i /><span>100%</span></div>
            <p className="s-p small">Darker means more people flagged it. Dashed outline marks a planted mistake.</p>
            {ex && (
              <div className="explain">
                <div className="kicker light">{ex.mistakeType}</div>
                <div className="ex-q">"{ex.text || '(no subject)'}"</div>
                <p>{ex.explanation}</p>
              </div>
            )}
          </aside>
        </div>
      );
    }
    case 'b_play':
      return (
        <div className="center-col">
          <div className="kicker light">Situation {data.number} of {data.count}</div>
          <h1 className="s-situation">{data.situation && data.situation.text}</h1>
          <div className="chan-row">{CHANNELS.map(({ key, label, Icon }) => <div key={key} className="chan-s"><Icon size={36} /><span>{label}</span></div>)}</div>
          <Progress done={data.answered} total={data.joined} label="answered" />
        </div>
      );
    case 'b_reveal': {
      const s = data.situation || {};
      const counts = data.counts || {};
      const total = Math.max(1, CHANNELS.reduce((a, c) => a + (counts[c.key] || 0), 0));
      return (
        <div className="center-col">
          <h1 className="s-situation sm">{s.text}</h1>
          <div className="bars">
            {CHANNELS.map(({ key, label, Icon }) => {
              const n = counts[key] || 0;
              const pct = Math.round((n / total) * 100);
              const isBest = (s.best || []).includes(key);
              const isAcc = (s.acceptable || []).includes(key);
              return (
                <div key={key} className={`bar ${isBest ? 'best' : isAcc ? 'acc' : ''}`}>
                  <div className="bar-pct">{pct}%</div>
                  <div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(3, pct)}%` }} /></div>
                  <div className="bar-l"><Icon size={22} />{label}</div>
                  {isBest && <div className="bar-tag">Best</div>}
                  {isAcc && <div className="bar-tag acc">Acceptable</div>}
                </div>
              );
            })}
          </div>
          <p className="s-explain">{s.explanation}</p>
        </div>
      );
    }
    case 'lab1_debrief':
      return <Leaderboard rows={data.leaderboard || []} />;
    case 'lab2_write':
      return (
        <div className="center-col">
          <Pencil size={48} className="accent-ic" />
          <h1 className="s-h1">Email {(data.slot || 0) + 1} of 2</h1>
          <p className="s-p">Read your scenario and write your email on your phone.</p>
          <Progress done={data.submitted} total={data.joined} label="submitted" />
        </div>
      );
    case 'review_select':
      return <div className="center-col"><Users size={48} className="accent-ic" /><h1 className="s-h1">Group review</h1><p className="s-p">Each table will review one anonymous email from another table.</p></div>;
    case 'review':
      return (
        <div className="center-col">
          <h1 className="s-h1">Group review</h1>
          <p className="s-p">Discuss as a table. Captains submit the six scores and two comments.</p>
          <div className="tbl-status">
            {(data.tables || []).map((t) => (
              <div key={t.number} className={`ts ${t.submitted ? 'done' : ''}`}>{t.submitted ? <Check size={22} /> : <Loader2 size={22} className="spin" />}<span>Table {t.number}</span></div>
            ))}
          </div>
        </div>
      );
    case 'reveal':
      return <RevealPanel data={data} />;
    case 'reports':
      return <div className="center-col"><FileText size={52} className="accent-ic" /><h1 className="s-h1">Your report is on your phone</h1><p className="s-p">Take a few minutes to read it. You can download the PDF.</p><Progress done={data.released} total={data.total} label="reports ready" /></div>;
    case 'close':
      return <div className="center-col"><ShieldCheck size={52} className="accent-ic" /><h1 className="s-h1">Thank you</h1><p className="s-p">We will revisit this at your 30-day check-in.</p></div>;
    default:
      return <Waiting spin title="Waiting for the facilitator" />;
  }
}

function Progress({ done = 0, total = 0, label }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress">
      <div className="pr-n">{done}<span>/{total}</span></div>
      <div className="pr-track"><div className="pr-fill" style={{ width: `${pct}%` }} /></div>
      <div className="pr-l">{label}</div>
    </div>
  );
}

function Leaderboard({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.avg || 0));
  return (
    <div className="center-col wide">
      <h1 className="s-h1"><Trophy size={36} className="accent-ic" /> Table leaderboard</h1>
      <p className="s-p small">Average Lab 1 score of each table's members.</p>
      <div className="lb">
        {rows.map((r, i) => (
          <div key={r.number} className={`lb-row ${i === 0 ? 'top' : ''}`}>
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-name">Table {r.number}</span>
            <div className="lb-track"><div className="lb-fill" style={{ width: `${((r.avg || 0) / max) * 100}%` }} /></div>
            <span className="lb-v">{Math.round(r.avg || 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RevealPanel({ data }) {
  const it = data.item;
  if (!it) return <Waiting spin title="Preparing the reveal" />;
  const peer = (it.peer && it.peer.scores) || {};
  const ai = (it.ai && it.ai.scores) || {};
  const sum = (o) => AREAS.reduce((a, x) => a + (o[x.key] || 0), 0);
  return (
    <div className="reveal">
      <div className="rv-left">
        <div className="kicker light">Reviewed by Table {it.reviewingTable} | {it.scenario && it.scenario.title} | {data.number} of {data.count}</div>
        <div className="mail big">
          <div className="mail-row"><span className="mail-label">Subject</span><span className="mail-val">{it.subject || <em className="muted">(no subject)</em>}</span></div>
          <div className="mail-body pre">{it.body}</div>
        </div>
      </div>
      <div className="rv-right">
        <table className="cmp-t">
          <thead><tr><th>Area</th><th>Room</th><th>AI</th></tr></thead>
          <tbody>
            {AREAS.map((a) => {
              const p = peer[a.key];
              const q = ai[a.key];
              const gap = p != null && q != null && Math.abs(p - q) >= 2;
              return <tr key={a.key} className={gap ? 'gap' : ''}><td>{a.label}</td><td>{p ?? '-'}</td><td>{q ?? '-'}</td></tr>;
            })}
            <tr className="tot"><td>Total</td><td>{it.peer ? sum(peer) : '-'}</td><td>{it.ai ? (it.ai.total ?? sum(ai)) : '-'}</td></tr>
          </tbody>
        </table>
        <div className="rv-comments">
          <div className="rv-c"><div className="kicker light">Room: does well</div><p>{it.peer ? it.peer.doesWell : '-'}</p></div>
          <div className="rv-c ai"><div className="kicker light">AI: top strength</div><p>{it.ai && it.ai.strengths ? it.ai.strengths[0] : '-'}</p></div>
          <div className="rv-c"><div className="kicker light">Room: one fix</div><p>{it.peer ? it.peer.oneFix : '-'}</p></div>
          <div className="rv-c ai"><div className="kicker light">AI: top fix</div><p>{it.ai && it.ai.fixes ? it.ai.fixes[0] : '-'}</p></div>
        </div>
        {data.calibration && (
          <div className="calib">
            <div className="kicker light">Calibration (average gap to AI, lower is closer)</div>
            <div className="calib-row">{data.calibration.map((c) => <span key={c.number}>T{c.number}: <b>{c.gap.toFixed(1)}</b></span>)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================ FACILITATOR CONSOLE */

function ConsoleApp() {
  const [token, setToken] = useState(() => store.get('il_fac'));
  const [code, setCode] = useState((qs.get('code') || '').toUpperCase());
  const logout = () => { store.del('il_fac'); setToken(null); };

  if (!token) return <Login onToken={(t) => { store.set('il_fac', t); setToken(t); }} />;
  if (!code) return <SessionList token={token} onLogout={logout} onOpen={(c) => { setQuery({ view: 'console', code: c }); setCode(c); }} />;
  return <ConsoleLive token={token} code={code} onBack={() => { setQuery({ view: 'console', code: null }); setCode(''); }} onLogout={logout} />;
}

function Login({ onToken }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/api/login', { method: 'POST', body: { password: pw } }); onToken(r.token); } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  return (
    <div className="c-page center">
      <div className="card narrow">
        <Logos />
        <h1 className="h1">Facilitator console</h1>
        <form onSubmit={submit} className="form">
          <label>Password<input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
          {err && <div className="error">{err}</div>}
          <button className="btn accent block" disabled={!pw || busy}>{busy ? <Loader2 size={16} className="spin" /> : <Lock size={16} />} Sign in</button>
        </form>
      </div>
    </div>
  );
}

function SessionList({ token, onOpen, onLogout }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ client: 'Fatima Group', program: 'Campus to Corporate', date: new Date().toISOString().slice(0, 10), tableCount: 7, roundACount: 6 });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/api/sessions', { token }).then(setList).catch((e) => { setErr(e.message); if (/401|auth/i.test(e.message)) onLogout(); });
  }, [token, onLogout]);
  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/api/sessions', { method: 'POST', token, body: { ...form, tableCount: Number(form.tableCount), roundACount: Number(form.roundACount) } }); onOpen(r.code); } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  const remove = async (code) => {
    if (!window.confirm(`Delete session ${code} and all its data? This cannot be undone.`)) return;
    try { await api(`/api/sessions/${code}`, { method: 'DELETE', token }); load(); } catch (e2) { setErr(e2.message); }
  };
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="c-page">
      <header className="c-top dark">
        <Logos dark /><div className="c-title">Interactive Labs | Sessions</div>
        <button className="btn ghost sm" onClick={onLogout}><LogOut size={14} /> Sign out</button>
      </header>
      <div className="c-grid2">
        <div className="card">
          <h3>New session</h3>
          <form onSubmit={create} className="form">
            <label>Client<input className="input" value={form.client} onChange={f('client')} required /></label>
            <label>Program<input className="input" value={form.program} onChange={f('program')} required /></label>
            <label>Date<input className="input" type="date" value={form.date} onChange={f('date')} required /></label>
            <div className="row gap">
              <label className="grow">Tables<input className="input" type="number" min={2} max={20} value={form.tableCount} onChange={f('tableCount')} /></label>
              <label className="grow">Spot the Slip emails (1 to 6)<input className="input" type="number" min={1} max={6} value={form.roundACount} onChange={f('roundACount')} /></label>
            </div>
            {err && <div className="error">{err}</div>}
            <button className="btn accent block" disabled={busy}><Plus size={16} /> Create session</button>
          </form>
        </div>
        <div className="card">
          <h3>Sessions</h3>
          {!list ? (err ? <div className="error">{err}</div> : <Waiting spin title="Loading" />) : list.length === 0 ? <p className="muted">No sessions yet.</p> : (
            <table className="t">
              <thead><tr><th>Code</th><th>Client</th><th>Date</th><th>Joined</th><th /></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.code}>
                    <td><b>{s.code}</b></td><td>{s.client}<div className="muted small">{s.program}</div></td><td>{s.date}</td><td>{s.joined ?? 0}</td>
                    <td className="r">
                      <button className="btn sm" onClick={() => onOpen(s.code)}>Open</button>
                      <button className="btn ghost sm" onClick={() => remove(s.code)} title="Delete"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { key: 'live', label: 'Live' },
  { key: 'people', label: 'People' },
  { key: 'ai', label: 'AI scoring' },
  { key: 'review', label: 'Group review' },
  { key: 'showcase', label: 'Showcase' },
  { key: 'results', label: 'Results and export' },
];

function ConsoleLive({ token, code, onBack, onLogout }) {
  const auth = useMemo(() => ({ facToken: token }), [token]);
  const onConnect = useCallback((s) => {
    s.emit('console:watch', { code }, (res) => { if (res && res.error && /auth/i.test(res.error)) onLogout(); });
  }, [code, onLogout]);
  const { state, connected, emit, offsetRef } = useLive({ auth, onConnect });
  const [tab, setTab] = useState('live');
  const [toast, setToast] = useState('');

  const fac = useCallback(async (action, payload = {}) => {
    const res = await emit('fac', { action, ...payload });
    if (!res.ok) { setToast(res.error || 'Action failed'); setTimeout(() => setToast(''), 3500); }
    return res;
  }, [emit]);

  if (!state) return <div className="c-page center"><Waiting spin title="Connecting to session" /></div>;
  const { session = {}, step = {}, steps = [], cursor = 0, timer } = state;
  const meta = STEP_META[step.key] || {};
  const exp = (file) => `${API}/api/export/${code}/${file}?t=${encodeURIComponent(token)}`;

  return (
    <div className="c-page">
      <header className="c-top">
        <button className="btn ghost sm" onClick={onBack}><ChevronLeft size={14} /> Sessions</button>
        <div className="c-title">{session.client} | {session.program} | <b>{code}</b></div>
        <a className="btn ghost sm" href={`?view=screen&code=${code}`} target="_blank" rel="noreferrer"><Monitor size={14} /> Big screen</a>
        <a className="btn ghost sm" href={`?code=${code}`} target="_blank" rel="noreferrer"><Smartphone size={14} /> Phone view</a>
        <ConnDot connected={connected} />
      </header>

      <div className="c-control">
        <div className="c-step">
          <button className="btn ghost" disabled={cursor <= 0} onClick={() => fac('prev')}><ChevronLeft size={18} /></button>
          <div className="c-step-l">
            <div className="muted small">{meta.lab}</div>
            <div className="c-step-t">{meta.title}{step.total > 1 ? ` | ${(step.index || 0) + 1} of ${step.total}` : ''}</div>
          </div>
          <button className="btn accent" disabled={cursor >= steps.length - 1} onClick={() => fac('next')}>Next <ChevronRight size={18} /></button>
          <select className="input sm" value={cursor} onChange={(e) => { if (window.confirm('Jump to this step?')) fac('goto', { cursor: Number(e.target.value) }); }}>
            {steps.map((s, i) => <option key={i} value={i}>{i + 1}. {s.label}</option>)}
          </select>
        </div>
        <div className="c-timer">
          <Countdown timer={timer} offsetRef={offsetRef} className="lg" />
          {timer && timer.running && <button className="btn ghost sm" onClick={() => fac('timerPause')}><Pause size={14} /> Pause</button>}
          {timer && !timer.running && timer.remainingMs > 0 && <button className="btn sm" onClick={() => fac('timerStart')}><Play size={14} /> Resume</button>}
          {timer && (timer.running || timer.remainingMs > 0) && <button className="btn ghost sm" onClick={() => fac('timerAdd', { ms: 30000 })}><Plus size={14} /> 30s</button>}
          {timer && (timer.running || timer.remainingMs > 0) && <button className="btn ghost sm" onClick={() => fac('timerEnd')}><Square size={14} /> End now</button>}
          {timer && !timer.running && timer.remainingMs === 0 && <span className="badge ok"><Lock size={12} /> Time ended</span>}
        </div>
      </div>

      <nav className="c-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`c-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'ai' && (state.ai || []).some((a) => a.status === 'failed') && <span className="dot-alert" />}
          </button>
        ))}
      </nav>

      <div className="c-body">
        {tab === 'live' && <ConsoleLiveTab state={state} fac={fac} />}
        {tab === 'people' && <PeopleTab state={state} fac={fac} />}
        {tab === 'ai' && <AITab state={state} fac={fac} emit={emit} />}
        {tab === 'review' && <ReviewTab state={state} fac={fac} />}
        {tab === 'showcase' && <ShowcaseTab state={state} fac={fac} />}
        {tab === 'results' && <ResultsTab state={state} fac={fac} token={token} exp={exp} />}
      </div>
      {toast && <div className="toast"><AlertTriangle size={14} /> {toast}</div>}
    </div>
  );
}

function ConsoleLiveTab({ state, fac }) {
  const { step = {}, data = {}, participants = [] } = state;
  const connected = participants.filter((p) => p.connected).length;
  const stats = [
    ['Joined', participants.length],
    ['Connected', connected],
  ];
  if (data.submitted != null) stats.push(['Submitted', data.submitted]);
  if (data.answered != null) stats.push(['Answered', data.answered]);

  return (
    <div className="stack">
      <div className="stat-row">{stats.map(([l, v]) => <div key={l} className="stat"><div className="stat-v">{v}</div><div className="stat-l">{l}</div></div>)}</div>

      {step.key === 'a_reveal' && data.email && (
        <div className="card">
          <h3>Planted mistakes</h3>
          <p className="muted small">Tap Explain to highlight a mistake and show its explanation on the big screen.</p>
          <table className="t">
            <thead><tr><th>Segment</th><th>Type</th><th>Flagged</th><th /></tr></thead>
            <tbody>
              {data.email.segments.filter((s) => s.isMistake).map((s) => (
                <tr key={s.id} className={data.explainId === s.id ? 'sel' : ''}>
                  <td>{s.text || '(no subject)'}</td><td>{s.mistakeType}</td><td>{Math.round((data.heat || {})[s.id] || 0)}%</td>
                  <td className="r">
                    {data.explainId === s.id
                      ? <button className="btn ghost sm" onClick={() => fac('explain', { segmentId: null })}><EyeOff size={14} /> Hide</button>
                      : <button className="btn sm" onClick={() => fac('explain', { segmentId: s.id })}><Eye size={14} /> Explain</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {step.key === 'b_reveal' && data.counts && (
        <div className="card">
          <h3>Room split</h3>
          <div className="row gap wrap">{CHANNELS.map((c) => <span key={c.key} className="chip">{c.label}: <b>{data.counts[c.key] || 0}</b></span>)}</div>
        </div>
      )}

      {step.key === 'lab1_debrief' && <div className="card"><h3>Leaderboard</h3><SmallLeaderboard rows={data.leaderboard || []} /></div>}

      {step.key === 'review_select' && <div className="card"><p>Check the selection in the <b>Group review</b> tab, then press Next to release emails to tables.</p></div>}

      {step.key === 'review' && (
        <div className="card"><h3>Table submissions</h3>
          <div className="row gap wrap">{(data.tables || []).map((t) => <span key={t.number} className={`chip ${t.submitted ? 'ok' : ''}`}>{t.submitted ? <Check size={12} /> : <Loader2 size={12} className="spin" />} Table {t.number}</span>)}</div>
        </div>
      )}

      {step.key === 'reveal' && data.item && (
        <div className="card"><h3>Reveal {data.number} of {data.count}</h3>
          <p className="muted">Reviewed by Table {data.item.reviewingTable}. Press Next for the following email.</p>
          <div className="row gap wrap">
            {AREAS.map((a) => {
              const p = data.item.peer && data.item.peer.scores[a.key];
              const q = data.item.ai && data.item.ai.scores[a.key];
              const gap = p != null && q != null && Math.abs(p - q) >= 2;
              return <span key={a.key} className={`chip ${gap ? 'bad' : ''}`}>{a.short}: {p ?? '-'} vs {q ?? '-'}</span>;
            })}
          </div>
        </div>
      )}

      {step.key === 'reports' && state.reports && (
        <div className="card"><h3>Reports</h3><p>{state.reports.released} of {state.reports.total} released to phones.</p></div>
      )}
    </div>
  );
}

function SmallLeaderboard({ rows }) {
  return (
    <table className="t">
      <thead><tr><th>#</th><th>Table</th><th>Average</th><th>Members</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.number}><td>{i + 1}</td><td>Table {r.number}</td><td>{Math.round(r.avg || 0)}</td><td>{r.count}</td></tr>)}</tbody>
    </table>
  );
}

function PeopleTab({ state, fac }) {
  const { tables = [], participants = [] } = state;
  return (
    <div className="tables-grid">
      {tables.map((t) => {
        const members = participants.filter((p) => p.tableNumber === t.number);
        return (
          <div key={t.number} className="card">
            <div className="row between"><h3>Table {t.number}</h3><span className="muted small">{members.length} members</span></div>
            <label className="lbl small">Captain
              <select className="input sm" value={t.captainId || ''} onChange={(e) => fac('setCaptain', { tableNumber: t.number, participantId: e.target.value || null })}>
                <option value="">None</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <ul className="people">
              {members.map((m) => (
                <li key={m.id}>
                  <span className={`pdot ${m.connected ? 'on' : ''}`} />
                  <span className="grow">{m.name}{m.id === t.captainId && <Crown size={12} className="cap-ic" />}</span>
                  <span className="muted small">{m.lab1Points ?? 0} pts</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function AITab({ state, fac, emit }) {
  const list = state.ai || [];
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const counts = list.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});

  const open = async (emailId) => {
    setLoading(true);
    const res = await emit('fac', { action: 'getAI', emailId });
    setLoading(false);
    if (res.ok) setDetail({ emailId, ...res });
  };

  return (
    <div className="stack">
      <div className="stat-row">
        {['pending', 'scoring', 'done', 'failed'].map((k) => <div key={k} className={`stat ${k === 'failed' && counts[k] ? 'bad' : ''}`}><div className="stat-v">{counts[k] || 0}</div><div className="stat-l">{k}</div></div>)}
        {counts.failed > 0 && <button className="btn sm" onClick={() => fac('retryAllAI')}><RefreshCw size={14} /> Retry all failed</button>}
      </div>
      <div className="card">
        <table className="t">
          <thead><tr><th>Participant</th><th>Table</th><th>Email</th><th>Scenario</th><th>Status</th><th>Total</th><th /></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.emailId}>
                <td>{a.participantName}</td><td>{a.tableNumber}</td><td>{a.slot + 1}</td><td>{a.scenarioTitle}</td>
                <td><span className={`badge ${a.status === 'done' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'}`}>{a.status}{a.overridden ? ' (edited)' : ''}</span></td>
                <td>{a.total ?? '-'}</td>
                <td className="r">
                  {a.status === 'failed' && <button className="btn sm" onClick={() => fac('retryAI', { emailId: a.emailId })}><RefreshCw size={14} /> Retry</button>}
                  {a.status === 'done' && <button className="btn ghost sm" disabled={loading} onClick={() => open(a.emailId)}><Eye size={14} /> View</button>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={7} className="muted">No Lab 2 emails yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {detail && <AIDetail detail={detail} onClose={() => setDetail(null)} fac={fac} />}
    </div>
  );
}

function AIDetail({ detail, onClose, fac }) {
  const ai = detail.ai || {};
  const [scores, setScores] = useState({ ...(ai.scores || {}) });
  const [saving, setSaving] = useState(false);
  const changed = AREAS.some((a) => scores[a.key] !== (ai.scores || {})[a.key]);
  const save = async () => {
    setSaving(true);
    const r = await fac('overrideAI', { emailId: detail.emailId, scores });
    setSaving(false);
    if (r.ok) onClose();
  };
  return (
    <Modal onClose={onClose} wide>
      <div className="kicker">{detail.scenario && detail.scenario.title}</div>
      <div className="c-grid2">
        <div>
          <div className="mail">
            <div className="mail-row"><span className="mail-label">Subject</span><span className="mail-val">{detail.email && detail.email.subject}</span></div>
            <div className="mail-body pre">{detail.email && detail.email.body}</div>
          </div>
          {ai.polished_rewrite && (
            <div className="card flat mt">
              <div className="kicker">Polished rewrite</div>
              <p><b>{ai.polished_rewrite.subject}</b></p>
              <p className="pre">{ai.polished_rewrite.body}</p>
            </div>
          )}
        </div>
        <div>
          <p className="rep-headline sm">{ai.one_line_summary}</p>
          {AREAS.map((a) => (
            <div key={a.key} className="score-row"><span>{a.label}</span><ScorePicker value={scores[a.key]} onChange={(n) => setScores({ ...scores, [a.key]: n })} /></div>
          ))}
          <div className="kicker mt">Strengths</div><ul className="bul">{(ai.strengths || []).map((s, i) => <li key={i}>{s}</li>)}</ul>
          <div className="kicker">Fixes</div><ul className="bul">{(ai.fixes || []).map((s, i) => <li key={i}>{s}</li>)}</ul>
          <div className="kicker">Missing elements</div><ul className="bul">{(ai.missing_elements || []).map((s, i) => <li key={i}>{s}</li>)}</ul>
          <button className="btn accent block" disabled={!changed || saving} onClick={save}><Pencil size={14} /> Save override</button>
          <p className="muted small">Overrides are logged.</p>
        </div>
      </div>
    </Modal>
  );
}

function ReviewTab({ state, fac }) {
  const sel = state.reviewSelection || [];
  const cands = state.reviewCandidates || [];
  const isSelect = state.step && state.step.key === 'review_select';
  const submitted = new Set(state.reviewSubmitted || []);
  return (
    <div className="stack">
      {!sel.length ? <div className="card"><p className="muted">The selection is made when you reach the Group review step.</p></div> : (
        <div className="card">
          <div className="row between"><h3>Emails for group review</h3>{isSelect && <button className="btn accent sm" onClick={() => fac('next')}><Send size={14} /> Release to tables</button>}</div>
          <table className="t">
            <thead><tr><th>Reviewing table</th><th>Email from</th><th>Scenario</th><th>Subject</th><th>Swap</th><th>Status</th></tr></thead>
            <tbody>
              {sel.map((r) => (
                <tr key={r.tableNumber}>
                  <td>Table {r.tableNumber}</td><td>Table {r.writerTable}</td><td>{r.scenarioTitle}</td><td>{r.subject || <em className="muted">(none)</em>}</td>
                  <td>
                    <select className="input sm" value={r.emailId} disabled={!isSelect} onChange={(e) => fac('swapReview', { tableNumber: r.tableNumber, emailId: e.target.value })}>
                      <option value={r.emailId}>Current</option>
                      {cands.filter((c) => c.writerTable !== r.tableNumber && c.emailId !== r.emailId).map((c) => (
                        <option key={c.emailId} value={c.emailId}>T{c.writerTable} | {c.scenarioTitle} | {c.words}w</option>
                      ))}
                    </select>
                  </td>
                  <td>{submitted.has(r.tableNumber) ? <span className="badge ok">Submitted</span> : <span className="badge warn">Waiting</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ShowcaseTab({ state, fac }) {
  const sc = state.showcase || {};
  const cands = sc.candidates || [];
  return (
    <div className="card">
      <div className="row between">
        <h3>Showcase (up to two, anonymous)</h3>
        {sc.liveEmailId && <button className="btn ghost sm" onClick={() => fac('showcaseHide')}><EyeOff size={14} /> Hide from screen</button>}
      </div>
      <p className="muted small">Highest AI totals first. The writer is asked on their phone before anything is shown.</p>
      <table className="t">
        <thead><tr><th>Total</th><th>Scenario</th><th>Table</th><th>Consent</th><th /></tr></thead>
        <tbody>
          {cands.map((c) => (
            <tr key={c.emailId} className={sc.liveEmailId === c.emailId ? 'sel' : ''}>
              <td><b>{c.total}</b></td><td>{c.scenarioTitle}</td><td>{c.tableNumber}</td>
              <td><span className={`badge ${c.consent === 'accepted' ? 'ok' : c.consent === 'declined' ? 'bad' : c.consent === 'asked' ? 'warn' : ''}`}>{c.consent}</span></td>
              <td className="r">
                {c.consent === 'none' && <button className="btn sm" onClick={() => fac('showcaseAsk', { emailId: c.emailId })}><Send size={14} /> Ask writer</button>}
                {c.consent === 'accepted' && sc.liveEmailId !== c.emailId && <button className="btn accent sm" onClick={() => fac('showcaseShow', { emailId: c.emailId })}><Monitor size={14} /> Show</button>}
              </td>
            </tr>
          ))}
          {cands.length === 0 && <tr><td colSpan={5} className="muted">Available once Lab 2 emails are scored.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ResultsTab({ state, fac, token, exp }) {
  const ps = state.participants || [];
  const rep = state.reports || {};
  return (
    <div className="stack">
      <div className="card">
        <div className="row between wrap gap">
          <h3>Reports</h3>
          <div className="row gap wrap">
            <span className="muted small">{rep.generated || 0} generated | {rep.released || 0} released of {rep.total || ps.length}</span>
            <button className="btn accent sm" onClick={() => { if (window.confirm('Generate and release reports to all phones?')) fac('releaseReports'); }}><Send size={14} /> Release reports</button>
          </div>
        </div>
        <div className="row gap wrap mt">
          <a className="btn ghost sm" href={exp('cohort.pdf')} target="_blank" rel="noreferrer"><FileText size={14} /> Cohort report PDF</a>
          <a className="btn ghost sm" href={exp('cohort.csv')}><Download size={14} /> Cohort CSV</a>
          <a className="btn ghost sm" href={exp('scores.csv')}><Download size={14} /> All scores CSV</a>
          <a className="btn ghost sm" href={exp('reports.zip')}><Download size={14} /> All reports ZIP</a>
          <a className="btn ghost sm" href={exp('round-a')} target="_blank" rel="noreferrer"><FileText size={14} /> Printable Spot the Slip</a>
        </div>
      </div>
      <div className="card">
        <table className="t">
          <thead><tr><th>Name</th><th>Table</th><th>Lab 1</th><th>Lab 2 avg</th>{AREAS.map((a) => <th key={a.key} title={a.label}>{a.short}</th>)}<th>Report</th></tr></thead>
          <tbody>
            {ps.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>{p.tableNumber}</td><td>{p.lab1Points ?? '-'}</td><td>{p.lab2Avg ?? '-'}</td>
                {AREAS.map((a) => <td key={a.key}>{p.areas && p.areas[a.key] != null ? p.areas[a.key] : '-'}</td>)}
                <td className="r">
                  {p.reportStatus === 'ready' || p.reportStatus === 'released'
                    ? <a className="btn ghost sm" href={`${API}/api/report/${p.id}.pdf?t=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer"><FileText size={14} /> PDF</a>
                    : <span className="muted small">{p.reportStatus || 'not ready'}</span>}
                  <button className="btn ghost sm" title="Regenerate" onClick={() => fac('regenerateReport', { participantId: p.id })}><RefreshCw size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================================================================ ROOT */

export default function App() {
  return (
    <>
      <style>{CSS}</style>
      {VIEW === 'screen' ? <ScreenApp /> : VIEW === 'console' ? <ConsoleApp /> : <ParticipantApp />}
    </>
  );
}

/* ================================================================ STYLES */

const CSS = `
:root{
  --ink:#282547;--ink2:#36325E;--ink3:#3A3566;
  --accent:#BC1823;--accent-d:#961219;--accent-soft:#FCE9EA;
  --orange:#FF7C00;--orange-d:#E06D00;--orange-soft:#FFF2E5;
  --bg:#F4F5F8;--card:#FFFFFF;--line:#E4E7EC;--muted:#667085;--text:#101828;
  --ok:#15803D;--ok-soft:#E7F6EC;--warn:#B45309;--warn-soft:#FEF3E2;--bad:#B42318;--bad-soft:#FDECEC;
  --r:14px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;font-size:15px;line-height:1.45}
h1,h2,h3{margin:0 0 8px;line-height:1.2;letter-spacing:-.01em}
h2{font-size:20px}h3{font-size:16px}
p{margin:0 0 8px}
a{color:inherit}
button,input,select,textarea{font:inherit;color:inherit}
.muted{color:var(--muted)}.small{font-size:13px}.mt{margin-top:12px}
.row{display:flex;align-items:center}.gap{gap:10px}.wrap{flex-wrap:wrap}.between{justify-content:space-between}.grow{flex:1}
.stack{display:flex;flex-direction:column;gap:14px}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center}
.center-t{text-align:center}.center-self{align-self:center}.r{text-align:right;white-space:nowrap}
.pre{white-space:pre-wrap}
.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid transparent;border-radius:10px;padding:11px 16px;font-weight:600;background:var(--ink);color:#fff;cursor:pointer;text-decoration:none;transition:background .15s,opacity .15s;-webkit-tap-highlight-color:transparent}
.btn:hover{background:var(--ink2)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.accent{background:var(--accent)}.btn.accent:hover{background:var(--accent-d)}
.btn.ghost{background:#fff;color:var(--ink);border-color:var(--line)}.btn.ghost:hover{background:#F9FAFB}
.btn.sm{padding:6px 10px;font-size:13px;border-radius:8px}
.btn.block{width:100%}
.btn+.btn{margin-left:6px}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px}
.card.flat{background:#F9FAFB}
.card.narrow{width:100%;max-width:400px}
.input{width:100%;padding:11px 12px;border:1px solid #D0D5DD;border-radius:10px;background:#FCFCFD;outline:none}
.input:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(40,37,71,.08)}
.input.sm{padding:6px 8px;font-size:13px;width:auto;min-width:120px}
.input.code{text-align:center;letter-spacing:.3em;font-size:24px;font-weight:700;margin:10px 0}
.form{display:flex;flex-direction:column;gap:12px;margin-top:10px}
.form label,.lbl{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:14px}
.lbl{margin-top:10px}
.check{flex-direction:row!important;align-items:flex-start;gap:10px!important;font-weight:400!important;font-size:13px!important;color:var(--muted)}
.check input{margin-top:3px;width:18px;height:18px;flex-shrink:0}
.error{background:var(--bad-soft);color:var(--bad);padding:10px 12px;border-radius:10px;font-size:14px}
.h1{font-size:24px;margin:8px 0}
.kicker{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin-bottom:4px;display:flex;align-items:center;gap:6px}
.kicker.light{color:#FFB066}
.key{font-size:11.5px;color:var(--muted);background:#F9FAFB;border-left:3px solid var(--line);padding:6px 10px;border-radius:4px;margin-top:8px}

.badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:4px 9px;border-radius:999px;background:#F2F4F7;color:var(--muted)}
.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.warn{background:var(--warn-soft);color:var(--warn)}.badge.bad{background:var(--bad-soft);color:var(--bad)}
.badge.cap{background:#FFF4D6;color:#8A6100;margin-left:8px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;background:#F2F4F7;font-size:13px}
.chip.ok{background:var(--ok-soft);color:var(--ok);font-weight:600}.chip.bad{background:var(--bad-soft);color:var(--bad)}

.logos{display:flex;align-items:center;gap:14px}
.logos img{height:30px;width:auto;object-fit:contain}
.card>.logos{justify-content:center;margin:2px 0 12px}
.card>.logos img{height:58px}
.card>.h1,.card>.kicker,.card.narrow>.muted{text-align:center;justify-content:center}
.logos.dark img{height:34px}

.waiting{display:flex;flex-direction:column;align-items:center;text-align:center;padding:36px 12px;gap:6px}
.waiting-icon{width:60px;height:60px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;margin-bottom:8px}
.waiting-icon.spin svg{animation:spin 1s linear infinite}
.waiting p{color:var(--muted);max-width:360px}

.conn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%}
.conn.on{color:var(--ok)}.conn.off{color:var(--bad);background:var(--bad-soft)}
.countdown{display:inline-flex;align-items:center;gap:5px;font-weight:700;font-variant-numeric:tabular-nums;padding:5px 10px;border-radius:999px;background:var(--ink);color:#fff;font-size:14px}
.countdown.low{background:var(--accent)}
.countdown.paused{background:#98A2B3}
.countdown.lg{font-size:20px;padding:7px 14px}
.countdown,.countdown svg{flex-shrink:0;white-space:nowrap}
.c-control .countdown{background:rgba(255,255,255,.12)}
.c-control .countdown.low{background:var(--accent)}
.countdown.xl{font-size:34px;padding:8px 20px}

.modal-back{position:fixed;inset:0;background:rgba(16,24,40,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
.modal{background:#fff;border-radius:18px;padding:24px;max-width:420px;width:100%;position:relative;max-height:90vh;overflow:auto;text-align:center}
.modal.wide{max-width:980px;text-align:left}
.modal-x{position:absolute;top:12px;right:12px;border:0;background:#F2F4F7;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.modal-icon{width:56px;height:56px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 12px}
.modal .row{justify-content:center;margin-top:16px}
.quote{font-style:italic;margin:8px 0}

/* participant */
.p-shell{min-height:100vh}
.p-top{position:sticky;top:0;z-index:10;background:var(--ink);color:#fff;border-bottom:3px solid var(--orange);display:flex;align-items:center;justify-content:space-between;padding:10px 14px;gap:10px}
.p-name{font-weight:700;display:flex;align-items:center;font-size:15px}
.p-sub{font-size:12px;color:rgba(255,255,255,.7)}
.p-top .countdown{background:rgba(255,255,255,.14)}
.p-top .countdown.low{background:var(--accent)}
.p-right{display:flex;align-items:center;gap:8px}
.pts{display:inline-flex;align-items:center;gap:4px;font-weight:700;font-size:13px;color:#FFB066}
.p-wrap{max-width:560px;margin:0 auto;padding:16px 14px 90px}
.p-wrap.center{padding:16px}
.step-head h2{font-size:18px}
.situation{font-size:20px!important;line-height:1.35}
.sticky-bar{position:sticky;bottom:12px;display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 12px;box-shadow:0 8px 24px rgba(16,24,40,.08)}

/* email client */
.mail{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;color:var(--text)}
.mail-top{display:flex;align-items:center;gap:6px;padding:9px 12px;background:#F2F4F7;border-bottom:1px solid var(--line)}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}.dot.r{background:#F97066}.dot.y{background:#FDB022}.dot.g{background:#32D583}
.mail-title{font-size:12px;color:var(--muted);margin-left:8px;font-weight:600}
.mail-row{display:flex;align-items:baseline;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line);font-size:14px}
.mail-row.attach{align-items:center;color:var(--muted)}
.att-chip{background:#EEF4FF;color:#3538CD;padding:3px 9px;border-radius:6px;font-size:12px;font-weight:600}
.mail-label{width:58px;flex-shrink:0;color:var(--muted);font-size:13px}
.mail-val{flex:1;min-width:0}
.mail-body{padding:14px;line-height:1.75;font-size:15px}
.mail-body .br{display:block;height:6px}
.signoff{margin-top:12px}
.mail.big .mail-row{font-size:19px;padding:12px 20px}
.mail.big .mail-label{width:90px;font-size:16px}
.mail.big .mail-body{font-size:22px;padding:20px;line-height:1.7}
.seg{border-radius:6px;padding:2px 4px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.seg.tap{cursor:pointer;background:#F2F4F7;-webkit-tap-highlight-color:transparent;user-select:none}
.seg.flagged{background:var(--accent-soft);box-shadow:inset 0 0 0 2px var(--accent);color:var(--accent-d)}
.seg.caught{background:var(--ok-soft);box-shadow:inset 0 0 0 2px var(--ok)}
.seg.missed{background:var(--warn-soft);outline:2px dashed var(--warn);outline-offset:-1px}
.seg.wrong{background:var(--bad-soft);text-decoration:line-through;text-decoration-color:var(--bad)}
.seg.clickable{cursor:pointer}
.seg.heat{color:var(--text)}
.seg.planted{outline:2px dashed var(--ink);outline-offset:1px}
.seg.explaining{outline:3px solid var(--accent);outline-offset:2px}
.heat-pct{font-size:.6em;font-weight:700;margin-left:3px;color:var(--ink)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:6px}
.lgd{width:14px;height:14px;border-radius:4px;display:inline-block}
.lgd.caught{background:var(--ok-soft);box-shadow:inset 0 0 0 2px var(--ok)}
.lgd.missed{background:var(--warn-soft);outline:2px dashed var(--warn);outline-offset:-2px}
.lgd.wrong{background:var(--bad-soft)}

.result-card{display:flex;justify-content:space-around;background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:16px;text-align:center;gap:10px}
.big-num{font-size:30px;font-weight:800;color:var(--ink)}.big-num span{font-size:16px;color:var(--muted);font-weight:600}

.channels{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.chan{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:120px;border-radius:16px;border:2px solid var(--line);background:#fff;font-weight:700;font-size:16px;cursor:pointer;color:var(--ink);transition:.12s;-webkit-tap-highlight-color:transparent}
.chan:active{transform:scale(.98)}
.chan.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-d)}
.chan:disabled{opacity:.4}
.verdict{border-radius:var(--r);padding:16px;display:flex;justify-content:space-between;align-items:center}
.verdict.ok{background:var(--ok-soft);color:var(--ok)}.verdict.warn{background:var(--warn-soft);color:var(--warn)}.verdict.bad{background:var(--bad-soft);color:var(--bad)}
.v-t{font-size:20px;font-weight:800}.v-p{font-weight:700}
.best-row{display:flex;gap:8px;flex-wrap:wrap}

.scenario{background:var(--ink);color:#fff;border-radius:var(--r);padding:16px}
.scenario .kicker{color:#FFB066}
.scenario p{color:#E6E9F0;margin-bottom:6px}
.sc-role b{color:#fff}
.compose{background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.c-row{display:flex;align-items:center;border-bottom:1px solid var(--line);padding:0 12px}
.c-l{width:62px;color:var(--muted);font-size:13px;flex-shrink:0}
.c-v.ro{padding:12px 0;color:var(--text);font-size:14px}
.c-in{flex:1;border:0;outline:none;padding:12px 0;background:transparent;font-size:15px}
.c-body{width:100%;border:0;outline:none;padding:12px;resize:vertical;min-height:240px;font-size:16px;line-height:1.55;display:block}
.c-foot{display:flex;justify-content:space-between;padding:8px 12px;border-top:1px solid var(--line);background:#F9FAFB}

.score-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
.picker{display:flex;gap:5px}
.pick{width:36px;height:36px;border-radius:9px;border:1px solid var(--line);background:#fff;font-weight:700;cursor:pointer}
.pick.on{background:var(--accent);border-color:var(--accent);color:#fff}

/* report */
.report{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:18px;display:flex;flex-direction:column;gap:12px}
.rep-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;border-bottom:3px solid var(--accent);padding-bottom:12px}
.rep-kicker{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.rep-headline{font-size:17px;font-weight:600;color:var(--ink);margin:0}
.rep-headline.sm{font-size:15px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tile{background:var(--ink);color:#fff;border-radius:12px;padding:12px 8px;text-align:center}
.tile-v{font-size:24px;font-weight:800}.tile-v span{font-size:13px;opacity:.7}
.tile-l{font-size:11px;opacity:.85;margin-top:2px}
.rep-sec h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink);margin-bottom:6px}
.rep-sec.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.profile{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.profile svg{display:block;margin:0 auto}
.area-list{list-style:none;padding:0;margin:0;flex:1;min-width:160px}
.area-list li{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line);font-size:13px}
.line{font-size:14px;margin-bottom:4px}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cmp{background:#F9FAFB;border-radius:10px;padding:10px;font-size:13px}
.cmp.better{background:var(--ok-soft)}
.cmp-l{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.cmp-s{font-weight:700;margin-bottom:4px}
.cmp-b{white-space:pre-wrap}
.bul{margin:0;padding-left:18px;font-size:14px}.bul li{margin-bottom:4px}
.rep-sec.peer{background:#FFF8EB;border-radius:10px;padding:10px}
.lab-band{background:var(--ink);color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.lvl{padding:6px 0;border-bottom:1px dashed var(--line)}
.lvl-top{display:flex;justify-content:space-between;gap:10px;font-size:13px}
.lvl-track{height:7px;border-radius:4px;background:#EEF0F4;margin-top:5px;overflow:hidden}
.lvl-fill{height:100%;background:var(--ink);border-radius:4px}
.ch-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ch-table th{text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:4px 4px;border-bottom:1px solid var(--line)}
.ch-table td{padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
.em-card{border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px}
.em-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px}
.em-total{font-size:24px;font-weight:800;color:var(--ink)}.em-total span{font-size:13px;color:var(--muted);font-weight:600}
.chips{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-bottom:8px}
.chip-s{background:#F4F5F8;border-radius:6px;padding:4px 2px;text-align:center;display:flex;flex-direction:column}
.chip-s span{font-size:9.5px;color:var(--muted)}.chip-s b{font-size:14px;color:var(--ink)}
.rep-foot{text-align:center;font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px}
@media(max-width:420px){.compare,.rep-sec.two{grid-template-columns:1fr}}

/* big screen */
.screen{min-height:100vh;background:radial-gradient(1200px 600px at 80% -10%,#36325E 0%,#1E1C38 60%);color:#fff;display:flex;flex-direction:column}
.screen .card{color:var(--text)}
.s-top{display:flex;align-items:center;gap:24px;padding:16px 32px;background:var(--ink);color:#fff;border-bottom:4px solid var(--orange)}
.s-top .countdown{background:rgba(255,255,255,.12)}
.s-top .countdown.low{background:var(--accent)}
.s-title{flex:1}
.s-lab{font-size:15px;color:#FFB066;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.s-step{font-size:28px;font-weight:800}
.s-right{display:flex;align-items:center;gap:12px}
.s-main{flex:1;padding:28px 32px;display:flex}
.s-main>*{flex:1}
.s-h1{font-size:44px;font-weight:800;display:flex;align-items:center;gap:14px;justify-content:center}
.s-h2{font-size:28px}
.s-p{font-size:22px;color:#C9D0DE}
.s-p.small{font-size:17px}
.center-col{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px;max-width:1300px;margin:0 auto}
.center-col.wide{width:100%}
.accent-ic{color:#FFB066}
.lobby{display:grid;grid-template-columns:auto 1fr;gap:40px;align-items:start}
.qr-card{background:#fff;color:var(--ink);border-radius:20px;padding:20px;text-align:center}
.qr-code{font-size:46px;font-weight:800;letter-spacing:.2em;margin-top:6px}
.qr-url{font-size:15px;color:var(--muted)}
.lobby-right .s-h1{justify-content:flex-start}
.tables{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:18px}
.tbl{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:12px}
.tbl-h{display:flex;justify-content:space-between;font-weight:800;font-size:17px;margin-bottom:6px;color:#FFB066}
.tbl-h span{background:rgba(255,255,255,.12);color:#fff;border-radius:999px;padding:0 9px;font-size:14px}
.tbl-n{font-size:16px;padding:2px 0;color:#E6E9F0}
.split{display:grid;grid-template-columns:1fr 380px;gap:28px;align-items:start}
.split-side{display:flex;flex-direction:column;gap:14px}
.heat-key{display:flex;align-items:center;gap:10px;font-size:14px}
.heat-key i{flex:1;height:12px;border-radius:6px;background:linear-gradient(90deg,rgba(188,24,35,.06),rgba(188,24,35,.8))}
.explain{background:#fff;color:var(--text);border-radius:16px;padding:18px;font-size:19px}
.explain .kicker{color:var(--accent)}
.ex-q{font-style:italic;font-size:20px;margin-bottom:8px;color:var(--ink)}
.s-situation{font-size:46px;line-height:1.25;font-weight:800;max-width:1100px}
.s-situation.sm{font-size:32px}
.chan-row{display:flex;gap:18px}
.chan-s{display:flex;flex-direction:column;align-items:center;gap:8px;padding:18px 26px;border-radius:16px;background:rgba(255,255,255,.07);font-weight:700;font-size:18px}
.progress{display:flex;flex-direction:column;align-items:center;gap:8px;width:420px;max-width:100%}
.pr-n{font-size:40px;font-weight:800}.pr-n span{font-size:22px;opacity:.6}
.pr-track{width:100%;height:12px;border-radius:6px;background:rgba(255,255,255,.12);overflow:hidden}
.pr-fill{height:100%;background:var(--accent);transition:width .4s}
.pr-l{color:#C9D0DE;font-size:16px}
.split-side .progress{align-items:flex-start;width:100%}
.bars{display:flex;gap:28px;align-items:flex-end;height:380px;margin-top:10px}
.bar{display:flex;flex-direction:column;align-items:center;gap:8px;width:150px;height:100%}
.bar-pct{font-size:28px;font-weight:800}
.bar-track{flex:1;width:100%;background:rgba(255,255,255,.06);border-radius:12px;display:flex;align-items:flex-end;overflow:hidden}
.bar-fill{width:100%;background:#98A2B3;border-radius:12px 12px 0 0;transition:height .6s}
.bar.best .bar-fill{background:#32D583}.bar.acc .bar-fill{background:#FDB022}
.bar-l{display:flex;align-items:center;gap:6px;font-weight:700;font-size:18px}
.bar-tag{font-size:13px;font-weight:800;text-transform:uppercase;background:#32D583;color:#053321;padding:3px 10px;border-radius:999px}
.bar-tag.acc{background:#FDB022;color:#4E2C00}
.s-explain{font-size:24px;max-width:1000px;color:#E6E9F0}
.lb{width:100%;max-width:1000px;display:flex;flex-direction:column;gap:10px}
.lb-row{display:grid;grid-template-columns:50px 140px 1fr 80px;align-items:center;gap:14px;font-size:22px;font-weight:700;background:rgba(255,255,255,.05);padding:12px 18px;border-radius:14px}
.lb-row.top{background:rgba(188,24,35,.25)}
.lb-rank{color:#FFB066}
.lb-track{height:16px;background:rgba(255,255,255,.1);border-radius:8px;overflow:hidden}
.lb-fill{height:100%;background:var(--accent);transition:width .6s}
.lb-v{text-align:right}
.tbl-status{display:flex;flex-wrap:wrap;gap:14px;justify-content:center}
.ts{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:700;padding:16px 22px;border-radius:14px;background:rgba(255,255,255,.07)}
.ts.done{background:rgba(50,213,131,.18);color:#6CE9A6}
.reveal{display:grid;grid-template-columns:1.1fr 1fr;gap:28px;align-items:start}
.rv-left{display:flex;flex-direction:column;gap:10px}
.cmp-t{width:100%;border-collapse:collapse;font-size:18px;background:rgba(255,255,255,.05);border-radius:14px;overflow:hidden}
.cmp-t th{text-align:left;padding:10px 14px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#FFB066}
.cmp-t td{padding:7px 14px;border-top:1px solid rgba(255,255,255,.08)}
.cmp-t td:nth-child(2),.cmp-t td:nth-child(3),.cmp-t th:nth-child(2),.cmp-t th:nth-child(3){text-align:center;width:90px;font-weight:800}
.cmp-t tr.gap td{background:rgba(253,176,34,.22)}
.cmp-t tr.tot td{font-weight:800;border-top:2px solid rgba(255,255,255,.2)}
.rv-comments{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.rv-c{background:rgba(255,255,255,.06);border-radius:12px;padding:10px 12px;font-size:15px}
.rv-c.ai{background:rgba(188,24,35,.18)}
.calib{margin-top:10px}.calib-row{display:flex;gap:16px;flex-wrap:wrap;font-size:17px}
.showcase{position:fixed;inset:0;background:rgba(10,17,33,.92);display:flex;align-items:center;justify-content:center;padding:40px;z-index:40}
.showcase-in{max-width:1100px;width:100%}

/* big screen, light theme (?view=screen&code=XXXX&theme=light) for bright rooms */
.screen.light{background:#F4F5F8;color:var(--ink)}
.screen.light .s-p,.screen.light .pr-l,.screen.light .s-explain{color:#475467}
.screen.light .kicker.light,.screen.light .accent-ic,.screen.light .lb-rank,.screen.light .tbl-h,.screen.light .cmp-t th{color:var(--accent)}
.screen.light .qr-card,.screen.light .mail{box-shadow:0 10px 30px rgba(40,37,71,.08);border:1px solid var(--line)}
.screen.light .tbl,.screen.light .chan-s,.screen.light .ts,.screen.light .lb-row,.screen.light .rv-c{background:#fff;border:1px solid var(--line)}
.screen.light .tbl-h span{background:var(--accent-soft);color:var(--accent)}
.screen.light .tbl-n{color:var(--text)}
.screen.light .pr-track,.screen.light .lb-track{background:#E4E7EC}
.screen.light .bar-track{background:#E9EBF0}
.screen.light .lb-row.top{background:var(--accent-soft);border-color:#F4C7CA}
.screen.light .ts.done{background:var(--ok-soft);color:var(--ok);border-color:#B7E4C7}
.screen.light .cmp-t{background:#fff;border:1px solid var(--line)}
.screen.light .cmp-t td{border-top:1px solid var(--line)}
.screen.light .cmp-t tr.gap td{background:#FEF0C7}
.screen.light .cmp-t tr.tot td{border-top:2px solid #D0D5DD}
.screen.light .rv-c.ai{background:var(--accent-soft);border-color:#F4C7CA}
.screen.light .explain{border:1px solid var(--line);box-shadow:0 10px 30px rgba(40,37,71,.08)}
.screen.light .bar-tag{color:#053321}

/* console */
.c-page{min-height:100vh;background:var(--bg)}
.c-top{display:flex;align-items:center;gap:10px;padding:12px 20px;background:var(--ink);color:#fff;border-bottom:3px solid var(--orange);flex-wrap:wrap}
.c-top .btn.ghost{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.2)}
.c-title{flex:1;font-weight:600;min-width:200px}
.c-top.dark{background:var(--ink);color:#fff}
.c-control{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;background:var(--ink2);color:#fff;flex-wrap:wrap}
.c-step{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.c-step .btn.ghost{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.15)}
.c-step-l .muted{color:#C9D0DE}
.c-step-t{font-size:20px;font-weight:800}
.c-step .input.sm{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.15)}
.c-step .input.sm option{color:var(--text)}
.c-timer{display:flex;align-items:center;gap:8px}
.c-timer .btn.ghost{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.15)}
.c-timer .btn:not(.ghost){background:var(--accent)}
.c-tabs{display:flex;gap:4px;padding:0 20px;background:#fff;border-bottom:1px solid var(--line);overflow-x:auto}
.c-tab{border:0;background:none;padding:13px 14px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;position:relative;white-space:nowrap}
.c-tab.on{color:var(--ink);border-bottom-color:var(--accent)}
.dot-alert{position:absolute;top:10px;right:4px;width:7px;height:7px;border-radius:50%;background:var(--bad)}
.c-body{padding:20px;max-width:1400px;margin:0 auto}
.c-grid2{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:20px;padding:20px;align-items:start}
.modal .c-grid2{padding:0;margin-top:10px;grid-template-columns:1fr 1fr}
.stat-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 18px;min-width:120px}
.stat.bad{border-color:var(--bad);background:var(--bad-soft)}
.stat-v{font-size:26px;font-weight:800;color:var(--ink)}
.stat-l{font-size:12px;color:var(--muted);text-transform:capitalize}
.t{width:100%;border-collapse:collapse;font-size:14px}
.t th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:8px;border-bottom:1px solid var(--line)}
.t td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
.t tr.sel td{background:var(--accent-soft)}
.tables-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.people{list-style:none;padding:0;margin:10px 0 0}
.people li{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
.pdot{width:8px;height:8px;border-radius:50%;background:#D0D5DD}.pdot.on{background:var(--ok)}
.cap-ic{color:#B88A00;margin-left:6px;vertical-align:-1px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bad);color:#fff;padding:10px 16px;border-radius:10px;display:flex;align-items:center;gap:8px;z-index:60;font-weight:600}
@media(max-width:900px){.c-grid2,.split,.reveal,.lobby{grid-template-columns:1fr}.modal .c-grid2{grid-template-columns:1fr}}
`;