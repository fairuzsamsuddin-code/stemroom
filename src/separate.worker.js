// Separation worker: loads the HTDemucs model (served from /model/) and splits audio into stems on the CPU (WASM).
// Built into vendor/separate.worker.js by tools/build.mjs.
import { DemucsProcessor } from 'demucs-web';

const ortBase = new URL('./ort/', self.location.href).href;
const modelBase = new URL('../model/', self.location.href).href;
let ort = null;

async function loadOrt(threads) {
  if (!ort) ort = await import(/* @vite-ignore */ ortBase + 'ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = false;
  return ort;
}

async function loadModel(report) {
  const mr = await fetch(modelBase + 'manifest.json', { cache: 'no-cache' });
  if (!mr.ok) throw new Error('Model files are missing from this site (manifest HTTP ' + mr.status + ')');
  const man = await mr.json();
  const out = new Uint8Array(man.size);
  const cache = self.caches ? await caches.open('stemroom-model') : null;
  let o = 0;
  for (let i = 0; i < man.parts.length; i++) {
    const url = modelBase + man.parts[i].file;
    let r = cache ? await cache.match(url) : null;
    if (!r) {
      r = await fetch(url);
      if (!r.ok) throw new Error('Could not download model part ' + (i + 1) + ' (HTTP ' + r.status + ')');
      if (cache) { try { await cache.put(url, r.clone()); } catch {} }
    }
    const part = new Uint8Array(await r.arrayBuffer());
    out.set(part, o); o += part.length;
    report((i + 1) / man.parts.length);
  }
  if (o !== man.size) throw new Error('Model download is incomplete');
  return out.buffer;
}

const own = (a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'separate') return;
  try {
    self.postMessage({ type: 'status', text: 'Preparing the engine', progress: 0 });
    const o = await loadOrt(m.threads || 1);
    self.postMessage({ type: 'status', text: 'Loading the model', progress: 0 });
    let buf = await loadModel((p) => self.postMessage({ type: 'status', text: 'Loading the model', progress: p }));
    const proc = new DemucsProcessor({
      ort: o,
      sessionOptions: { executionProviders: ['wasm'], enableCpuMemArena: false, enableMemPattern: false },
      onProgress: ({ progress, currentSegment, totalSegments }) => self.postMessage({ type: 'progress', progress, currentSegment, totalSegments }),
      onLog: () => {},
    });
    await proc.loadModel(buf);
    buf = null;
    self.postMessage({ type: 'status', text: 'Separating stems', progress: 0 });
    const res = await proc.separate(m.left, m.right);
    const stems = {}, transfer = [];
    for (const k of ['drums', 'bass', 'vocals', 'other']) {
      const l = own(res[k].left), r = own(res[k].right);
      stems[k] = { left: l, right: r };
      transfer.push(l.buffer, r.buffer);
    }
    self.postMessage({ type: 'done', stems }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
