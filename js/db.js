// Library storage in IndexedDB. Stems are kept as 16-bit planar PCM (all left samples, then all right).
const NAME = 'stemroom', VERSION = 1;
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(NAME, VERSION);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      d.createObjectStore('songs', { keyPath: 'id' });
      d.createObjectStore('stems');
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const wrap = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
async function tx(stores, mode, fn) {
  const d = await db();
  const t = d.transaction(stores, mode);
  const out = await fn(t);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return out;
}

export const listSongs = async () => (await tx('songs', 'readonly', (t) => wrap(t.objectStore('songs').getAll()))).sort((a, b) => b.created - a.created);
export const getSong = (id) => tx('songs', 'readonly', (t) => wrap(t.objectStore('songs').get(id)));
export const putSong = (song) => tx('songs', 'readwrite', (t) => wrap(t.objectStore('songs').put(song)));
export const putStem = (id, name, buf) => tx('stems', 'readwrite', (t) => wrap(t.objectStore('stems').put(buf, id + ':' + name)));
export const getStem = (id, name) => tx('stems', 'readonly', (t) => wrap(t.objectStore('stems').get(id + ':' + name)));
export async function deleteSong(id) {
  await tx(['songs', 'stems'], 'readwrite', async (t) => {
    t.objectStore('songs').delete(id);
    for (const n of ['drums', 'bass', 'vocals', 'other']) t.objectStore('stems').delete(id + ':' + n);
  });
}

export function toInt16Planar(l, r) {
  const n = l.length, out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    let a = l[i], b = r[i];
    a = a > 1 ? 1 : a < -1 ? -1 : a; b = b > 1 ? 1 : b < -1 ? -1 : b;
    out[i] = a < 0 ? a * 32768 : a * 32767;
    out[n + i] = b < 0 ? b * 32768 : b * 32767;
  }
  return out.buffer;
}
export function fromInt16Planar(buf) {
  const i16 = new Int16Array(buf), n = i16.length / 2, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = i16[i] / 32768; r[i] = i16[n + i] / 32768; }
  return { l, r };
}
