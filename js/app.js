import { Engine, SR } from './engine.js';
import * as DB from './db.js';
import { assessDevice, detectCaps } from './compat.js';
import { initAds, refreshAds } from './ads.js';

const STEMS = [
  { key: 'drums', label: 'Drums', color: '#FF5A3C' },
  { key: 'bass', label: 'Bass', color: '#2DD4BF' },
  { key: 'vocals', label: 'Vocals', color: '#FBBF24' },
  { key: 'other', label: 'Guitar and keys', color: '#A78BFA' },
];
const WORKER_URL = new URLSearchParams(location.search).get('worker') || 'vendor/separate.worker.js';
const BINS = 1000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const fmtLong = (s) => s < 90 ? Math.round(s) + ' s' : Math.round(s / 60) + ' min';

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1.3"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.3"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7 9l5-5 5 5M5 20h14"/></svg>',
  rew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/></svg>10',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v4h-4"/></svg>10',
};

const engine = new Engine();
const state = {
  view: 'lib', song: null, peaks: [], dur: 0,
  mute: [false, false, false, false], solo: [false, false, false, false], vol: [1, 1, 1, 1],
  loopA: null, loopB: null, loopOn: false, speed: 1, taps: [],
  lev: [], decoded: null, file: null, worker: null, sepToken: 0,
};

/* ---------- small helpers ---------- */
let toastTimer;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), err ? 6000 : 2800);
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
function show(view) {
  state.view = view;
  for (const v of ['lib', 'add', 'play']) $('v-' + v).hidden = v !== view;
  const sub = view !== 'lib';
  $('top').classList.toggle('sub', sub);
  $('btn-back').hidden = !sub;
  window.scrollTo(0, 0);
  refreshAds(view, !$('add-progress').hidden);
}

/* ---------- library ---------- */
async function renderLibrary() {
  const songs = await DB.listSongs();
  const list = $('song-list');
  if (!songs.length) {
    list.innerHTML = '<div class="empty"><b>Add your first song</b>Pick an audio file and Offtrack splits it into drums, bass, vocals and guitar and keys.</div>';
  } else {
    list.innerHTML = songs.map((s) => `
      <div class="song" data-id="${s.id}">
        <div class="meta"><div class="t">${esc(s.title)}</div>
          <div class="s">${fmt(s.duration)} · ${new Date(s.created).toLocaleDateString()}</div>
          <div class="dots">${STEMS.map((x) => `<i style="background:${x.color}"></i>`).join('')}</div></div>
        <button class="icon-btn" data-del="${s.id}" aria-label="Delete ${esc(s.title)}">${ICONS.trash}</button>
      </div>`).join('');
  }
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      $('storage-line').textContent = `Songs use ${(e.usage / 1048576).toFixed(0)} MB of about ${(e.quota / 1073741824).toFixed(1)} GB available.`;
    }
  } catch {}
  $('install-tip').hidden = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

$('song-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (confirm('Delete this song and its stems from this device?')) { await DB.deleteSong(del.dataset.del); renderLibrary(); toast('Song deleted'); }
    return;
  }
  const card = e.target.closest('.song');
  if (card) openSong(card.dataset.id);
});

/* ---------- player ---------- */
function effective() {
  const anySolo = state.solo.some(Boolean);
  return [0, 1, 2, 3].map((i) => (anySolo ? (state.solo[i] ? 1 : 0) : state.mute[i] ? 0 : 1) * state.vol[i]);
}
function applyGains() {
  const g = effective();
  g.forEach((v, i) => engine.setGain(i, v));
  document.querySelectorAll('.stem').forEach((el, i) => el.classList.toggle('off', g[i] === 0));
  document.querySelectorAll('.ms.m').forEach((b, i) => b.classList.toggle('on', state.mute[i]));
  document.querySelectorAll('.ms.s').forEach((b, i) => b.classList.toggle('on', state.solo[i]));
  document.querySelectorAll('.stem .db').forEach((el, i) => { el.textContent = state.vol[i] < 0.01 ? '-inf dB' : (20 * Math.log10(state.vol[i])).toFixed(1) + ' dB'; });
  renderPresets();
}

const PRESETS = [
  { label: 'No drums', mute: [1, 0, 0, 0] },
  { label: 'No bass', mute: [0, 1, 0, 0] },
  { label: 'No vocals', mute: [0, 0, 1, 0] },
  { label: 'No guitar and keys', mute: [0, 0, 0, 1] },
  { label: 'Drums only', mute: [0, 1, 1, 1] },
  { label: 'All stems', mute: [0, 0, 0, 0] },
];
function renderPresets() {
  const noSolo = !state.solo.some(Boolean);
  $('presets').innerHTML = PRESETS.map((p, i) => {
    const on = noSolo && p.mute.every((m, k) => !!m === state.mute[k]) && state.vol.every((v) => v === 1);
    return `<button class="chip${on ? ' on' : ''}" data-p="${i}">${p.label}</button>`;
  }).join('');
}
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  state.mute = PRESETS[+b.dataset.p].mute.map(Boolean);
  state.solo = [false, false, false, false];
  state.vol = [1, 1, 1, 1];
  document.querySelectorAll('.stem .vol').forEach((v) => (v.value = 1));
  applyGains();
});

function buildStack() {
  $('stack').innerHTML = STEMS.map((s, i) => `
    <div class="stem" data-i="${i}" style="--c:${s.color}">
      <div class="scribble">${i === 3 ? 'Gtr+Keys' : s.label}</div>
      <div class="mf"><div class="meter">${'<i></i>'.repeat(16)}</div>
        <div class="fwrap"><input class="vol" type="range" min="0" max="1" step="0.01" value="${state.vol[i]}" aria-label="${s.label} volume"></div></div>
      <div class="db"></div>
      <div class="msrow"><button class="ms s" aria-label="Solo ${s.label}">S</button><button class="ms m" aria-label="Mute ${s.label}">M</button></div>
      <div class="chname">${i === 3 ? 'Gtr / Keys' : s.label}</div>
    </div>`).join('');
  $('meter-l').innerHTML = $('meter-r').innerHTML = '<i></i>'.repeat(16);
  drawAll();
}
// overview: all four stems drawn in their own colours, mirrored around the centre line
function drawAll() {
  const cv = $('ov-canvas'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  if (!state.peaks.length) return;
  const bw = w / BINS;
  for (let b = 0; b < BINS; b++) {
    let mx = 0, top = -1;
    for (let i = 0; i < 4; i++) { const v = state.peaks[i][b]; if (v > mx) { mx = v; top = i; } }
    if (top < 0) continue;
    c.fillStyle = STEMS[top].color;
    const v = Math.max(0.03, mx) * (h / 2 - 3);
    c.fillRect(b * bw, h / 2 - v, Math.max(1, bw - 0.4), v * 2);
  }
}
window.addEventListener('resize', () => { if (state.view === 'play') { drawAll(); updateLoopBox(); } });

function peaksOf(l, r) {
  const n = l.length, out = new Float32Array(BINS), per = n / BINS;
  let mx = 1e-6;
  for (let b = 0; b < BINS; b++) {
    const s = Math.floor(b * per), e = Math.min(n, Math.floor((b + 1) * per));
    let p = 0;
    for (let i = s; i < e; i += 8) { const a = Math.abs(l[i]), c = Math.abs(r[i]); if (a > p) p = a; if (c > p) p = c; }
    out[b] = p; if (p > mx) mx = p;
  }
  for (let b = 0; b < BINS; b++) out[b] /= mx;
  return out;
}

// level at 20 Hz for the meters (RMS of each stem, scaled so the loudest moment of the loudest stem is near the top)
function levelsOf(l, r) {
  const step = Math.floor(SR / 20), n = Math.floor(l.length / step), out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let a = 0; const s0 = k * step;
    for (let i = 0; i < step; i += 4) { const x = l[s0 + i], y = r[s0 + i]; a += x * x + y * y; }
    out[k] = Math.sqrt(a / (step / 4 * 2));
  }
  return out;
}

function updateLoopBox() {
  const lb = $('loopbox'); if (!lb) return;
  const a = state.loopA, b = state.loopB;
  const info = $('loop-info');
  if (a != null && b != null && b > a) {
    lb.style.display = 'block'; lb.classList.toggle('on', state.loopOn);
    lb.style.left = (a / state.dur) * 100 + '%'; lb.style.width = ((b - a) / state.dur) * 100 + '%';
    info.textContent = `${fmt(a)} to ${fmt(b)}${state.loopOn ? ' · looping' : ''}`;
  } else {
    lb.style.display = 'none';
    info.textContent = a != null ? `A ${fmt(a)}` : '';
  }
  $('btn-loop').classList.toggle('on', state.loopOn);
}
function pushLoop() {
  const ok = state.loopA != null && state.loopB != null && state.loopB > state.loopA;
  if (!ok) state.loopOn = false;
  engine.setLoop(state.loopA ?? 0, state.loopB ?? 0, state.loopOn && ok);
  updateLoopBox();
}

function setPlayIcon(playing) { $('btn-play').innerHTML = playing ? ICONS.pause : ICONS.play; $('btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
let meterPos = { t: 0, at: 0, playing: false };
engine.onpos = (t, playing) => {
  $('t-now').textContent = fmt(t);
  const ph = $('playhead'); if (ph && state.dur) ph.style.left = Math.min(100, (t / state.dur) * 100) + '%';
  setPlayIcon(playing);
  window.__stemroomPos = t; meterPos = { t, at: performance.now(), playing };
};
engine.onended = () => setPlayIcon(false);

async function togglePlay() {
  await engine.init();
  if (engine.playing) { engine.pause(); setPlayIcon(false); }
  else { await engine.play(+$('countin').value, +$('bpm').value || 120); setPlayIcon(true); }
}
$('btn-play').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (state.view === 'play' && e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
});
const jump = (d) => engine.seek(Math.max(0, Math.min(state.dur, (engine.pos / SR) + d)));
$('btn-b10').addEventListener('click', () => jump(-10));
$('btn-f10').addEventListener('click', () => jump(10));

// seek by touching the overview
let scrub = false;
function seekFromEvent(e) {
  const r = $('overview').getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  engine.seek(f * state.dur);
}
$('overview').addEventListener('pointerdown', (e) => { scrub = true; $('overview').setPointerCapture(e.pointerId); seekFromEvent(e); });
$('overview').addEventListener('pointermove', (e) => { if (scrub) seekFromEvent(e); });
$('overview').addEventListener('pointerup', () => (scrub = false));
$('overview').addEventListener('pointercancel', () => (scrub = false));
$('stack').addEventListener('click', (e) => {
  const st = e.target.closest('.stem'); if (!st) return;
  const i = +st.dataset.i;
  if (e.target.closest('.ms.m')) { state.mute[i] = !state.mute[i]; applyGains(); }
  else if (e.target.closest('.ms.s')) { state.solo[i] = !state.solo[i]; applyGains(); }
});
$('stack').addEventListener('input', (e) => {
  if (!e.target.classList.contains('vol')) return;
  const i = +e.target.closest('.stem').dataset.i; state.vol[i] = +e.target.value; applyGains();
});

// loop controls
const nowSec = () => (engine.pos || 0) / SR;
$('btn-a').addEventListener('click', () => { state.loopA = nowSec(); if (state.loopB != null && state.loopB <= state.loopA) state.loopB = null; state.loopOn = false; pushLoop(); toast('Loop start set'); });
$('btn-b').addEventListener('click', () => {
  const t = nowSec();
  if (state.loopA == null) { toast('Set the start (A) first', true); return; }
  if (t <= state.loopA + 0.5) { toast('Move later than A first', true); return; }
  state.loopB = t; state.loopOn = true; pushLoop(); toast('Looping');
});
$('btn-loop').addEventListener('click', () => {
  if (state.loopA == null || state.loopB == null) { toast('Set A and B first', true); return; }
  state.loopOn = !state.loopOn; pushLoop();
});
$('btn-clear').addEventListener('click', () => { state.loopA = state.loopB = null; state.loopOn = false; pushLoop(); });

// speed, count-in, tap tempo
$('speed').addEventListener('input', (e) => {
  state.speed = +e.target.value / 100; $('speed-val').textContent = e.target.value + '%'; engine.setSpeed(state.speed);
});
$('btn-tap').addEventListener('click', () => {
  const now = performance.now();
  if (state.taps.length && now - state.taps[state.taps.length - 1] > 2000) state.taps = [];
  state.taps.push(now); state.taps = state.taps.slice(-8);
  if (state.taps.length >= 3) {
    const iv = (state.taps[state.taps.length - 1] - state.taps[0]) / (state.taps.length - 1);
    $('bpm').value = Math.max(40, Math.min(240, Math.round(60000 / iv)));
    saveBpm();
  }
});
async function saveBpm() { if (state.song) { state.song.bpm = +$('bpm').value; await DB.putSong(state.song); } }
$('bpm').addEventListener('change', saveBpm);

async function openPlayer(song, floatStems) {
  await engine.init();
  engine.pause();
  state.song = song; state.dur = floatStems[0].l.length / SR;
  state.peaks = floatStems.map((s) => peaksOf(s.l, s.r));
  state.lev = floatStems.map((s) => levelsOf(s.l, s.r));
  const lmax = Math.max(1e-6, ...state.lev.map((a) => a.reduce((m, v) => (v > m ? v : m), 0)));
  state.lev.forEach((a) => { for (let k = 0; k < a.length; k++) a[k] /= lmax; });
  state.mute = [false, false, false, false]; state.solo = [false, false, false, false]; state.vol = [1, 1, 1, 1];
  state.loopA = state.loopB = null; state.loopOn = false; state.speed = 1; state.taps = [];
  $('speed').value = 100; $('speed-val').textContent = '100%';
  $('bpm').value = song.bpm || 120;
  $('t-dur').textContent = fmt(state.dur); $('t-now').textContent = '0:00';
  $('top-title').innerHTML = `${esc(song.title)}<small>${fmt(state.dur)}</small>`;
  $('top-actions').innerHTML = `<button class="icon-btn" id="btn-export" aria-label="Export a WAV of this mix" title="Export this mix as WAV">${ICONS.download}</button>`;
  $('btn-export').addEventListener('click', exportMix);
  setPlayIcon(false);
  show('play'); buildStack(); applyGains();
  await engine.load(floatStems);
  engine.setSpeed(1); applyGains(); pushLoop();
}

async function openSong(id) {
  try {
    toast('Opening song…');
    const song = await DB.getSong(id);
    const stems = [];
    for (const s of STEMS) {
      const buf = await DB.getStem(id, s.key);
      if (!buf) throw new Error('Stems are missing for this song');
      stems.push(DB.fromInt16Planar(buf));
    }
    await openPlayer(song, stems);
  } catch (e) { toast('Could not open the song: ' + (e.message || e), true); }
}

/* ---------- export ---------- */
async function exportMix() {
  try {
    toast('Preparing WAV…');
    const g = effective(); const id = state.song.id;
    let n = 0, L = null, R = null;
    for (let i = 0; i < 4; i++) {
      if (!g[i]) continue;
      const buf = await DB.getStem(id, STEMS[i].key); const i16 = new Int16Array(buf); n = i16.length / 2;
      if (!L) { L = new Float32Array(n); R = new Float32Array(n); }
      for (let k = 0; k < n; k++) { L[k] += g[i] * i16[k] / 32768; R[k] += g[i] * i16[n + k] / 32768; }
    }
    if (!L) { toast('Everything is muted', true); return; }
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const w = (o, s) => { for (let k = 0; k < s.length; k++) out.setUint8(o + k, s.charCodeAt(k)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, SR, true); out.setUint32(28, SR * 4, true);
    out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 4, true);
    const cl = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);
    for (let k = 0; k < n; k++) { out.setInt16(44 + k * 4, cl(L[k]) * 32767, true); out.setInt16(46 + k * 4, cl(R[k]) * 32767, true); }
    const muted = STEMS.filter((_, i) => !g[i]).map((s) => s.label.toLowerCase());
    const name = `${state.song.title}${muted.length ? ' - no ' + muted.join(', ') : ''}.wav`;
    const url = URL.createObjectURL(new Blob([out], { type: 'audio/wav' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('WAV ready');
  } catch (e) { toast('Export failed: ' + (e.message || e), true); }
}

/* ---------- add a song ---------- */
function resetAdd() {
  state.decoded = null; state.file = null;
  $('file').value = ''; $('drop').classList.remove('has'); $('drop-text').textContent = 'Choose an audio file';
  $('add-details').hidden = true; $('add-progress').hidden = true;
  $('in-url').value = ''; urlMsg('Works with a direct link to an mp3, m4a, wav or flac file, and with Dropbox share links. Links to YouTube, Spotify or Apple Music can\'t be used.');
}
$('btn-add').addEventListener('click', () => { resetAdd(); show('add'); $('top-title').textContent = 'Add a song'; $('top-actions').innerHTML = ''; });
$('btn-back').addEventListener('click', () => {
  if (state.view === 'add' && state.worker) { if (!confirm('Stop separating this song?')) return; cancelSeparation(); }
  if (state.view === 'play') { engine.pause(); }
  show('lib'); renderLibrary();
});

let gpuOK = false;
async function detectGpu() {
  try {
    if (!navigator.gpu) return false;
    const ad = await navigator.gpu.requestAdapter();
    return !!(ad && ad.features.has('shader-f16'));
  } catch { return false; }
}
function chosenEngine() {
  const v = $('in-engine').value;
  if (v === 'gpu') return gpuOK ? 'gpu' : 'cpu';
  if (v === 'cpu') return 'cpu';
  return gpuOK && !localStorage.getItem('stemroom_force_cpu') ? 'gpu' : 'cpu';
}
function estRate() {
  if (chosenEngine() === 'gpu') return +localStorage.getItem('stemroom_rate_gpu') || 0.55;
  return +localStorage.getItem('stemroom_rate') || (crossOriginIsolated ? 1.5 : 2.2);
}
function updateEstimate() {
  const s = +$('in-start').value || 0, e = +$('in-end').value || 0;
  const len = Math.max(0, e - s);
  $('add-estimate').textContent = len ? `${fmtLong(len)} of audio. Expect about ${fmtLong(len * estRate())} to separate on this device.` : '';
  $('btn-sep').disabled = len < 5;
}
$('in-engine').addEventListener('change', updateEstimate);
$('in-start').addEventListener('input', updateEstimate);
$('in-end').addEventListener('input', updateEstimate);

async function useAudio(arrayBuffer, name) {
  $('drop-text').textContent = 'Reading ' + name + '…';
  try {
    await engine.init();
    const dec = await engine.ctx.decodeAudioData(arrayBuffer);
    state.decoded = dec; state.file = { name };
    $('drop').classList.add('has'); $('drop-text').textContent = name;
    $('add-details').hidden = false;
    $('in-title').value = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    $('in-start').value = 0; $('in-end').value = Math.floor(Math.min(dec.duration, 360));
    $('in-end').max = Math.floor(dec.duration);
    if (dec.duration > 360) toast('Long song: the first 6 minutes are selected. Change Start and End to pick another part.');
    updateEstimate();
    return true;
  } catch (e) {
    $('drop-text').textContent = 'Choose an audio file';
    toast('This file could not be read as audio. Try an mp3, m4a, wav or flac.', true);
    return false;
  }
}
$('file').addEventListener('change', async () => {
  const f = $('file').files[0]; if (!f) return;
  $('drop-text').textContent = 'Reading ' + f.name + '…';
  try { await useAudio(await f.arrayBuffer(), f.name); }
  catch { $('drop-text').textContent = 'Choose an audio file'; toast('This file could not be read. If it is in iCloud Drive, open it in Files first so it downloads.', true); }
});

/* ---------- add from a link ---------- */
const STREAMING = /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com|spotify\.com|open\.spotify\.com|music\.apple\.com|soundcloud\.com|deezer\.com|tidal\.com|bandcamp\.com|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|vimeo\.com)$/i;
export function normalizeLink(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: 'That doesn\'t look like a web link. Paste the full address, starting with https://' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only web links (https://) can be used.' };
  const host = u.hostname.toLowerCase();
  if (STREAMING.test(host)) return { error: 'Streaming and video sites can\'t be used. Offtrack only takes links to audio files you have the right to use. Save the file to your device and add it with Choose an audio file.' };
  if (/(^|\.)dropbox\.com$/.test(host)) { u.hostname = 'dl.dropboxusercontent.com'; u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); }
  else if (host === 'drive.google.com') {
    const m = u.pathname.match(/\/file\/d\/([^/]+)/) || (u.searchParams.get('id') ? [0, u.searchParams.get('id')] : null);
    if (m) return { url: `https://drive.google.com/uc?export=download&id=${m[1]}`, name: 'Google Drive file', note: 'drive' };
  }
  else if (host === 'archive.org' && u.pathname.startsWith('/details/')) return { error: 'Open the item on archive.org, tap the audio file under "Download options", and paste that link instead.' };
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'Song');
  return { url: u.toString(), name: last };
}
function urlMsg(t, err) { const m = $('url-msg'); m.textContent = t; m.classList.toggle('err', !!err); }
$('btn-url').addEventListener('click', async () => {
  const n = normalizeLink($('in-url').value);
  if (n.error) { urlMsg(n.error, true); return; }
  const btn = $('btn-url'); btn.disabled = true;
  urlMsg('Downloading…'); $('url-bar').hidden = false; $('url-fill').style.width = '0%';
  try {
    const r = await fetch(n.url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) throw new Error('page');
    const total = +r.headers.get('content-length') || 0;
    if (total > 250 * 1048576) throw new Error('big');
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      chunks.push(value); got += value.length;
      if (got > 250 * 1048576) throw new Error('big');
      $('url-fill').style.width = total ? Math.round((got / total) * 100) + '%' : '50%';
      urlMsg(`Downloading… ${(got / 1048576).toFixed(1)} MB`);
    }
    const all = new Uint8Array(got); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    let name = n.name;
    const cd = r.headers.get('content-disposition') || ''; const mm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (mm) name = decodeURIComponent(mm[1]);
    urlMsg('Downloaded. Reading the audio…');
    const ok = await useAudio(all.buffer, name);
    urlMsg(ok ? 'Link added. Check the details below.' : 'The download worked, but it isn\'t an audio file Offtrack can read.', !ok);
  } catch (e) {
    const m = String(e.message || e);
    if (m === 'page') urlMsg('That link opens a web page, not an audio file. Use the direct download link to the file.', true);
    else if (m === 'big') urlMsg('That file is too large (over 250 MB).', true);
    else if (/^HTTP/.test(m)) urlMsg('The site refused the download (' + m + '). Check that the link is public and still works.', true);
    else urlMsg('This site doesn\'t allow Offtrack to download from it. Save the file to your device and add it with Choose an audio file.', true);
  } finally { btn.disabled = false; $('url-bar').hidden = true; }
});
$('in-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-url').click(); });

function cancelSeparation() {
  state.sepToken++;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  keepAwake(false);
  $('add-progress').hidden = true; $('add-details').hidden = !state.decoded;
}
$('btn-cancel').addEventListener('click', () => { cancelSeparation(); toast('Cancelled'); });

function runWorker(left, right, threads, token) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { type: 'module' });
    state.worker = w;
    let t0 = 0;
    w.onmessage = (e) => {
      if (token !== state.sepToken) return;
      const m = e.data;
      if (m.type === 'status') { $('prog-title').textContent = m.text; if (m.progress != null) { $('prog-fill').style.width = Math.round(m.progress * 100) + '%'; $('prog-pct').textContent = Math.round(m.progress * 100) + '%'; } }
      else if (m.type === 'progress') {
        if (!t0) t0 = performance.now();
        $('prog-title').textContent = 'Separating stems';
        const p = m.progress, el = (performance.now() - t0) / 1000;
        $('prog-fill').style.width = Math.round(p * 100) + '%'; $('prog-pct').textContent = Math.round(p * 100) + '%';
        $('prog-eta').textContent = p > 0.04 ? 'About ' + fmtLong(el / p - el) + ' left' : 'Estimating time…';
      }
      else if (m.type === 'done') { w.terminate(); state.worker = null; resolve(m.stems); }
      else if (m.type === 'error') { w.terminate(); state.worker = null; reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); state.worker = null; reject(new Error(e.message || 'The separation worker failed to start')); };
    w.postMessage({ type: 'separate', left, right, threads }, [left.buffer, right.buffer]);
  });
}

async function runGpu(left, right, token) {
  const abs = (p) => new URL(p, location.href).href;
  const ort = await import(abs('vendor/gpu/ort/ort.webgpu.min.mjs'));
  ort.env.wasm.wasmPaths = abs('vendor/gpu/ort/');
  ort.env.wasm.numThreads = 1;
  const { createGpuProcessor } = await import(abs('vendor/gpu-engine.js'));
  const ui = (fn) => { if (token === state.sepToken) fn(); };
  let t0 = 0;
  const proc = await createGpuProcessor({
    ort, modelBase: abs('model-split/'),
    onStatus: (t, p) => ui(() => { $('prog-title').textContent = /^Loading|^Checking/.test(t) ? 'Loading the model (first time only)' : t; $('prog-fill').style.width = Math.round(p * 100) + '%'; $('prog-pct').textContent = t; }),
    onProgress: ({ progress }) => ui(() => {
      if (!t0) t0 = performance.now();
      const p = Math.min(1, progress), el = (performance.now() - t0) / 1000;
      $('prog-title').textContent = 'Separating stems';
      $('prog-fill').style.width = Math.round(p * 100) + '%'; $('prog-pct').textContent = Math.round(p * 100) + '%';
      $('prog-eta').textContent = p > 0.1 && p < 1 ? 'About ' + fmtLong(el / p - el) + ' left' : '';
    }),
  });
  try { return await proc.separate(left, right, { pauseMs: 40, shouldStop: () => token !== state.sepToken }); }
  finally { try { await proc.session.release(); } catch {} }
}

$('btn-sep').addEventListener('click', async () => {
  const dec = state.decoded; if (!dec) return;
  const s0 = Math.max(0, Math.floor((+$('in-start').value || 0) * SR));
  const e0 = Math.min(dec.length, Math.floor((+$('in-end').value || 0) * SR));
  if (e0 - s0 < 5 * SR) { toast('Pick at least 5 seconds', true); return; }
  const title = $('in-title').value.trim() || 'Untitled';
  const slice = () => {
    const l = dec.getChannelData(0).slice(s0, e0);
    const r = (dec.numberOfChannels > 1 ? dec.getChannelData(1) : dec.getChannelData(0)).slice(s0, e0);
    return [l, r];
  };
  const token = ++state.sepToken;
  $('add-details').hidden = true; $('add-progress').hidden = false;
  $('prog-fill').style.width = '0%'; $('prog-pct').textContent = ''; $('prog-eta').textContent = ''; $('prog-title').textContent = 'Getting ready';
  keepAwake(true);
  const t0 = performance.now();
  try {
    const threads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
    let res, used = 'cpu';
    if (chosenEngine() === 'gpu') {
      localStorage.setItem('stemroom_gpu_run', '1');
      try { const [l, r] = slice(); res = await runGpu(l, r, token); used = 'gpu'; }
      catch (err) {
        if (token !== state.sepToken) return;
        console.error('GPU engine failed', err);
        toast('The fast engine failed here, so Offtrack is using the compatible one.', true);
        localStorage.setItem('stemroom_force_cpu', '1');
      }
      localStorage.removeItem('stemroom_gpu_run');
    }
    if (!res) {
      try { const [l, r] = slice(); res = await runWorker(l, r, threads, token); }
      catch (err) {
        if (token !== state.sepToken) return;
        if (threads === 1) throw err;
        toast('Retrying with one thread…');
        const [l, r] = slice(); res = await runWorker(l, r, 1, token);
      }
    }
    window.__engineUsed = used;
    if (token !== state.sepToken) return;
    const secs = (e0 - s0) / SR;
    localStorage.setItem(used === 'gpu' ? 'stemroom_rate_gpu' : 'stemroom_rate', String(((performance.now() - t0) / 1000 / secs).toFixed(2)));
    $('prog-title').textContent = 'Saving to your library'; $('prog-fill').style.width = '100%'; $('prog-eta').textContent = '';

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const song = { id, title, created: Date.now(), duration: secs, bpm: 120 };
    const stems = STEMS.map((s) => ({ l: res[s.key].left, r: res[s.key].right }));
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
    let saved = true;
    try {
      for (let i = 0; i < 4; i++) await DB.putStem(id, STEMS[i].key, DB.toInt16Planar(stems[i].l, stems[i].r));
      await DB.putSong(song);
    } catch (err) { saved = false; try { await DB.deleteSong(id); } catch {} toast('Could not save to the library (storage may be full). You can still play it now.', true); }
    state.decoded = null; keepAwake(false);
    await openPlayer(song, stems);
    if (saved) toast('Saved to your library');
  } catch (err) {
    keepAwake(false);
    if (token !== state.sepToken) return;
    $('add-progress').hidden = true; $('add-details').hidden = false;
    toast('Separation failed: ' + (err.message || err), true);
    console.error(err);
  }
});

/* ---------- meters ---------- */
const lerpLv = [0, 0, 0, 0]; let mLast = 0;
function setMeter(el, v) {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 16);
  for (let k = 0; k < el.children.length; k++) el.children[k].classList.toggle('on', k < n);
}
function meterFrame(now) {
  requestAnimationFrame(meterFrame);
  if (state.view !== 'play' || now - mLast < 33) return;
  mLast = now;
  const g = effective();
  const t = meterPos.playing ? meterPos.t + ((now - meterPos.at) / 1000) * state.speed : meterPos.t;
  const idx = Math.floor(t * 20);
  const strips = document.querySelectorAll('.stem .meter');
  let mx = 0;
  for (let i = 0; i < 4; i++) {
    const raw = meterPos.playing && state.lev[i] ? (state.lev[i][idx] || 0) * g[i] : 0;
    // dB-ish scale: -42 dB at the bottom, 0 dB at the top
    const tgt = raw > 0.0001 ? Math.max(0, (20 * Math.log10(raw) + 42) / 42) : 0;
    lerpLv[i] = Math.max(tgt, lerpLv[i] * 0.85 - 0.01);
    if (strips[i]) setMeter(strips[i], lerpLv[i]);
    mx = Math.max(mx, lerpLv[i]);
  }
  setMeter($('meter-l'), mx); setMeter($('meter-r'), mx);
}
requestAnimationFrame(meterFrame);

/* ---------- boot ---------- */
if (localStorage.getItem('stemroom_gpu_run')) {
  localStorage.removeItem('stemroom_gpu_run'); localStorage.setItem('stemroom_force_cpu', '1');
  setTimeout(() => toast('The fast engine stopped last time, so Offtrack will use the compatible engine. You can pick the fast one again when adding a song.', true), 600);
}
detectCaps().then((caps) => {
  gpuOK = caps.gpu; updateEstimate();
  const r = assessDevice(caps);
  $('compat-title').textContent = r.title; $('compat-text').textContent = r.text;
  $('compat').dataset.level = r.level; $('compat').hidden = false;
});
(async () => {
  let seen = false;
  try { seen = !!localStorage.getItem('stemroom_first_seen') || await caches.has('stemroom-model'); } catch {}
  $('first-note').hidden = seen;
})();
$('btn-first-ok').addEventListener('click', () => { try { localStorage.setItem('stemroom_first_seen', '1'); } catch {} $('first-note').hidden = true; });
$('btn-add').innerHTML = ICONS.plus + 'Add song';
$('btn-back').innerHTML = ICONS.back;
$('btn-b10').innerHTML = ICONS.rew; $('btn-f10').innerHTML = ICONS.fwd;
$('drop-icon').innerHTML = ICONS.upload;
setPlayIcon(false);
show('lib'); renderLibrary();
initAds(() => state.view);
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) navigator.serviceWorker.register('sw.js').catch(() => {});
