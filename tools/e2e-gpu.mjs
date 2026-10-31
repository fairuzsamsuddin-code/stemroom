// Best-effort test of the WebGPU page in headless Chromium using a software GPU (SwiftShader).
import { createRequire } from 'module';
import fs from 'fs';
import { serve } from './serve.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

function makeWav(seconds) {
  const SR = 44100, n = SR * seconds, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR, beat = t % 0.5, eighth = t % 0.25;
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 9) * 0.6;
    const hat = rnd() * Math.exp(-eighth * 60) * 0.25;
    const bass = Math.sin(2 * Math.PI * 55 * t) * 0.25;
    const keys = (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 392 * t)) * 0.06;
    const s = Math.round(Math.max(-1, Math.min(1, kick + hat + bass + keys)) * 32767);
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  return buf;
}
const out = new URL('./ref/gpu-ci-result.json', import.meta.url).pathname;
fs.mkdirSync(new URL('./ref/', import.meta.url).pathname, { recursive: true });
const result = { started: new Date().toISOString() };
const { server, port } = await serve(0);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'] });
const page = await (await browser.newContext()).newPage();
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e));
try {
  await page.goto(`http://127.0.0.1:${port}/gpu.html?ref=1`);
  await page.waitForTimeout(1500);
  result.hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  result.env = await page.evaluate(() => document.getElementById('env').innerText);
  if (!result.hasWebGPU || /WebGPU\s*No/.test(result.env)) { result.skipped = 'No WebGPU adapter in this environment'; }
  else {
    await page.setInputFiles('#file', { name: 'ci.wav', mimeType: 'audio/wav', buffer: makeWav(8) });
    await page.fill('#secs', '7');
    await page.click('#run');
    await page.waitForFunction(() => window.__gpuDone === true, null, { timeout: 25 * 60 * 1000 });
    result.page = await page.evaluate(() => window.__gpuResult);
  }
} catch (e) { result.error = String(e.message || e).slice(0, 600); }
result.log = (await page.evaluate(() => document.getElementById('log').textContent).catch(() => '')).slice(-3000);
result.console = logs.slice(-25);
result.finished = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2).slice(0, 3000));
await browser.close(); server.close();
