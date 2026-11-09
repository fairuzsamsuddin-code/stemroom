// End-to-end test in headless Chromium. Default uses a mock separation worker.
// Pass --real to use the real model worker (vendor/separate.worker.js).
import { createRequire } from 'module';
import fs from 'fs';
import { serve } from './serve.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const real = process.argv.includes('--real');
const outDir = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (name, ok, info = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) failures++; };

function makeWav(seconds = 14) {
  const SR = 44100, n = SR * seconds, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR, beat = t % 0.5, eighth = t % 0.25;
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 9) * 0.6;
    const hat = rnd() * Math.exp(-eighth * 60) * 0.25;
    const bass = Math.sin(2 * Math.PI * 55 * t) * 0.25;
    const keys = (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 392 * t)) * 0.06;
    const v = Math.max(-1, Math.min(1, kick + hat + bass + keys));
    const s = Math.round(v * 32767);
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  return buf;
}

const { server, port } = await serve(0);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(m.text()); if (real) console.log('[page]', m.text()); });

try {
  const url = base + 'app.html?nosw' + (real ? '' : '&worker=' + encodeURIComponent('tools/mock.worker.js'));
  await page.goto(url);
  check('ads are off until a publisher ID is set', (await page.locator('#consent').isHidden()) && (await page.locator('script[src*="adsbygoogle"]').count()) === 0);
  await page.screenshot({ path: outDir + '1-library.png' });

  await page.click('#btn-add');
  // links: streaming sites are refused, bad links explained, a direct audio link works
  await page.fill('#in-url', 'https://www.youtube.com/watch?v=abc'); await page.click('#btn-url');
  check('YouTube link is refused', /can't be used/.test(await page.textContent('#url-msg')));
  await page.fill('#in-url', 'not a link'); await page.click('#btn-url');
  check('bad link is explained', /web link/.test(await page.textContent('#url-msg')));
  await page.route('https://blocked.example/**', (r) => r.abort());
  await page.fill('#in-url', 'https://blocked.example/a.mp3'); await page.click('#btn-url');
  await page.waitForFunction(() => /doesn't allow/.test(document.getElementById('url-msg').textContent), null, { timeout: 10000 });
  check('blocked site gets a clear message', true);
  const linkWav = makeWav(14);
  await page.route('https://music.example/**', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: linkWav }));
  await page.fill('#in-url', 'https://music.example/files/Linked%20Song.wav'); await page.click('#btn-url');
  await page.waitForSelector('#add-details:not([hidden])', { timeout: 20000 });
  check('direct audio link loads', (await page.inputValue('#in-title')) === 'Linked Song', await page.inputValue('#in-title'));
  await page.setInputFiles('#file', { name: 'Test Song.wav', mimeType: 'audio/wav', buffer: makeWav(14) });
  await page.waitForFunction(() => document.getElementById('in-title').value === 'Test Song', null, { timeout: 20000 });
  check('title filled from file name', (await page.inputValue('#in-title')) === 'Test Song');
  await page.fill('#in-end', '12');
  await page.screenshot({ path: outDir + '2-add.png' });
  await page.click('#btn-sep');
  await page.waitForSelector('#add-progress:not([hidden])');
  const t0 = Date.now();
  await page.waitForSelector('#v-play:not([hidden])', { timeout: real ? 420000 : 30000 });
  console.log('separation + save took ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  check('player opened after separation', true);
  check('four stems shown', (await page.locator('.stem').count()) === 4);
  check('title shown', (await page.textContent('#top-title')).includes('Test Song'));
  check('duration is 12 s', (await page.textContent('#t-dur')) === '0:12');
  await page.screenshot({ path: outDir + '3-player.png' });

  // play
  await page.click('#btn-play');
  await page.waitForTimeout(1800);
  const p1 = await page.evaluate(() => window.__stemroomPos || 0);
  check('playback advances', p1 > 1.0 && p1 < 2.6, 'pos=' + p1.toFixed(2));

  // presets and mute
  await page.click('[data-p="0"]');
  check('No drums mutes the drums stem', await page.locator('.stem').nth(0).evaluate((e) => e.classList.contains('off')));
  check('other stems stay on', !(await page.locator('.stem').nth(1).evaluate((e) => e.classList.contains('off'))));
  await page.click('.stem:nth-child(2) .ms.s');
  check('solo silences the others', await page.locator('.stem').nth(2).evaluate((e) => e.classList.contains('off')));
  await page.click('.stem:nth-child(2) .ms.s');
  await page.click('[data-p="5"]');

  // speed
  await page.evaluate(() => { const s = document.getElementById('speed'); s.value = 75; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(600);
  const a = await page.evaluate(() => window.__stemroomPos), ta = Date.now();
  await page.waitForTimeout(2500);
  const b = await page.evaluate(() => window.__stemroomPos), tb = Date.now();
  const rate = (b - a) / ((tb - ta) / 1000);
  check('75% speed plays at about 0.75x', rate > 0.6 && rate < 0.9, 'rate=' + rate.toFixed(2));
  await page.evaluate(() => { const s = document.getElementById('speed'); s.value = 100; s.dispatchEvent(new Event('input', { bubbles: true })); });

  // A-B loop
  await page.click('#btn-play'); // pause
  await page.evaluate(() => { document.getElementById('btn-clear').click(); });
  await page.click('#overview', { position: { x: 100, y: 20 } });
  await page.waitForTimeout(300);
  await page.click('#btn-a');
  await page.click('#overview', { position: { x: 380, y: 20 } });
  await page.waitForTimeout(300);
  await page.click('#btn-b');
  check('loop is on', await page.locator('#btn-loop').evaluate((e) => e.classList.contains('on')));
  const loopTxt = await page.textContent('#loop-info');
  await page.click('#btn-play');
  let lo = 99, hi = 0;
  for (let i = 0; i < 14; i++) { await page.waitForTimeout(400); const p = await page.evaluate(() => window.__stemroomPos); lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const lb = await page.evaluate(() => { const e = document.getElementById('loopbox'); return { l: parseFloat(e.style.left), w: parseFloat(e.style.width) }; });
  const A = (lb.l / 100) * 12, B = ((lb.l + lb.w) / 100) * 12;
  check('position stays inside the loop', lo >= A - 0.5 && hi <= B + 0.5, `A=${A.toFixed(2)} B=${B.toFixed(2)} seen ${lo.toFixed(2)}-${hi.toFixed(2)}`);
  await page.screenshot({ path: outDir + '4-loop.png' });
  await page.click('#btn-play');

  // export
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#btn-export')]);
  const wavPath = outDir + 'export.wav'; await dl.saveAs(wavPath);
  const size = fs.statSync(wavPath).size;
  check('export is a 12 s wav', Math.abs(size - (44 + 12 * 44100 * 4)) < 4000, 'bytes=' + size + ' name=' + dl.suggestedFilename());

  // persistence
  await page.reload();
  await page.waitForSelector('.song');
  check('song is in the library after reload', (await page.locator('.song .t').first().textContent()) === 'Test Song');
  await page.click('.song');
  await page.waitForSelector('#v-play:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(500);
  check('song reopens from storage', (await page.textContent('#t-dur')) === '0:12');
  await page.click('#btn-play'); await page.waitForTimeout(1200);
  check('reopened song plays', (await page.evaluate(() => window.__stemroomPos)) > 0.5);
  await page.screenshot({ path: outDir + '5-reopened.png' });
  await page.click('#btn-play');
  await page.click('#btn-back');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-del]');
  await page.waitForSelector('.empty');
  check('song can be deleted', true);
} catch (e) {
  console.log('ERROR ' + (e.stack || e)); failures++;
  try { await page.screenshot({ path: outDir + 'error.png' }); } catch {}
}

// ---- ads: with a fake publisher ID the consent banner gates everything, and the player stays ad-free ----
try {
  const actx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await actx.route('**/js/ads-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const ADS = { publisher: 'ca-pub-1234567890123456', slots: { library: '111', add: '222', page: '333' } };" }));
  let pushes = 0;
  await actx.route('https://pagead2.googlesyndication.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.adsbygoogle = window.adsbygoogle || []; var _p = window.adsbygoogle.push; window.adsbygoogle.push = function () { window.__adPushes = (window.__adPushes || 0) + 1; };' }));
  const ap = await actx.newPage();
  const aerr = []; ap.on('pageerror', (e) => aerr.push(String(e)));
  await ap.goto(base + 'app.html?nosw');
  check('consent banner shows before any choice', await ap.locator('#consent').isVisible());
  check('no ad code before consent', (await ap.locator('script[src*="adsbygoogle"]').count()) === 0 && (await ap.locator('#ad-lib').isHidden()));
  await ap.click('#consent-no');
  check('"No ads" keeps ad code off', (await ap.locator('script[src*="adsbygoogle"]').count()) === 0 && (await ap.locator('#consent').isHidden()));
  await ap.click('#ad-choices');
  await ap.click('#consent-yes');
  await ap.waitForSelector('#ad-lib:not([hidden]) ins.adsbygoogle');
  check('library shows an ad unit with the right slot', (await ap.locator('#ad-lib ins').getAttribute('data-ad-slot')) === '111');
  check('ad script is loaded once consent is given', (await ap.locator('script[src*="adsbygoogle.js?client=ca-pub-1234567890123456"]').count()) === 1);
  await ap.click('#btn-add');
  check('add-song screen shows its own ad unit', (await ap.locator('#ad-add ins').getAttribute('data-ad-slot')) === '222' && (await ap.locator('#ad-lib').isHidden()));
  check('ads page has no errors', aerr.length === 0, aerr.join(' | '));
  await actx.close();
} catch (e) { console.log('ERROR ads ' + (e.stack || e)); failures++; }
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); server.close();
process.exit(failures ? 1 : 0);
