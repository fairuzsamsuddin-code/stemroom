// Stand-in for the separation worker, used only by local tests. Same message protocol.
self.onmessage = async (e) => {
  const { left, right } = e.data;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  self.postMessage({ type: 'status', text: 'Loading model', progress: 0.5 });
  await sleep(150);
  for (let i = 1; i <= 5; i++) { self.postMessage({ type: 'progress', progress: i / 5, currentSegment: i, totalSegments: 5 }); await sleep(120); }
  const mk = (k) => { const l = new Float32Array(left.length), r = new Float32Array(right.length); for (let i = 0; i < l.length; i++) { l[i] = left[i] * k; r[i] = right[i] * k; } return { left: l, right: r }; };
  const stems = { drums: mk(0.4), bass: mk(0.3), vocals: mk(0.2), other: mk(0.1) };
  const tr = [];
  for (const s of Object.values(stems)) tr.push(s.left.buffer, s.right.buffer);
  self.postMessage({ type: 'done', stems }, tr);
};
