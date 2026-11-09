// Startup device check. Pure function so it can be tested without a browser.
// caps: { gpu, wasm, worker, worklet, audio, idb, phone }
export function assessDevice(caps) {
  if (!caps.audio || !caps.worklet || !caps.idb) {
    return { level: 'none', title: 'This browser can\'t run Stemroom',
      text: 'Stemroom needs a recent Safari, Chrome, Edge or Firefox with audio and offline storage turned on.' };
  }
  if (caps.gpu) {
    return { level: 'fast', title: 'Fast mode available',
      text: 'This device can separate a 3-minute song in about 1 to 2 minutes.' };
  }
  if (caps.wasm && caps.worker && !caps.phone) {
    return { level: 'ok', title: 'Compatible mode available',
      text: 'This device can separate songs, but slowly (about 6 minutes for a 3-minute song). Keep the screen on while it works.' };
  }
  return { level: 'play', title: 'Can play, but may not separate',
    text: 'You can play songs saved on this device. Separating a new song may fail here. For best results, split songs on an iPad or computer.' };
}

export async function detectCaps() {
  let gpu = false;
  try {
    if (navigator.gpu) { const ad = await navigator.gpu.requestAdapter(); gpu = !!(ad && ad.features.has('shader-f16')); }
  } catch {}
  return {
    gpu,
    wasm: typeof WebAssembly === 'object',
    worker: typeof Worker === 'function',
    worklet: typeof AudioWorkletNode === 'function',
    audio: !!(window.AudioContext || window.webkitAudioContext),
    idb: !!window.indexedDB,
    phone: /iPhone|iPod|Android.*Mobile/.test(navigator.userAgent),
  };
}
