# Stemroom

Free, in-browser stem-separation PWA so drummers (and guitarists) can mute a part of a song and practise along. No backend: all processing runs on the user's device. Hosted as a static site on Cloudflare (Workers static assets). Repo: fairuzsamsuddin-code/stemroom, branch `main`. Live at https://stemroom.fsiq.com (Fairuz's domain fsiq.com; the Cloudflare custom domain is set up by Fairuz in the dashboard, not from sessions).

## Owner and devices
- Owner: Fairuz. Test devices: iPad Pro M1 and iPhone 16 Pro.
- iPad works (fast WebGPU engine about 80-90 s per 3-min song, CPU engine about 6 min).
- iPhone: CPU engine fails even on 10 s clips. GPU engine got to piece 19, then a sliced-readback fix was pushed; the result is unconfirmed.

## How it works
- Model: HTDemucs 4-stem (drums, bass, vocals, other; "guitar and keys" = other). MIT licence, see MODEL-LICENSE.md.
- Fast engine: onnxruntime-web 1.25.1 WebGPU, 21 fp16 pieces in `model-split/`, needs `shader-f16`. Code in `src/gpu-engine.js`, `src/lean.js`.
- CPU engine: ORT 1.22.0 wasm, fp32 model in 20 MB parts in `model/`, runs in `src/separate.worker.js`.
- Auto mode picks the engine in `js/app.js` (`detectGpu`, `chosenEngine`). A GPU failure falls back to CPU and sets `stemroom_force_cpu`.
- Site layout: `index.html` is the landing page, the app is `app.html` (manifest `start_url`; Cloudflare serves it at `/app`). Public pages `guide`, `faq`, `about`, `credits`, `terms`, `privacy` are plain HTML generated once from a template (no build step; edit all of them if you change the header or footer), styled by `css/site.css`. `sitemap.xml` and `robots.txt` exist. Guide and FAQ carry an ad slot (`page`). Contact email is set in `js/site-config.js` and shown on the About page. `node tools/check-pages.mjs` checks links, images and overflow.
- Player UI is a mixer console (design chosen by Fairuz from three mockups): channel strips with real level meters (RMS at 20 Hz from the stems, `levelsOf` in `js/app.js`), rotated range inputs as faders, a stem overview waveform for seeking. Fonts are self-hosted in `fonts/` (Barlow Condensed, IBM Plex Mono, SIL OFL).
- Ads: `js/ads.js` + `js/ads-config.js`. Off until `publisher` is set in `ads-config.js`. Shown only on library and add-song screens (never the player, never while separating), only after the visitor taps Allow in the consent banner. `ads.txt` and `privacy.html` exist. Because the app is on a subdomain, `https://fsiq.com/ads.txt` (root) must also contain `subdomain=stemroom.fsiq.com`. EEA/UK/CH also needs Google's certified consent message turned on in AdSense (Privacy & messaging). AdSense needs an own domain and may reject a tool-only site, so the content pages in Next up are still needed.
- Player: `js/engine.js` plus `js/mixer.worklet.js` (own WSOLA pitch-preserving time-stretch, A-B loop, count-in). Storage in IndexedDB (`js/db.js`).
- Paste-a-link import supports direct, Dropbox and Google Drive links only. YouTube, Spotify and similar are deliberately refused.
- `gpu.html` is an experimental WebGPU test page.

## Rules and gotchas
- `wrangler.jsonc` (assets directory `.`, empty `previews` block) is needed because Cloudflare runs `wrangler preview` for non-production branches. `.assetsignore` keeps `tools/`, `.github/`, docs and config out of the site. Check with `npx wrangler deploy --dry-run`.
- Cloudflare has a 25 MiB per-file limit. Keep model parts and built files under it (`tools/build.mjs` checks).
- npm, pypi and Hugging Face may be unreachable in some sandboxes. `vendor/` is built by GitHub Actions (`build.yml`) and committed by a bot, so run `git fetch && git rebase origin/main` before pushing.
- Local branch may be `master`: push with `git push origin master:main`.
- `_headers` no longer sends COOP/COEP. Google ad iframes cannot load on a cross-origin-isolated page, so isolation was dropped. The CPU engine therefore runs single-threaded (about 1.5x slower, 2.2 s per audio second instead of 1.5); the GPU engine is unaffected. To go back, restore COOP `same-origin` + COEP `require-corp` in `_headers` and `tools/serve.mjs`, and remove ads.
- Service worker `sw.js`: network-first for the app shell, cache-first for model files (cache `stemroom-model`). Bump it when changing cached assets.
- Tests: `node tools/e2e.mjs` (mock; `--real` uses the real model), `tools/test-worklet.mjs`, `tools/test-lean.mjs`, `tools/e2e-gpu.mjs`. CI cannot test real WebGPU (no `shader-f16` on SwiftShader), so GPU quality needs a device check.

## Next up
1. Startup device-compatibility check (message such as "Fast mode available" or "can play but may not separate"), storage display, first-visit download notice.
2. Public launch pages: done (see Site layout). Still needed: a legal read of terms and privacy.
3. Google AdSense (not Google Ads): code is in place (see Ads above). Fairuz applies himself on an own domain, then fills `js/ads-config.js` and `ads.txt`.
4. Still unreported: integrated fast-engine result on iPad (sound quality, timings) and the iPhone GPU result.

## Minimum user requirements
- Fast engine: WebGPU with shader-f16 (recent Safari on iPadOS/iOS 26+), about 8 GB RAM.
- Compatible engine: any recent browser with WebAssembly, workers and AudioWorklet (iPad ok, iPhone not).
- Playback of saved songs: any recent browser.
- One-time download of 120-170 MB; about 300 MB for models plus about 130 MB per saved 3-min song.
