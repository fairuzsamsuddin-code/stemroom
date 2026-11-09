// Checks every public page: loads without errors, internal links and images resolve, one h1, ads stay off without a publisher ID.
import fs from 'fs';
import { createRequire } from 'module';
import { serve } from './serve.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const pages = ['index.html', 'guide.html', 'faq.html', 'about.html', 'privacy.html', 'terms.html', 'credits.html'];
const { server, port } = await serve(0);
const browser = await chromium.launch();
let bad = 0;
const check = (n, ok, i = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (i ? '  ' + i : '')); if (!ok) bad++; };
for (const w of [1100, 400]) {
  const p = await browser.newPage({ viewport: { width: w, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  for (const f of pages) {
    await p.goto(`http://127.0.0.1:${port}/${f}`);
    const r = await p.evaluate(async () => {
      const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => !/^(https?:|mailto:|#)/.test(h));
      const hrefs = [...new Set(links.map((h) => h.split('#')[0]))];
      const imgs = [...document.images].map((i) => i.naturalWidth > 0);
      const miss = [];
      for (const h of hrefs) { const res = await fetch(h || './'); if (!res.ok) miss.push(h); }
      return { miss, imgsOk: imgs.every(Boolean), h1: document.querySelectorAll('h1').length, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        consent: !document.getElementById('consent').hidden, script: !!document.querySelector('script[src*=adsbygoogle]') };
    });
    if (w === 1100) check(`${f}: links ok, images load, one h1, ads off`, !r.miss.length && r.imgsOk && r.h1 === 1 && !r.consent && !r.script, JSON.stringify(r.miss));
    check(`${f} @${w}: no sideways scroll`, r.sw <= r.cw, `${r.sw}/${r.cw}`);
    if (f === 'index.html') await p.screenshot({ path: new URL(`./out/site-${w}.png`, import.meta.url).pathname, fullPage: true });
  }
  check(`no page errors @${w}`, errs.length === 0, errs.join(' | '));
  await p.close();
}
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
