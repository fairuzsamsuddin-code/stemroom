// Offtrack mixer: plays four stems in sync, with per-stem gain, A-B loop and
// pitch-preserving speed change (WSOLA). Alignment is searched on the full mix
// and applied to every stem, so stems never drift apart and muting is instant.

const W = 2048;          // grain length (frames)
const HS = W / 2;        // synthesis hop
const DELTA = 384;       // search range (frames) either side of the nominal position
const STEP = 4;          // correlation sub-sampling
const FIFO = 16384;      // ring size per stem channel (power of two)
const MASK = FIFO - 1;
const HANN = new Float32Array(W);
for (let i = 0; i < W; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];            // [{l, r}] x4
    this.n = 0;
    this.mono = null;
    this.target = [1, 1, 1, 1];
    this.cur = [1, 1, 1, 1];
    this.pos = 0;               // input frame (exact when tempo === 1)
    this.playing = false;
    this.startAt = 0;
    this.tempo = 1;
    this.loopOn = false;
    this.loopA = 0;
    this.loopB = 0;
    this.fl = []; this.fr = [];
    for (let s = 0; s < 4; s++) { this.fl.push(new Float32Array(FIFO)); this.fr.push(new Float32Array(FIFO)); }
    this.resetStretch(0);
    this.tick = 0;
    this.ending = false;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  resetStretch(at) {
    for (let s = 0; s < 4; s++) { this.fl[s].fill(0); this.fr[s].fill(0); }
    this.fRead = 0;
    this.outStart = 0;
    this.nextNom = at;
    this.havePrev = false;
    this.prevPos = 0;
    this.ending = false;
  }

  currentPos() {
    if (this.tempo === 1) return this.pos;
    let p = this.nextNom - (this.outStart - this.fRead) * this.tempo;
    if (this.loopOn && p < this.loopA) p = this.loopA;
    return Math.max(0, Math.min(this.n, p));
  }

  onMsg(m) {
    switch (m.type) {
      case 'load': {
        this.stems = m.stems.map((s) => ({ l: new Float32Array(s.l), r: new Float32Array(s.r) }));
        this.n = this.stems[0].l.length;
        const mono = new Float32Array(this.n);
        for (const s of this.stems) for (let i = 0; i < this.n; i++) mono[i] += s.l[i] + s.r[i];
        this.mono = mono;
        this.pos = 0; this.playing = false; this.resetStretch(0);
        this.port.postMessage({ type: 'loaded', frames: this.n });
        break;
      }
      case 'play':
        if (this.pos >= this.n - 1) this.seek(0);
        this.startAt = m.at || 0;
        this.playing = true;
        break;
      case 'pause': this.pos = Math.round(this.currentPos()); this.playing = false; this.resetStretch(this.pos); this.report(); break;
      case 'seek': this.seek(m.pos); break;
      case 'tempo': {
        const t = Math.max(0.25, Math.min(1, m.value));
        const p = this.currentPos();
        const wasOne = this.tempo === 1;
        this.tempo = t;
        if (wasOne !== (t === 1)) { this.pos = Math.round(p); this.resetStretch(this.pos); }
        break;
      }
      case 'gain': this.target[m.index] = m.value; break;
      case 'loop': this.loopA = Math.max(0, m.a); this.loopB = Math.min(this.n, m.b); this.loopOn = !!m.on && this.loopB > this.loopA + 2048; break;
    }
  }

  seek(p) {
    this.pos = Math.max(0, Math.min(this.n, Math.round(p)));
    this.resetStretch(this.pos);
    this.report();
  }

  report() { this.port.postMessage({ type: 'pos', pos: this.currentPos(), playing: this.playing }); }

  produceHop() {
    const n = this.n, mono = this.mono;
    let nom = this.nextNom;
    if (this.loopOn && nom >= this.loopB) nom = this.loopA + (nom - this.loopB);
    if (nom >= n - W - DELTA) { this.ending = true; return; }
    let c = Math.max(0, Math.round(nom));
    if (this.havePrev) {
      const ref = this.prevPos + HS;
      let best = -Infinity, bestD = 0;
      for (let d = -DELTA; d <= DELTA; d += 2) {
        const s = c + d;
        if (s < 0 || s + W > n) continue;
        let acc = 0, en = 1e-9;
        for (let i = 0; i < HS; i += STEP) { const a = mono[s + i]; acc += a * mono[ref + i]; en += a * a; }
        const score = acc / Math.sqrt(en);
        if (score > best) { best = score; bestD = d; }
      }
      c += bestD;
    }
    if (c < 0) c = 0;
    if (c + W > n) c = n - W;
    const o = this.outStart;
    for (let s = 0; s < 4; s++) {
      const sl = this.stems[s].l, sr = this.stems[s].r, fl = this.fl[s], fr = this.fr[s];
      for (let i = 0; i < W; i++) {
        const idx = (o + i) & MASK, w = HANN[i];
        fl[idx] += w * sl[c + i];
        fr[idx] += w * sr[c + i];
      }
    }
    this.prevPos = c;
    this.havePrev = true;
    this.nextNom = nom + HS * this.tempo;
    this.outStart += HS;
  }

  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1];
    const N = L.length;
    if (!this.playing || this.n === 0 || currentTime < this.startAt - 1e-6) {
      L.fill(0); R.fill(0);
      return true;
    }
    const cur = this.cur, tg = this.target, stems = this.stems;
    let finished = false;

    if (this.tempo === 1) {
      let pos = this.pos;
      for (let i = 0; i < N; i++) {
        if (this.loopOn && pos >= this.loopB) pos = this.loopA;
        if (pos >= this.n) { L[i] = 0; R[i] = 0; finished = true; continue; }
        let sl = 0, sr = 0;
        for (let s = 0; s < 4; s++) {
          cur[s] += (tg[s] - cur[s]) * 0.004;
          sl += cur[s] * stems[s].l[pos];
          sr += cur[s] * stems[s].r[pos];
        }
        L[i] = sl; R[i] = sr;
        pos++;
      }
      this.pos = pos;
    } else {
      while (this.outStart - this.fRead < N && !this.ending) this.produceHop();
      const avail = Math.min(N, this.outStart - this.fRead);
      for (let i = 0; i < N; i++) {
        if (i >= avail) { L[i] = 0; R[i] = 0; finished = this.ending; continue; }
        const idx = (this.fRead + i) & MASK;
        let sl = 0, sr = 0;
        for (let s = 0; s < 4; s++) {
          cur[s] += (tg[s] - cur[s]) * 0.004;
          sl += cur[s] * this.fl[s][idx];
          sr += cur[s] * this.fr[s][idx];
          this.fl[s][idx] = 0; this.fr[s][idx] = 0;
        }
        L[i] = sl; R[i] = sr;
      }
      this.fRead += avail;
    }

    if (finished) {
      this.playing = false;
      this.pos = this.n;
      this.resetStretch(this.n);
      this.port.postMessage({ type: 'ended' });
    }
    if ((this.tick++ & 15) === 0 || finished) this.report();
    return true;
  }
}
registerProcessor('mixer', MixerProcessor);
