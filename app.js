/**
 * app.js — ghi âm PCM liên tục → chunk 10s → (embedding giọng) → ASR + dịch → hiển thị.
 * Transport: net.js (GAS /exec hoặc server.js /exec).
 * Tách người nói: embed.js (WavLM) + diar.js (clustering).
 */
import { gasPost, gasStream, apiInfo } from './net.js';
import './diar.js';
import './vad.js';
import { loadEmbedder, embed } from './embed.js';

const Diar = globalThis.Diar;
const Vad = globalThis.Vad;
const QS = new URLSearchParams(location.search);
const CHUNK_MAX_MS = Math.min(8000, Math.max(3000, Number(QS.get('maxchunk')) || 5000));
const TARGET_SR = 16000;
const RING_LEN = 289; // 2πr, r=46
const DIAR_ON = QS.get('diar') !== '0';

const vad = Vad.create({ maxMs: CHUNK_MAX_MS });

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const finalEl = $('final');
const clockEl = $('clock');
const dotEl = $('dot');
const queueEl = $('queue');
const msgEl = $('msg');
const gasEl = $('gas');
const recBtn = $('rec');
const ringFg = $('ringFg');
const btnSummary = $('btnSummary');
const toggleZh = $('toggleZh');
const modelSel = $('model');
const mdotEl = $('mdot');

/* Danh mục model dự phòng nếu server không trả (bình thường list lấy từ server mỗi lần load) */
const MODELS = [
  { id: 'glm-5.3-flashx', label: 'GLM 5.3 FlashX' },
  { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash' },
  { id: 'deepseek-v4.1-flash', label: 'DS v4.1 Flash' },
  { id: 'minimax-m3.1-flash', label: 'MiniMax M3.1' },
  { id: 'space-bunny', label: 'Space Bunny' },
];
let MODEL_LABEL = Object.fromEntries(MODELS.map((m) => [m.id, m.label]));
let modelHealth = {}; // id -> {ok, ms, err} — từ action model.health
let chainArr = ['glm-5.3-flashx', 'deepseek-v4.1-flash', 'minimax-m3.1-flash']; // thứ tự fallback, server trả về khi boot

const diar = Diar.create();
let embReady = false;
let embLoading = false;

let ctx = null, mic = null, src = null, proc = null, sink = null;
let sampleRate = 48000;
let recording = false, startedAt = 0, tick = null, wakeLock = null;
let queue = [], busy = false;
let items = [];
let summaryText = '';
let recordedSec = 0;
let startIso = '';
let sessionSeq = 0;   // tăng mỗi phiên → vô hiệu job của phiên cũ
let dirty = false;   // có nội dung chưa lưu

/* ---------- utils ---------- */
const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const clockNow = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function setDot(mode) { dotEl.className = 'dot' + (mode ? ' ' + mode : ''); }
function msg(t, ms = 4000) {
  msgEl.textContent = t || '';
  if (t) setTimeout(() => { if (msgEl.textContent === t) msgEl.textContent = ''; }, ms);
}
function setGas(state, label) {
  gasEl.className = state || '';
  gasEl.textContent = label || '…';
}

/* ---------- chọn model + báo health ---------- */
/** Danh mục model REFRESH mỗi lần load: lấy từ server (action health), không hardcode. */
async function initModelSelect() {
  let h = null;
  try { h = await gasPost('health', {}, { timeout: 15000 }); } catch {}
  const list = h && h.models && Object.keys(h.models).length
    ? Object.keys(h.models).map((id) => ({ id, label: String(h.models[id] || id) }))
    : MODELS;
  if (h && Array.isArray(h.chain) && h.chain.length) chainArr = h.chain;
  MODEL_LABEL = Object.fromEntries(list.map((m) => [m.id, m.label]));

  modelSel.innerHTML = '';
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  }
  const saved = localStorage.getItem('lr.model');
  const def = (h && h.default) || list[0].id;
  modelSel.value = list.some((m) => m.id === saved) ? saved : def;
  localStorage.setItem('lr.model', modelSel.value);
}
const modelOf = () => modelSel.value;

function updateModelDot() {
  const s = modelHealth[modelOf()];
  mdotEl.className = 'dot' + (s ? (s.ok ? ' ok' : ' err') : '');
  const parts = [...modelSel.options].map((o) => {
    const st = modelHealth[o.value];
    return `${o.textContent}: ${st ? (st.ok ? 'ok ' + Math.round(st.ms) + 'ms' : 'LỖI') : '?'}`;
  });
  mdotEl.title = parts.join('\n');
}

async function probeModels() {
  try {
    const h = await gasPost('model.health', {}, { timeout: 45000 });
    modelHealth = h.models || {};
    if (Array.isArray(h.chain) && h.chain.length) chainArr = h.chain;
    updateModelDot();
    return h;
  } catch {
    return null;
  }
}

/** Model đang chọn chết → tự chuyển sang model kế trong chuỗi fallback còn sống. */
async function failoverModel() {
  await probeModels();
  const cur = modelOf();
  if (modelHealth[cur] && modelHealth[cur].ok) return false;
  const alive = Object.keys(modelHealth).filter((k) => modelHealth[k].ok);
  if (!alive.length) { msg('Tất cả model dịch đều lỗi — kiểm tra mạng/gateway', 8000); return false; }
  const next = chainArr.find((k) => alive.includes(k)) || alive[0];
  modelSel.value = next;
  localStorage.setItem('lr.model', next);
  updateModelDot();
  msg(`Model ${MODEL_LABEL[cur] || cur} lỗi — đã chuyển sang ${MODEL_LABEL[next] || next}`, 9000);
  return true;
}

modelSel.addEventListener('change', () => {
  localStorage.setItem('lr.model', modelSel.value);
  updateModelDot();
  if (!modelHealth[modelSel.value]) probeModels();
});
mdotEl.addEventListener('click', () => probeModels());

function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] !== undefined ? input[i0 + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** Float32 PCM → Uint8Array WAV PCM16 mono */
function encodeWavBytes(float32, sr) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

function b64of(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function b64utf8(s) {
  const b = new TextEncoder().encode(s);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

/* ---------- render ---------- */
const SPK_CLASS = (id) => (id && /^V[1-6]$/.test(id) ? 'v' + id.slice(1) : '');

function makeItem(time, spk) {
  const el = document.createElement('div');
  el.className = 'it';
  el.innerHTML =
    `<div class="head"><span class="spk ${SPK_CLASS(spk.id)}">${spk.name || spk.id || '?'}</span>` +
    `<span class="tm">${time}</span></div><div class="zh"></div><div class="vi live"></div>`;
  listEl.appendChild(el);
  listEl.scrollTop = listEl.scrollHeight;
  const chip = el.querySelector('.spk');
  chip.addEventListener('click', () => openSpeakerSheet(spk.id, chip));
  return { el, chip, zh: el.querySelector('.zh'), vi: el.querySelector('.vi') };
}
function renderError(time, text) {
  const el = document.createElement('div');
  el.className = 'it';
  el.innerHTML = `<div class="tm">${time}</div><div class="err"></div>`;
  el.querySelector('.err').textContent = text;
  listEl.appendChild(el);
  listEl.scrollTop = listEl.scrollHeight;
}

/* ---------- speaker sheet ---------- */
let sheetTarget = null;
function openSpeakerSheet(id, chipEl) {
  if (!id || id === '?') return;
  sheetTarget = { id, chipEl };
  $('spkTitle').textContent = 'Người nói ' + id;
  $('inName').value = diar.nameOf(id) === id ? '' : diar.nameOf(id);
  $('spkSheet').classList.add('on');
}
$('btnSpkCancel').addEventListener('click', () => $('spkSheet').classList.remove('on'));
$('btnSpkSave').addEventListener('click', () => {
  const name = $('inName').value.trim();
  if (sheetTarget && name) {
    diar.rename(sheetTarget.id, name);
    const label = name;
    document.querySelectorAll('.spk').forEach((c) => {
      if (c.textContent === sheetTarget.id) c.textContent = label;
    });
    if (sheetTarget.chipEl) sheetTarget.chipEl.textContent = label;
    items.forEach((i) => { if (i.spk === sheetTarget.id) i.spkName = label; });
  }
  $('spkSheet').classList.remove('on');
  syncSpeakers();
  // tên Latin vừa đặt cũng vào bảng tên để lần sau dịch giữ nguyên, không Hán-Việt hóa
  if (name && /^[A-Za-z][A-Za-z .'-]{1,20}$/.test(name)) {
    gasPost('names.put', { names: [{ alias: name, display: name }] }, { timeout: 20000 }).catch(() => {});
  }
});

/* ---------- ghi âm ---------- */
function setRing(p) {
  ringFg.style.strokeDashoffset = String(RING_LEN * (1 - Math.max(0, Math.min(1, p))));
}

/** Chụp dữ liệu phiên hiện tại thành payload gửi Telegram: bản gốc nguyên văn + tóm tắt. */
function snapshot() {
  const rows = items.map((i) => ({ t: i.t, spk: i.spk, spkName: i.spkName, zh: i.zh, vi: i.vi }));
  const transcript = rows
    .filter((r) => (r.zh || '').trim())
    .map((r) => `[${r.t}] ${r.spkName || r.spk || ''}: ${r.zh}`)
    .join('\n'); // CHỈ văn bản gốc (Trung/Anh) — không kèm bản dịch
  return {
    transcript, summaryText: summaryText.trim(), lines: rows,
    duration: recordedSec, speakerCount: diar.speakerCount,
    summary: summaryText.trim() ? 1 : 0, startedAt: startIso,
    device: navigator.userAgent.slice(0, 60),
  };
}

/** Gửi bản cũ lên Telegram trước khi xoá — chạy nền, không chặn ghi âm. */
function flushToTelegram() {
  if (!items.length) return;
  const payload = snapshot();
  gasPost('save', payload, { timeout: 60000 }).catch(() => {});
}

/** Bắt đầu phiên mới: xoá sạch hiển thị. Không đụng tới diar (tên người nói phải sống qua phiên). */
function resetSession() {
  sessionSeq++;
  items = [];
  summaryText = '';
  recordedSec = 0;
  startIso = '';
  dirty = false;

  listEl.innerHTML = '';
  listEl.style.display = '';
  listEl.scrollTop = 0;
  finalEl.classList.remove('on');
  finalEl.textContent = '';

  clockEl.textContent = '00:00:00';
  queueEl.textContent = '';
  setRing(0);

  btnSummary.hidden = true;
  btnSummary.disabled = false;
  btnSummary.textContent = 'Tóm tắt';
  msg('');
}

/** Một câu đã chốt (VAD) → vào hàng đợi. */
function enqueueSegment(pcm) {
  if (!pcm || pcm.length < TARGET_SR * 0.4) return;
  if (Diar.rmsDb(pcm) < -55) return; // bỏ đoạn im lặng
  queue.push({ pcm, t: clockNow(), sid: sessionSeq });
  queueEl.textContent = queue.length ? `${queue.length} chờ` : '';
  pump();
}

async function speakerOf(pcm) {
  if (!DIAR_ON || !embReady) return { id: '?', name: '?' };
  try {
    const e = await embed(pcm);
    const r = diar.processEmbedding(e);
    return { id: r.speaker, name: diar.nameOf(r.speaker), conf: r.conf, low: r.lowconf };
  } catch {
    return { id: '?', name: '?' };
  }
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  setDot(recording ? 'live' : 'busy');
  const job = queue[0];
  // job của phiên đã bị xoá → bỏ, không gọi mạng
  if (job.sid !== sessionSeq) { queue.shift(); busy = false; setDot(recording ? 'live' : ''); pump(); return; }

  const ui = makeItem(job.t, { id: '?', name: '?' });

  let zh = '';
  let viAcc = '';
  let streamErr = null;
  let streamCode = '';
  let asrMs = 0;
  let totalMs = 0;
  let requeue = false;

  try {
    const hint = b64utf8(items.slice(-2).map((i) => i.zh).join(' ').slice(0, 300));
    const ctxStr = items.slice(-3).map((i) => `${i.zh}\n→ ${i.vi}`).join('\n');
    const b64 = b64of(encodeWavBytes(job.pcm, TARGET_SR));

    // SSE: chữ Trung về trước (~0.5s sau khi chốt câu), bản dịch chạy dần sau đó
    await gasStream(
      { b64, hint, ctx: ctxStr, speaker: null, model: modelOf() },
      (ev) => {
        if (ev.e) { streamErr = ev.e; streamCode = ev.code || 'INTERNAL'; return; }
        if (ev.zh !== undefined) {
          zh = String(ev.zh || '');
          if (zh) ui.zh.textContent = zh;
          asrMs = ev.asrMs || 0;
          if (ev.ms) totalMs = ev.ms;
        }
        if (ev.reset) { viAcc = ''; ui.vi.textContent = ''; }
        if (ev.d) {
          viAcc += ev.d;
          ui.vi.textContent = viAcc;
          ui.vi.classList.remove('live');
          listEl.scrollTop = listEl.scrollHeight;
        }
      },
      { timeout: 90000 }
    );

    if (!zh) { ui.el.remove(); throw Object.assign(new Error(''), { silent: true }); }
    if (streamErr && !viAcc) throw Object.assign(new Error(streamErr), { code: streamCode });

    ui.vi.classList.remove('live');
    const vi = viAcc.trim();
    ui.vi.textContent = vi;

    // Chỉ chạy tách người nói khi transcript đủ dài — câu cụt vài chữ làm bẩn centroid,
    // sinh ra cụm rác (V3, V4…) cho cùng một người.
    let spk = { id: '?', name: '?' };
    if (zh.length >= 8) {
      spk = await speakerOf(job.pcm);
      ui.chip.textContent = spk.name || spk.id;
      ui.chip.className = 'spk ' + SPK_CLASS(spk.id) + (spk.low ? ' low' : '');
    }

    if (job.sid !== sessionSeq) { ui.el.remove(); queue.shift(); busy = false; setDot(recording ? 'live' : ''); pump(); return; }

    const it = { t: job.t, zh, vi, zone: spk.id === '?' ? null : spk.id, spk: spk.id, spkName: spk.name };
    items.push(it);
    dirty = true;
    btnSummary.hidden = recording || !items.length;
    updateGasFromLatency(asrMs, 0, totalMs || asrMs);
  } catch (e) {
    if (!e.silent) {
      ui.el.remove();
      renderError(job.t, e.message || String(e));
      if (e.code === 'WB_BLOCKED_IP') { setGas('err', 'chặn'); msg(e.message, 9000); }
      else if (e.code === 'AUTH') { setGas('err', 'token'); msg(e.message, 9000); }
      else msg(e.message || 'lỗi', 5000);
      // lỗi có thể do model/gateway sập → probe health; model chết thì tự chuyển + thử lại đoạn này 1 lần
      if (e.code !== 'AUTH' && e.code !== 'WB_BLOCKED_IP' && e.code !== 'TIMEOUT') {
        requeue = await failoverModel();
      }
    }
  }

  queue.shift();
  if (requeue && !job.retried) {
    job.retried = true;
    queue.unshift(job);
    queueEl.textContent = queue.length ? `${queue.length} chờ` : '';
  }
  busy = false;
  queueEl.textContent = queue.length ? `${queue.length} chờ` : '';
  setDot(recording ? 'live' : '');
  pump();
}

function updateGasFromLatency(asrMs, trMs, totalMs) {
  const t = totalMs || ((asrMs || 0) + (trMs || 0));
  if (!t) return;
  if (t < 8000) setGas('ok', Math.round(t / 1000) + 's');
  else setGas('slow', Math.round(t / 1000) + 's');
}

async function startRec() {
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    return msg('Không mở được micro: ' + e.message, 6000);
  }

  // phiên trước còn nội dung chưa lưu → gửi Telegram rồi mới xoá
  if (dirty) flushToTelegram();
  resetSession();

  // tải model giọng song song, không chặn ghi âm
  if (DIAR_ON && !embReady && !embLoading) {
    embLoading = true;
    setGas('slow', 'tải model');
    loadEmbedder((p) => {
      if (p.total) setGas('slow', Math.round((p.loaded / p.total) * 100) + '%');
    })
      .then(() => { embReady = true; setGas('ok', 'sẵn sàng'); })
      .catch(() => { embLoading = false; setGas('err', 'no model'); msg('Không tải được model giọng — vẫn ghi âm, không tách người nói', 7000); });
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  try { ctx = new AC({ sampleRate: TARGET_SR }); } catch { ctx = new AC(); }
  await ctx.resume().catch(() => {});
  sampleRate = ctx.sampleRate;

  src = ctx.createMediaStreamSource(mic);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);

  proc.onaudioprocess = (e) => {
    const raw = new Float32Array(e.inputBuffer.getChannelData(0));
    const d = sampleRate === TARGET_SR ? raw : resample(raw, sampleRate, TARGET_SR);
    for (const seg of vad.push(d)) enqueueSegment(seg);
  };

  recording = true;
  startedAt = Date.now();
  startIso = new Date().toISOString();
  recBtn.classList.add('on');
  setDot('live');
  clockEl.textContent = '00:00:00';
  btnSummary.hidden = true;
  setRing(0);
  tick = setInterval(() => {
    clockEl.textContent = hhmmss(Date.now() - startedAt);
    setRing(vad.pendingMs / CHUNK_MAX_MS);
  }, 250);
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

async function stopRec() {
  recording = false;
  recordedSec = Math.round((Date.now() - startedAt) / 1000);
  recBtn.classList.remove('on');
  if (tick) { clearInterval(tick); tick = null; }
  for (const seg of vad.flush()) enqueueSegment(seg);
  try { proc && (proc.onaudioprocess = null); } catch {}
  try { src && src.disconnect(); proc && proc.disconnect(); sink && sink.disconnect(); } catch {}
  try { mic && mic.getTracks().forEach((t) => t.stop()); } catch {}
  try { ctx && (await ctx.close()); } catch {}
  ctx = null; mic = null; src = null; proc = null; sink = null;
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
  setDot(busy ? 'busy' : '');
  setRing(0);

  // đợi hàng đợi xử lý xong rồi TỰ LƯU: gửi bản gốc ngay + tóm tắt tự chạy tự gửi Telegram
  let autoSaved = false;
  const tryAutoSave = () => {
    if (autoSaved || busy || queue.length) return;
    autoSaved = true;
    btnSummary.hidden = !items.length;
    if (items.length) autoSave();
  };
  const wait = setInterval(tryAutoSave, 500);
  setTimeout(() => { clearInterval(wait); tryAutoSave(); }, 120000);

  syncSpeakers();
}

async function syncSpeakers() {
  try {
    const profiles = diar.getProfiles();
    if (profiles.length) await gasPost('speakers.put', { profiles, device: navigator.userAgent.slice(0, 60) }, { timeout: 20000 });
  } catch {}
}

/* ---------- panel xem full ---------- */
function showPanel(text) {
  finalEl.classList.add('on');
  listEl.style.display = 'none';
  finalEl.textContent = text;
  finalEl.scrollTop = finalEl.scrollHeight;
}

/* ---------- tóm tắt (map-reduce, có resume) + tự gửi Telegram ---------- */
async function buildSummary() {
  if (!items.length) return;
  const passed = items.filter((i) => i.vi).map((i) => ({ vi: i.vi, t: i.t, spk: i.spkName || i.spk }));
  if (!passed.length) return;

  btnSummary.disabled = true;
  btnSummary.textContent = 'Tóm tắt…';
  showPanel('Đang tóm tắt…');

  try {
    const start = await gasPost('summaryStart', { items: passed, sessionId: 'S' + Date.now(), model: modelOf() }, { timeout: 60000 });
    const jobId = start.jobId;
    const total = start.blocks || 1;
    let step = null;

    for (let guard = 0; guard < 20; guard++) {
      step = await gasPost('summaryStep', { jobId }, { timeout: 280000 });
      btnSummary.textContent = `Tóm tắt ${Math.min(step.doneBlocks, total)}/${total}`;
      showPanel(`Đang tóm tắt ${Math.min(step.doneBlocks, total)}/${total}…`);
      if (step.done) break;
    }

    if (step && step.done) {
      summaryText = step.text || '';
      showPanel(summaryText);
      btnSummary.textContent = 'Xem tóm tắt';
      dirty = false;
      // tự gửi file tóm tắt vào Telegram
      await gasPost('save', { summaryText, sessionId: 'hop-' + stamp() }, { timeout: 60000 });
      msg('Đã gửi tóm tắt vào Telegram', 8000);
      // học tên riêng cho các buổi sau (không chặn UI)
      if (summaryText.length > 40) {
        gasPost('names.extract', { text: summaryText, model: modelOf() }, { timeout: 60000 }).catch(() => {});
      }
    } else {
      showPanel('Tóm tắt chưa xong — bấm lại để chạy tiếp.');
      btnSummary.textContent = 'Tóm tắt';
    }
  } catch (e) {
    showPanel('Lỗi tóm tắt: ' + e.message);
    btnSummary.textContent = 'Tóm tắt';
    msg('Chưa gửi được tóm tắt — bấm nút Tóm tắt để thử lại', 8000);
  }
  btnSummary.disabled = false;
}

/** Tự lưu khi ngưng record: gửi bản gốc NGAY, rồi tự tóm tắt + gửi tiếp. */
async function autoSave() {
  // 1) file văn bản gốc (Trung/Anh) — gửi ngay, không chờ tóm tắt
  try {
    await gasPost('save', snapshot(), { timeout: 60000 });
    msg('Đã gửi bản gốc vào Telegram', 6000);
  } catch (e) {
    msg('Lỗi gửi bản gốc: ' + e.message, 8000);
  }
  // 2) tóm tắt 3 mục tự chạy rồi tự gửi (trong buildSummary)
  await buildSummary();
}

/* ---------- events ---------- */
recBtn.addEventListener('click', () => (recording ? stopRec() : startRec()));
btnSummary.addEventListener('click', () => {
  if (summaryText.trim()) { showPanel(summaryText); return; }
  buildSummary();
});
toggleZh.addEventListener('click', () => {
  document.body.classList.toggle('vi-only');
  toggleZh.classList.toggle('on', !document.body.classList.contains('vi-only'));
});

async function checkHealth() {
  try {
    const t0 = Date.now();
    const h = await gasPost('health', {}, { timeout: 30000 });
    const info = apiInfo();
    setGas(h.wbOk ? 'ok' : 'err', info.isLocal ? 'máy' : info.isWorker ? 'worker' : 'gas');
    if (!h.asrReady) msg('Server chưa có key nhận dạng giọng', 7000);
    else if (!h.wbOk) msg('Server chưa có key dịch', 7000);
    return Date.now() - t0;
  } catch (e) {
    setGas('err', e.code === 'AUTH' ? 'token' : 'lỗi');
    return -1;
  }
}

/* boot */
(async () => {
  // danh mục model REFRESH mỗi lần load từ server + probe health lần đầu
  await initModelSelect();
  probeModels();
  setInterval(() => { if (!recording) probeModels(); }, 300000); // 5 phút/lần khi không ghi âm

  checkHealth();
  setInterval(() => { if (recording) checkHealth(); }, 60000);

  // nạp profile giọng của các buổi trước
  try {
    const r = await gasPost('speakers.get', {}, { timeout: 20000 });
    if (r.profiles && r.profiles.length) diar.loadProfiles(r.profiles);
  } catch {}
})();
