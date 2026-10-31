// Audio engine: wraps the mixer AudioWorklet and count-in clicks.
export const SR = 44100;

export class Engine {
  constructor() {
    this.ctx = null; this.node = null; this.frames = 0;
    this.pos = 0; this.playing = false; this.speed = 1;
    this.onpos = () => {}; this.onended = () => {};
    this.clicks = []; this.countTimer = null; this.loadWaiters = [];
  }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: SR, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule('js/mixer.worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'mixer', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.master = this.ctx.createGain();
    this.node.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pos') { this.pos = m.pos; this.playing = m.playing; this.onpos(m.pos / SR, m.playing); }
      else if (m.type === 'ended') { this.playing = false; this.onended(); }
      else if (m.type === 'loaded') { this.frames = m.frames; this.loadWaiters.splice(0).forEach((f) => f()); }
    };
  }

  async resume() { if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch {} } }

  get duration() { return this.frames / SR; }

  // stems: [{l: Float32Array, r: Float32Array}] x4. Buffers are transferred (moved) to the audio thread.
  load(stems) {
    this.stopCount();
    const payload = stems.map((s) => ({ l: s.l.buffer, r: s.r.buffer }));
    const transfer = payload.flatMap((s) => [s.l, s.r]);
    const done = new Promise((res) => this.loadWaiters.push(res));
    this.node.port.postMessage({ type: 'load', stems: payload }, transfer);
    return done;
  }

  setGain(i, v) { this.node.port.postMessage({ type: 'gain', index: i, value: v }); }
  seek(sec) { this.node.port.postMessage({ type: 'seek', pos: sec * SR }); }
  setLoop(a, b, on) { this.node.port.postMessage({ type: 'loop', a: a * SR, b: b * SR, on }); }
  setSpeed(v) { this.speed = v; this.node.port.postMessage({ type: 'tempo', value: v }); }

  async play(countBars = 0, bpm = 120) {
    await this.resume();
    this.stopCount();
    const now = this.ctx.currentTime + 0.08;
    let start = now;
    if (countBars > 0) {
      const beat = 60 / (bpm * this.speed);
      const beats = countBars * 4;
      for (let i = 0; i < beats; i++) this.click(now + i * beat, i % 4 === 0);
      start = now + beats * beat;
    }
    this.node.port.postMessage({ type: 'play', at: start });
    this.playing = true;
    this.onpos(this.pos / SR, true);
  }

  click(t, accent) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + 0.08);
    this.clicks.push(o);
  }

  stopCount() { for (const o of this.clicks) { try { o.stop(); } catch {} } this.clicks = []; }

  pause() { this.stopCount(); this.node.port.postMessage({ type: 'pause' }); this.playing = false; }
}
