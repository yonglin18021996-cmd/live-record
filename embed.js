/**
 * embed.js — speaker embedding bằng WavLM (Xenova/wavlm-base-plus-sv).
 * Chạy trong browser, tải model 1 lần từ HuggingFace CDN rồi cache.
 *
 * Vì sao cần model: xem đầu file diar.js — MFCC không tách được người nói.
 */
const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
const MODEL_ID = 'Xenova/wavlm-base-plus-sv';

let lib = null;
let processor = null;
let model = null;
let loading = null;
let ready = false;

export function isReady() { return ready; }

/**
 * @param {(p:{status:string,loaded:number,total:number,file?:string})=>void} [onProgress]
 */
export async function loadEmbedder(onProgress) {
  if (ready) return;
  if (loading) return loading;
  loading = (async () => {
    lib = await import(LIB_URL);
    try { lib.env.allowLocalModels = false; } catch {}
    const cb = onProgress
      ? (p) => onProgress({ status: p.status, loaded: p.loaded || 0, total: p.total || 0, file: p.file })
      : undefined;
    processor = await lib.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: cb });
    model = await lib.AutoModelForXVector.from_pretrained(MODEL_ID, { dtype: 'q8', progress_callback: cb });
    ready = true;
  })();
  return loading;
}

/** L2 normalize vector 512 chiều. */
function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
  return o;
}

/**
 * @param {Float32Array} pcm mono 16kHz
 * @returns {Promise<Float32Array>} embedding 512 chiều đã chuẩn hoá
 */
export async function embed(pcm) {
  await loadEmbedder();
  const feats = await processor(pcm);
  const out = await model(feats);
  const e = out.embeddings ? out.embeddings.data : out.last_hidden_state.data;
  return l2(e);
}
