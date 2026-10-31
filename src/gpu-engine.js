// Experimental WebGPU engine: runs the 21-piece mixed-precision HTDemucs (monteslu/htdemucs-web-onnx)
// as a chain of ONNX sessions, plugged into demucs-web's STFT / overlap-add pipeline.
import { leanSeparate } from './lean.js';

// Piece 0 starts with a normalisation step that gives NaN on the WebGPU provider unless pinned to the CPU.
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];

async function readBuffer(device, src, offset, size) {
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, staging, 0, size);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap(); staging.destroy();
  return out;
}

class ChainedSession {
  constructor(sessions, manifest, make, onPiece, ort) {
    this.ort = ort;
    this.sessions = sessions;      // null in low-memory mode
    this.make = make;              // (i) => Promise<InferenceSession>
    this.onPiece = onPiece || (() => {});
    this.runs = 0;
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
    this.runs++;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      const inp = {};
      for (const n of p.inputs) { if (!map[n]) throw new Error('Piece ' + i + ' is missing ' + n); inp[n] = map[n]; }
      this.onPiece(this.runs, i, this.pieces.length);
      const t0 = performance.now();
      const sess = this.sessions ? this.sessions[i] : await this.make(i);
      const out = await sess.run(inp);
      if (!this.sessions) { try { await sess.release(); } catch {} }
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
      if (n === this.finalNames[0] && t.location === 'gpu-buffer') {
        // The frequency output is large (44 MB). Hand it out one stem at a time, straight from the GPU.
        let device = null;
        try { device = await this.ort.env.webgpu.device; } catch {}
        const perBytes = t.dims[2] * t.dims[3] * t.dims[4] * 4;
        if (device && t.gpuBuffer) {
          res[n] = { dims: t.dims, track: (k) => readBuffer(device, t.gpuBuffer, k * perBytes, perBytes), dispose: () => { try { t.dispose(); } catch {} } };
          continue;
        }
        res[n] = { dims: t.dims, data: await t.getData(), dispose: () => { try { t.dispose(); } catch {} } };
        continue;
      }
      const data = t.location && t.location !== 'cpu' ? await t.getData() : t.data;
      res[n] = { dims: t.dims, data, dispose: () => {} };
    }
    return res;
  }
  async release() { for (const s of (this.sessions || [])) { try { await s.release(); } catch {} } }
}

export async function createGpuProcessor({ ort, modelBase, onStatus = () => {}, onProgress = () => {}, onPiece = () => {}, lazy = false }) {
  if (!('gpu' in navigator)) throw new Error('This browser has no WebGPU');
  const manifest = await (await fetch(modelBase + 'htdemucs_split_manifest.json', { cache: 'no-cache' })).json();
  const cache = self.caches ? await caches.open('stemroom-model') : null;
  const total = manifest.pieces.length;
  const finalProducers = new Set();
  const freqPiece = manifest.pieces.findIndex((p) => p.outputs.includes(manifest.outputs.freq));
  manifest.pieces.forEach((p, i) => { if (p.outputs.some((n) => [manifest.outputs.freq, manifest.outputs.time].includes(n))) finalProducers.add(i); });
  const bytesOf = async (i) => {
    const url = modelBase + manifest.pieces[i].file;
    let r = cache ? await cache.match(url) : null;
    if (!r) {
      r = await fetch(url);
      if (!r.ok) throw new Error('Could not download ' + manifest.pieces[i].file + ' (HTTP ' + r.status + ')');
      if (cache) { try { await cache.put(url, r.clone()); } catch {} }
    }
    return new Uint8Array(await r.arrayBuffer());
  };
  const make = async (i) => {
    const p = manifest.pieces[i];
    const opts = {
      executionProviders: [i === 0 ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu'],
      graphOptimizationLevel: 'all',
      preferredOutputLocation: i === freqPiece ? 'gpu-buffer' : finalProducers.has(i) ? 'cpu' : 'gpu-buffer',
    };
    try { return await ort.InferenceSession.create(await bytesOf(i), opts); }
    catch (e) { throw new Error('Piece ' + i + ' (' + p.file + ') failed to load: ' + (e && e.message ? e.message : e)); }
  };
  let sessions = null;
  if (lazy) {
    for (let i = 0; i < total; i++) { await bytesOf(i); onStatus('Checking piece ' + (i + 1) + ' of ' + total, i / total); }
  } else {
    sessions = [];
    for (let i = 0; i < total; i++) { onStatus('Loading piece ' + (i + 1) + ' of ' + total, i / total); sessions.push(await make(i)); }
  }
  onStatus('Model ready', 1);
  const session = new ChainedSession(sessions, manifest, make, onPiece, ort);
  return {
    session,
    separate: (left, right, opts = {}) => leanSeparate({ session, ort, left, right, onProgress, pauseMs: opts.pauseMs || 0, shouldStop: opts.shouldStop }),
  };
}
