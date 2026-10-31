// Builds vendor/: the separation worker bundle and the ONNX Runtime WASM files.
// Run from the tools folder after `npm install`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const vendor = path.join(root, 'vendor');
const ortOut = path.join(vendor, 'ort');
fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(ortOut, { recursive: true });

const dist = path.join(here, 'node_modules/onnxruntime-web/dist');
console.log('onnxruntime-web version', JSON.parse(fs.readFileSync(path.join(here, 'node_modules/onnxruntime-web/package.json'))).version);
console.log('demucs-web version', JSON.parse(fs.readFileSync(path.join(here, 'node_modules/demucs-web/package.json'))).version);
console.log('ort dist files:\n' + fs.readdirSync(dist).filter((f) => /wasm|\.mjs$/.test(f)).map((f) => '  ' + f + ' ' + (fs.statSync(path.join(dist, f)).size / 1048576).toFixed(1) + ' MB').join('\n'));

const pick = (names) => { const f = names.find((n) => fs.existsSync(path.join(dist, n))); if (!f) throw new Error('None of these found in onnxruntime-web/dist: ' + names.join(', ')); return f; };
const copies = [
  [pick(['ort.wasm.min.mjs', 'ort.wasm.mjs']), 'ort.wasm.min.mjs'],
  [pick(['ort-wasm-simd-threaded.mjs']), 'ort-wasm-simd-threaded.mjs'],
  [pick(['ort-wasm-simd-threaded.wasm']), 'ort-wasm-simd-threaded.wasm'],
];
for (const [from, to] of copies) {
  const size = fs.statSync(path.join(dist, from)).size;
  if (size > 24 * 1048576) throw new Error(from + ' is ' + (size / 1048576).toFixed(1) + ' MB, over the 25 MB hosting limit');
  fs.copyFileSync(path.join(dist, from), path.join(ortOut, to));
}

await esbuild.build({
  entryPoints: [path.join(root, 'src/separate.worker.js')],
  outfile: path.join(vendor, 'separate.worker.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  absWorkingDir: here, nodePaths: [path.join(here, 'node_modules')],
  logLevel: 'info',
});
const out = fs.readFileSync(path.join(vendor, 'separate.worker.js'), 'utf8');
if (/from\s*["']onnxruntime-web/.test(out) || /import\(["']onnxruntime-web/.test(out)) throw new Error('The worker bundle still imports onnxruntime-web by name');
console.log('worker bundle', (out.length / 1024).toFixed(0) + ' KB');
fs.writeFileSync(path.join(vendor, 'README.txt'), 'Built by tools/build.mjs from src/. Do not edit by hand.\n');
console.log('vendor ready');
