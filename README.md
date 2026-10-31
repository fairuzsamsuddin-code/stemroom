# Stemroom

Split a song into drums, bass, vocals and guitar-and-keys on your own device, then mute the part you play and practise along.

- Static site on Cloudflare Pages. Separation runs in the browser (CPU, WebAssembly). Nothing is uploaded.
- `index.html`, `css/`, `js/`: the app. `js/mixer.worklet.js` is the audio engine (mixing, A-B loop, speed change that keeps pitch).
- `src/separate.worker.js`: the separation worker. `vendor/` is built from it by `tools/build.mjs` (run by the GitHub Action "Build and test", which also runs the tests and commits `vendor/`).
- `model/`: the HTDemucs model in 20 MB parts (written by the "Fetch model" action). See `MODEL-LICENSE.md`.
- Tests: `node tools/test-worklet.mjs` (audio engine), `node tools/e2e.mjs` (whole app in headless Chromium).
