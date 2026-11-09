import { assessDevice } from '../js/compat.js';
const base = { gpu: false, wasm: true, worker: true, worklet: true, audio: true, idb: true, phone: false };
const cases = [
  [{ gpu: true }, 'fast'], [{}, 'ok'], [{ phone: true }, 'play'], [{ wasm: false }, 'play'],
  [{ worklet: false }, 'none'], [{ idb: false, gpu: true }, 'none'],
];
let bad = 0;
for (const [o, want] of cases) { const got = assessDevice({ ...base, ...o }).level; const ok = got === want; if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + JSON.stringify(o) + ' -> ' + got); }
process.exit(bad ? 1 : 0);
