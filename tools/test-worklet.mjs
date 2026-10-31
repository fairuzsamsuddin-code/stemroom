// Offline test of the mixer worklet: stubs the AudioWorklet globals and drives process().
import fs from 'fs';
const SR = 44100;
let registered;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => msgs.push(m), onmessage: null }; } };
globalThis.registerProcessor = (_n, cls) => { registered = cls; };
globalThis.currentTime = 0;
const msgs = [];
(0, eval)(fs.readFileSync(new URL('../js/mixer.worklet.js', import.meta.url), 'utf8') + '\nglobalThis.__M = MixerProcessor;');
const Mixer = globalThis.__M;

const secs = 8, n = SR * secs;
const mk = (f, a) => { const l = new Float32Array(n), r = new Float32Array(n); for (let i = 0; i < n; i++) { const v = a * Math.sin(2 * Math.PI * f * i / SR); l[i] = v; r[i] = v; } return { l, r }; };
const stems = [mk(220, 0.3), mk(330, 0.3), mk(440, 0.3), mk(550, 0.3)];

function run(proc, seconds) {
  const N = 128, blocks = Math.floor(seconds * SR / N), out = new Float32Array(blocks * N);
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(N), R = new Float32Array(N);
    proc.process([], [[L, R]]);
    out.set(L, b * N); globalThis.currentTime += N / SR;
  }
  return out;
}
const freq = (x) => { let z = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) z++; return z / (x.length / SR); };
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
function fresh() {
  const p = new Mixer();
  p.onMsg({ type: 'load', stems: stems.map((s) => ({ l: s.l.buffer.slice(0), r: s.r.buffer.slice(0) })) });
  return p;
}
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fail++; };

// 1. normal speed, all stems: sum of four sines, rms = 0.3*sqrt(4/2)=0.424
let p = fresh(); p.onMsg({ type: 'play', at: 0 });
let o = run(p, 1);
check('normal speed plays all stems', Math.abs(rms(o.slice(2000)) - 0.424) < 0.03, 'rms=' + rms(o.slice(2000)).toFixed(3));
check('position advances in real time', Math.abs(p.pos / SR - 1) < 0.01, 'pos=' + (p.pos / SR).toFixed(3));

// 2. mute stems 1..3 leaves a single 220 Hz sine
p.onMsg({ type: 'gain', index: 1, value: 0 }); p.onMsg({ type: 'gain', index: 2, value: 0 }); p.onMsg({ type: 'gain', index: 3, value: 0 });
run(p, 0.2); o = run(p, 0.5);
check('mute leaves one stem', Math.abs(rms(o) - 0.212) < 0.02 && Math.abs(freq(o) - 220) < 4, 'rms=' + rms(o).toFixed(3) + ' f=' + freq(o).toFixed(1));

// 3. 75% speed keeps pitch, takes longer
p = fresh(); p.onMsg({ type: 'gain', index: 1, value: 0 }); p.onMsg({ type: 'gain', index: 2, value: 0 }); p.onMsg({ type: 'gain', index: 3, value: 0 });
p.cur = [1, 0, 0, 0];
p.onMsg({ type: 'tempo', value: 0.75 }); p.onMsg({ type: 'play', at: 0 });
run(p, 0.5); o = run(p, 2);
check('75% speed keeps pitch', Math.abs(freq(o) - 220) < 6, 'f=' + freq(o).toFixed(1));
check('75% speed output level sane', Math.abs(rms(o) - 0.212) < 0.04, 'rms=' + rms(o).toFixed(3));
const t0 = p.currentPos() / SR; run(p, 2); const t1 = p.currentPos() / SR;
check('75% speed advances at 0.75x', Math.abs((t1 - t0) / 2 - 0.75) < 0.03, 'rate=' + ((t1 - t0) / 2).toFixed(3));

// 4. 50% speed
p = fresh(); p.cur = [1, 1, 1, 1]; p.onMsg({ type: 'tempo', value: 0.5 }); p.onMsg({ type: 'play', at: 0 });
run(p, 0.5); const a = p.currentPos(); o = run(p, 2); const b = p.currentPos();
check('50% speed advances at 0.5x', Math.abs((b - a) / SR / 2 - 0.5) < 0.03, 'rate=' + ((b - a) / SR / 2).toFixed(3));
check('50% speed no clipping', Math.max(...o.map(Math.abs)) < 1.2, 'peak=' + Math.max(...o.map(Math.abs)).toFixed(2));

// 5. A-B loop at normal speed and at 80%
for (const t of [1, 0.8]) {
  p = fresh(); p.onMsg({ type: 'tempo', value: t }); p.onMsg({ type: 'loop', a: 2 * SR, b: 3 * SR, on: true });
  p.onMsg({ type: 'seek', pos: 1.9 * SR }); p.onMsg({ type: 'play', at: 0 });
  let minP = 1e9, maxP = 0;
  for (let i = 0; i < 10; i++) { run(p, 0.5); const q = p.currentPos() / SR; minP = Math.min(minP, q); maxP = Math.max(maxP, q); }
  check('loop stays inside A-B at ' + t, maxP < 3.15 && minP > 1.8, 'range ' + minP.toFixed(2) + '-' + maxP.toFixed(2));
}

// 6. ends at the end of the track
p = fresh(); p.onMsg({ type: 'seek', pos: (secs - 0.5) * SR }); p.onMsg({ type: 'play', at: 0 }); msgs.length = 0; run(p, 1.5);
check('ended message at normal speed', msgs.some((m) => m.type === 'ended'));
p = fresh(); p.onMsg({ type: 'tempo', value: 0.75 }); p.onMsg({ type: 'seek', pos: (secs - 1) * SR }); p.onMsg({ type: 'play', at: 0 }); msgs.length = 0; run(p, 3);
check('ended message at 75%', msgs.some((m) => m.type === 'ended'));

// 7. seek while paused then pause/resume continuity
p = fresh(); p.onMsg({ type: 'seek', pos: 3 * SR }); check('seek sets position', Math.abs(p.currentPos() - 3 * SR) < 2);
process.exit(fail ? 1 : 0);
