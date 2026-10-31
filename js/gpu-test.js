// Experimental WebGPU test page logic.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const recent = [];
const logEl = $('log');
const log = (m) => {
  logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight;
  recent.push(m); if (recent.length > 8) recent.shift();
  try { localStorage.setItem('stemroom_gpu_last', recent.join('\n')); } catch {}
};
const fmt = (s) => (s < 60 ? s.toFixed(1) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s');
const row = (k, v, c = '') => `<div class="row"><span>${k}</span><span class="${c}">${v}</span></div>`;
const abs = (p) => new URL(p, location.href).href;
const setProgress = (p) => { $('fill').style.width = Math.round(p * 100) + '%'; };

if (localStorage.getItem('stemroom_gpu_run') === 'started') {
  $('crash').style.display = 'block';
  $('crash-log').textContent = localStorage.getItem('stemroom_gpu_last') || '';
  localStorage.removeItem('stemroom_gpu_run');
}

let adapterInfo = 'none', hasGPU = false, limits = {}, hasF16 = false;
try {
  const ad = navigator.gpu && (await navigator.gpu.requestAdapter());
  if (ad) {
    hasGPU = true;
    const i = ad.info || {};
    adapterInfo = [i.vendor, i.architecture].filter(Boolean).join(' ') || 'available';
    limits = { buf: ad.limits.maxBufferSize, stor: ad.limits.maxStorageBufferBindingSize };
    hasF16 = ad.features.has('shader-f16');
  }
} catch (e) { log('Adapter check failed: ' + e.message); }
$('env').innerHTML = row('WebGPU', hasGPU ? 'Yes (' + adapterInfo + ')' : 'No', hasGPU ? 'ok' : 'bad')
  + (hasGPU ? row('Half-precision (shader-f16)', hasF16 ? 'Supported' : 'Not supported, this model cannot run here', hasF16 ? 'ok' : 'bad') + row('Max buffer', (limits.buf / 1048576).toFixed(0) + ' MB') + row('Max storage binding', (limits.stor / 1048576).toFixed(0) + ' MB') : '')
  + row('Cross-origin isolated', self.crossOriginIsolated ? 'Yes' : 'No');

$('file').addEventListener('change', () => { $('run').disabled = !$('file').files.length || !hasGPU || (!hasF16 && !params.has('force')); $('stage').textContent = 'Ready.'; });

let stems = null, orig = null, actx = null, node = null;
$('run').addEventListener('click', async () => {
  const f = $('file').files[0]; if (!f) return;
  $('run').disabled = true; $('resCard').hidden = true; logEl.textContent = '';
  localStorage.setItem('stemroom_gpu_run', 'started');
  const t = {};
  try {
    const SR = 44100;
    actx = actx || new AudioContext({ sampleRate: SR });
    $('stage').textContent = 'Reading the song'; log('Decoding ' + f.name);
    const dec = await actx.decodeAudioData(await f.arrayBuffer());
    const secs = Math.min(+$('secs').value || 15, dec.duration);
    const n = Math.floor(secs * SR);
    const left = dec.getChannelData(0).slice(0, n);
    const right = (dec.numberOfChannels > 1 ? dec.getChannelData(1) : dec.getChannelData(0)).slice(0, n);
    orig = actx.createBuffer(2, n, SR); orig.copyToChannel(left, 0); orig.copyToChannel(right, 1);

    $('stage').textContent = 'Preparing the GPU engine'; log('Importing ONNX Runtime (WebGPU build)');
    const ort = await import(abs('vendor/gpu/ort/ort.webgpu.min.mjs'));
    ort.env.wasm.wasmPaths = abs('vendor/gpu/ort/');
    ort.env.wasm.numThreads = 1;
    log('ONNX Runtime ' + (ort.env.versions && ort.env.versions.common));
    const { createGpuProcessor } = await import(abs('vendor/gpu-engine.js'));

    const t0 = performance.now();
    const proc = await createGpuProcessor({
      ort, modelBase: abs('model-split/'),
      onStatus: (s, p) => { $('stage').textContent = s; setProgress(p); log(s); },
      onProgress: ({ progress, currentSegment, totalSegments }) => { setProgress(progress); $('stage').textContent = `Separating, segment ${currentSegment} of ${totalSegments}`; log(`Segment ${currentSegment}/${totalSegments} done`); },
      onLog: (a, b) => log(`[${a}] ${b}`),
    });
    t.load = (performance.now() - t0) / 1000;
    log('Model loaded in ' + t.load.toFixed(1) + ' s');

    $('stage').textContent = 'Separating'; setProgress(0);
    const t1 = performance.now();
    const res = await proc.separate(left, right);
    t.sep = (performance.now() - t1) / 1000;
    stems = res;

    const rms = (a) => { let s = 0, bad = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (!Number.isFinite(v)) bad++; else s += v * v; } return { rms: Math.sqrt(s / a.length), bad }; };
    const stats = {}; let nan = 0;
    for (const k of ['drums', 'bass', 'other', 'vocals']) { const a = rms(res[k].left); stats[k] = a.rms; nan += a.bad; }
    localStorage.removeItem('stemroom_gpu_run');
    const rtf = t.sep / secs;
    $('res').innerHTML = row('Engine', 'WebGPU, 21 pieces', 'ok') + row('Model load', fmt(t.load)) + row('Separation of ' + secs.toFixed(0) + ' s', fmt(t.sep), 'ok')
      + row('Speed', rtf < 1 ? (1 / rtf).toFixed(1) + 'x faster than real time' : rtf.toFixed(1) + 'x slower than real time')
      + row('Estimated 3 min song', fmt(rtf * 180)) + row('Invalid numbers in output', String(nan), nan ? 'bad' : 'ok')
      + row('Stem loudness (RMS)', ['drums', 'bass', 'other', 'vocals'].map((k) => k + ' ' + stats[k].toFixed(3)).join(', '))
      + row('Tab survived', 'Yes', 'ok');
    $('resCard').hidden = false; $('stage').textContent = 'Finished.'; setProgress(1);
    const pm = proc.session.pieceMs.map((x) => Math.round(x));
    log('Per-piece ms: ' + pm.join(' '));
    window.__gpuResult = { ok: true, secs, load: t.load, sep: t.sep, nan, stats, pieceMs: pm };

    if (params.has('ref')) {
      $('stage').textContent = 'Checking against the CPU model'; log('Running CPU reference');
      const ref = await new Promise((resolve, reject) => {
        const w = new Worker(abs('vendor/separate.worker.js'), { type: 'module' });
        w.onmessage = (e) => { if (e.data.type === 'done') { w.terminate(); resolve(e.data.stems); } else if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.message)); } };
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ type: 'separate', left: left.slice(), right: right.slice(), threads: 1 });
      });
      const corr = {};
      for (const k of ['drums', 'bass', 'other', 'vocals']) {
        const a = res[k].left, b = ref[k].left; let sab = 0, saa = 0, sbb = 0;
        for (let i = 0; i < a.length; i++) { sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; }
        corr[k] = sab / Math.sqrt(saa * sbb + 1e-12);
      }
      log('Correlation with CPU model: ' + JSON.stringify(corr));
      window.__gpuResult.corr = corr;
      $('res').innerHTML += row('Match with CPU model', Object.entries(corr).map(([k, v]) => k + ' ' + v.toFixed(3)).join(', '));
    }
    window.__gpuDone = true;
  } catch (e) {
    localStorage.removeItem('stemroom_gpu_run');
    $('stage').innerHTML = '<span class="bad">Failed: ' + (e && e.message ? e.message : e) + '</span>';
    log('ERROR ' + (e && e.stack ? e.stack : e));
    window.__gpuResult = { ok: false, error: String(e && e.message ? e.message : e) };
    window.__gpuDone = true;
  } finally { $('run').disabled = !$('file').files.length || !hasGPU || (!hasF16 && !params.has('force')); }
});

function stop() { try { node && node.stop(); } catch {} node = null; }
function play(buf) { stop(); if (actx.state === 'suspended') actx.resume(); node = actx.createBufferSource(); node.buffer = buf; node.connect(actx.destination); node.start(); }
function mix(keys) {
  const n = stems.drums.left.length, b = actx.createBuffer(2, n, 44100), L = b.getChannelData(0), R = b.getChannelData(1);
  for (const k of keys) for (let i = 0; i < n; i++) { L[i] += stems[k].left[i]; R[i] += stems[k].right[i]; }
  return b;
}
$('pDrumless').onclick = () => stems && play(mix(['bass', 'other', 'vocals']));
$('pDrums').onclick = () => stems && play(mix(['drums']));
$('pOrig').onclick = () => orig && play(orig);
$('pStop').onclick = stop;
