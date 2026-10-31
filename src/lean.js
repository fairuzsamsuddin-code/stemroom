// Memory-lean version of demucs-web's separate(): same maths, but the frequency branch is converted one stem
// at a time, buffers are reused between segments, and overlap-add happens in place. Output is identical.
import { CONSTANTS, istft, prepareModelInput } from 'demucs-web';

const { FFT_SIZE, HOP_SIZE, TRAINING_SAMPLES: T, MODEL_SPEC_BINS: B, MODEL_SPEC_FRAMES: F, SEGMENT_OVERLAP } = CONSTANTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function leanSeparate({ session, ort, left, right, onProgress = () => {}, pauseMs = 0 }) {
  const total = left.length;
  const stride = Math.floor(T * (1 - SEGMENT_OVERLAP));
  const numSegments = Math.ceil((total - T) / stride) + 1;
  const outL = [0, 1, 2, 3].map(() => new Float32Array(total));
  const outR = [0, 1, 2, 3].map(() => new Float32Array(total));
  const weights = new Float32Array(total);

  const pBins = B + 1, pFrames = F + 4;
  const istftLength = (pFrames - 1) * HOP_SIZE + FFT_SIZE;
  const offset = FFT_SIZE / 2 + Math.floor(HOP_SIZE / 2) * 3;
  const re = [new Float32Array(pFrames * pBins), new Float32Array(pFrames * pBins)];
  const im = [new Float32Array(pFrames * pBins), new Float32Array(pFrames * pBins)];
  const segL = new Float32Array(T), segR = new Float32Array(T);
  let seg = 0;

  for (let start = 0; start < total; start += stride) {
    const segLen = Math.min(start + T, total) - start;
    segL.fill(0); segR.fill(0);
    for (let i = 0; i < segLen; i++) { segL[i] = left[start + i]; segR[i] = right[start + i]; }

    let input = prepareModelInput(segL, segR);
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', input.waveform, [1, 2, T]);
    if (session.inputNames.length > 1) feeds[session.inputNames[1]] = new ort.Tensor('float32', input.magSpec, [1, 4, B, F]);
    input = null;
    const res = await session.run(feeds);

    let timeData = null, timeShape = null, freqData = null;
    for (const name of session.outputNames) {
      const t = res[name];
      if (t.dims.length === 4 && t.dims[2] === 2) { timeData = t.data; timeShape = t.dims; }
      else if (t.dims.length === 5 && t.dims[2] === 4) freqData = t.data;
    }
    if (!timeData) throw new Error('Could not find the time-domain output');
    const samples = timeShape[3];

    const win = new Float32Array(segLen);
    for (let i = 0; i < segLen; i++) win[i] = Math.min(Math.min(i / (stride * 0.5), 1), Math.min((segLen - i) / (stride * 0.5), 1));

    for (let t = 0; t < 4; t++) {
      let fl = null, fr = null;
      if (freqData) {
        const base = t * 4 * B * F;
        for (let c = 0; c < 2; c++) {
          re[c].fill(0); im[c].fill(0);
          const reOff = base + (c * 2) * B * F, imOff = base + (c * 2 + 1) * B * F;
          for (let f = 0; f < F; f++) {
            const dstRow = (f + 2) * pBins;
            for (let b = 0; b < B; b++) { re[c][dstRow + b] = freqData[reOff + b * F + f]; im[c][dstRow + b] = freqData[imOff + b * F + f]; }
          }
        }
        fl = istft(re[0], im[0], pFrames, pBins, FFT_SIZE, HOP_SIZE, istftLength);
        fr = istft(re[1], im[1], pFrames, pBins, FFT_SIZE, HOP_SIZE, istftLength);
      }
      const tl = t * 2 * samples, tr = tl + samples;
      for (let i = 0; i < segLen && start + i < total; i++) {
        const l = freqData ? timeData[tl + i] + (fl[offset + i] || 0) : timeData[tl + i];
        const r = freqData ? timeData[tr + i] + (fr[offset + i] || 0) : timeData[tr + i];
        outL[t][start + i] += l * win[i];
        outR[t][start + i] += r * win[i];
      }
    }
    for (let i = 0; i < segLen && start + i < total; i++) weights[start + i] += win[i];

    for (const k of Object.keys(res)) { try { res[k].dispose && res[k].dispose(); } catch {} }
    for (const k of Object.keys(feeds)) { try { feeds[k].dispose && feeds[k].dispose(); } catch {} }
    seg++;
    onProgress({ progress: seg / numSegments, currentSegment: seg, totalSegments: numSegments });
    if (pauseMs) await sleep(pauseMs);
  }

  for (let t = 0; t < 4; t++) for (let i = 0; i < total; i++) if (weights[i] > 0) { outL[t][i] /= weights[i]; outR[t][i] /= weights[i]; }
  return { drums: { left: outL[0], right: outR[0] }, bass: { left: outL[1], right: outR[1] }, other: { left: outL[2], right: outR[2] }, vocals: { left: outL[3], right: outR[3] } };
}
