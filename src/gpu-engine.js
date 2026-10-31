// Experimental WebGPU engine: runs the 21-piece mixed-precision HTDemucs (monteslu/htdemucs-web-onnx)
// as a chain of ONNX sessions, plugged into demucs-web's STFT / overlap-add pipeline.
import { DemucsProcessor } from 'demucs-web';

// Piece 0 starts with a normalisation step that gives NaN on the WebGPU provider unless pinned to the CPU.
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];

class ChainedSession {
  constructor(sessions, manifest) {
    this.sessions = sessions;
    this.pieces = manifest.pieces;
    this.finalNames = [manifest.outputs.freq, manifest.outputs.time];
    this.inputNames = this.pieces[0].inputs.slice().sort((a, b) => (a === 'mix' ? -1 : b === 'mix' ? 1 : 0)); // waveform first
    this.outputNames = this.finalNames.slice();
    this.lastUse = {};
    this.pieces.forEach((p, i) => p.inputs.forEach((n) => { this.lastUse[n] = i; }));
    this.pieceMs = new Array(this.pieces.length).fill(0);
  }
  async run(feeds) {
    const map = {};
    const initial = new Set(this.pieces[0].inputs);
    for (const n of this.pieces[0].inputs) {
      const t = feeds[n];
      if (!t) throw new Error('Missing input ' + n);
      map[n] = t;
    }
    for (let i = 0; i < this.sessions.length; i++) {
      const p = this.pieces[i];
      const inp = {};
      for (const n of p.inputs) { if (!map[n]) throw new Error('Piece ' + i + ' is missing ' + n); inp[n] = map[n]; }
      const t0 = performance.now();
      const out = await this.sessions[i].run(inp);
      this.pieceMs[i] += performance.now() - t0;
      for (const n of p.outputs) map[n] = out[n];
      for (const n of p.inputs) {
        if (this.lastUse[n] === i && !initial.has(n) && !this.finalNames.includes(n)) {
          try { map[n].dispose && map[n].dispose(); } catch {}
          delete map[n];
        }
      }
    }
    const res = {};
    for (const n of this.finalNames) {
      const t = map[n];
      const data = t.location && t.location !== 'cpu' ? await t.getData() : t.data;
      res[n] = { dims: t.dims, data };
    }
    return res;
  }
  async release() { for (const s of this.sessions) { try { await s.release(); } catch {} } }
}

export async function createGpuProcessor({ ort, modelBase, onStatus = () => {}, onProgress = () => {}, onLog = () => {} }) {
  if (!('gpu' in navigator)) throw new Error('This browser has no WebGPU');
  const manifest = await (await fetch(modelBase + 'htdemucs_split_manifest.json', { cache: 'no-cache' })).json();
  const cache = self.caches ? await caches.open('stemroom-model') : null;
  const total = manifest.pieces.length;
  const finalProducers = new Set();
  manifest.pieces.forEach((p, i) => { if (p.outputs.some((n) => [manifest.outputs.freq, manifest.outputs.time].includes(n))) finalProducers.add(i); });
  const sessions = [];
  for (let i = 0; i < total; i++) {
    const p = manifest.pieces[i];
    const url = modelBase + p.file;
    let r = cache ? await cache.match(url) : null;
    if (!r) {
      r = await fetch(url);
      if (!r.ok) throw new Error('Could not download ' + p.file + ' (HTTP ' + r.status + ')');
      if (cache) { try { await cache.put(url, r.clone()); } catch {} }
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    onStatus('Loading piece ' + (i + 1) + ' of ' + total, i / total);
    const opts = {
      executionProviders: [i === 0 ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu'],
      graphOptimizationLevel: 'all',
      preferredOutputLocation: finalProducers.has(i) ? 'cpu' : 'gpu-buffer',
    };
    try { sessions.push(await ort.InferenceSession.create(buf, opts)); }
    catch (e) { throw new Error('Piece ' + i + ' (' + p.file + ') failed to load: ' + (e && e.message ? e.message : e)); }
  }
  onStatus('Model ready', 1);
  const proc = new DemucsProcessor({ ort, onProgress, onLog });
  proc.session = new ChainedSession(sessions, manifest);
  return proc;
}
