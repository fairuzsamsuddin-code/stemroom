// Checks that the lean separator gives exactly the same stems as demucs-web's own separate(),
// using the real fp32 model on the CPU.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-'));
await esbuild.build({ entryPoints: [path.join(here, '../src/lean.js')], outfile: path.join(tmp, 'lean.mjs'), bundle: true, format: 'esm', platform: 'node', absWorkingDir: here, nodePaths: [path.join(here, 'node_modules')], logLevel: 'error' });
await esbuild.build({ stdin: { contents: "export { DemucsProcessor } from 'demucs-web';", resolveDir: here }, outfile: path.join(tmp, 'dm.mjs'), bundle: true, format: 'esm', platform: 'node', absWorkingDir: here, nodePaths: [path.join(here, 'node_modules')], logLevel: 'error' });
const { leanSeparate } = await import(path.join(tmp, 'lean.mjs'));
const { DemucsProcessor } = await import(path.join(tmp, 'dm.mjs'));
const ort = await import(path.join(here, 'node_modules/onnxruntime-web/dist/ort.node.min.mjs')).catch(() => import('onnxruntime-web'));

const man = JSON.parse(fs.readFileSync(path.join(here, '../model/manifest.json'), 'utf8'));
const model = Buffer.concat(man.parts.map((p) => fs.readFileSync(path.join(here, '../model', p.file))));
const SR = 44100, n = Math.floor(SR * 9); // 9 s => two segments
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { const t = i / SR; const v = 0.3 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * rnd() * Math.exp(-(t % 0.25) * 40) + 0.1 * Math.sin(2 * Math.PI * 440 * t); L[i] = v; R[i] = v * 0.9; }

const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
const proc = new DemucsProcessor({ ort }); proc.session = session;
let t0 = Date.now();
const ref = await proc.separate(L.slice(), R.slice());
console.log('reference took', ((Date.now() - t0) / 1000).toFixed(1), 's');
t0 = Date.now();
const lean = await leanSeparate({ session, ort, left: L.slice(), right: R.slice() });
console.log('lean took', ((Date.now() - t0) / 1000).toFixed(1), 's');
let worst = 0, energy = 0;
for (const k of ['drums', 'bass', 'other', 'vocals']) for (const ch of ['left', 'right']) {
  const a = ref[k][ch], b = lean[k][ch];
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); energy += a[i] * a[i]; }
}
console.log('largest difference', worst, ' reference energy', energy.toFixed(2));
if (!(energy > 0.01)) { console.log('FAIL reference is silent'); process.exit(1); }
if (worst > 1e-6) { console.log('FAIL lean output differs'); process.exit(1); }
console.log('PASS lean separator matches the original exactly');
process.exit(0);
