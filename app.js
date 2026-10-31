/**
 * app.js — ghi âm PCM liên tục → chunk 10s → (embedding giọng) → ASR + dịch → hiển thị.
 * Transport: net.js (GAS /exec hoặc server.js /exec).
 * Tách người nói: embed.js (WavLM) + diar.js (clustering).
 */
import { gasPost, needSetup, setConfig, getConfig } from './net.js';
import './diar.js';
import { loadEmbedder, embed } from './embed.js';

const Diar = globalThis.Diar;
const QS = new URLSearchParams(location.search);
let CHUNK_SEC = Math.min(60, Math.max(4, Number(QS.get('chunk')) || 10));
const MIN_TAIL_SEC = 2;
const TARGET_SR = 16000;
const RING_LEN = 289; // 2πr, r=46
const DIAR_ON = QS.get('diar') !== '0';

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
const btnFinal = $('btnFinal');
const btnSummary = $('btnSummary');
const btnSave = $('btnSave');
const toggleZh = $('toggleZh');

const diar = Diar.create();
let embReady = false;
let embLoading = false;

let ctx = null, mic = null, src = null, proc = null, sink = null;
let sampleRate = 48000;
let blocks = [], blockLen = 0;
let recording = false, startedAt = 0, tick = null, wakeLock = null;
let queue = [], busy = false;
let items = [];
let finalText = '';
let summaryText = '';
let recordedSec = 0;
let startIso = '';

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

function flushChunk(force = false) {
  if (!sampleRate || !blockLen) return;
  if (!force && blockLen < sampleRate * CHUNK_SEC) return;
  if (blockLen < sampleRate * MIN_TAIL_SEC) { blocks = []; blockLen = 0; setRing(0); return; }

  const all = new Float32Array(blockLen);
  let o = 0;
  for (const b of blocks) { all.set(b, o); o += b.length; }
  blocks = []; blockLen = 0;
  setRing(0);

  const pcm = resample(all, sampleRate, TARGET_SR);
  if (Diar.rmsDb(pcm) < -55) return; // bỏ chunk im lặng

  queue.push({ pcm, t: clockNow() });
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

  const ui = makeItem(job.t, { id: '?', name: '?' });

  try {
    const hint = b64utf8(items.slice(-2).map((i) => i.zh).join(' ').slice(0, 300));
    const ctxStr = items.slice(-3).map((i) => `${i.zh}\n→ ${i.vi}`).join('\n');
    const b64 = b64of(encodeWavBytes(job.pcm, TARGET_SR));

    const r = await gasPost('chunk', { b64, hint, ctx: ctxStr, speaker: null }, { timeout: 90000 });
    const zh = String(r.zh || '').trim();
    if (!zh) { ui.el.remove(); throw Object.assign(new Error(''), { silent: true }); }

    ui.zh.textContent = zh;
    const vi = String(r.vi || '').trim();
    ui.vi.classList.remove('live');
    ui.vi.textContent = vi;

    // Chỉ chạy tách người nói khi transcript đủ dài — chunk cụt vài chữ làm bẩn centroid,
    // sinh ra cụm rác (V3, V4…) cho cùng một người.
    let spk = { id: '?', name: '?' };
    if (zh.length >= 8) {
      spk = await speakerOf(job.pcm);
      ui.chip.textContent = spk.name || spk.id;
      ui.chip.className = 'spk ' + SPK_CLASS(spk.id) + (spk.low ? ' low' : '');
    }

    const it = { t: job.t, zh, vi, zone: spk.id === '?' ? null : spk.id, spk: spk.id, spkName: spk.name };
    items.push(it);
    btnFinal.disabled = false;
    btnSave.disabled = false;
    btnSummary.hidden = recording || !items.length;
    updateGasFromLatency(r.asrMs, r.trMs, r.ms);
  } catch (e) {
    if (!e.silent) {
      ui.el.remove();
      renderError(job.t, e.message || String(e));
      if (e.code === 'WB_BLOCKED_IP') { setGas('err', 'chặn'); msg(e.message, 9000); }
      else if (e.code === 'AUTH') { setGas('err', 'token'); msg(e.message, 9000); }
      else msg(e.message || 'lỗi', 5000);
    }
  }

  queue.shift();
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
  if (needSetup()) { $('setup').classList.add('on'); return; }

  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    return msg('Không mở được micro: ' + e.message, 6000);
  }

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

  blocks = []; blockLen = 0;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    blocks.push(new Float32Array(d));
    blockLen += d.length;
    if (blockLen >= sampleRate * CHUNK_SEC) flushChunk();
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
    if (sampleRate) setRing(blockLen / (sampleRate * CHUNK_SEC));
  }, 250);
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

async function stopRec() {
  recording = false;
  recordedSec = Math.round((Date.now() - startedAt) / 1000);
  recBtn.classList.remove('on');
  if (tick) { clearInterval(tick); tick = null; }
  flushChunk(true);
  try { proc && (proc.onaudioprocess = null); } catch {}
  try { src && src.disconnect(); proc && proc.disconnect(); sink && sink.disconnect(); } catch {}
  try { mic && mic.getTracks().forEach((t) => t.stop()); } catch {}
  try { ctx && (await ctx.close()); } catch {}
  ctx = null; mic = null; src = null; proc = null; sink = null;
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
  setDot(busy ? 'busy' : '');
  setRing(0);

  // đợi hàng đợi xử lý xong rồi mới hiện Tóm tắt
  const wait = setInterval(() => {
    if (!busy && !queue.length) {
      clearInterval(wait);
      btnSummary.hidden = !items.length;
    }
  }, 500);
  setTimeout(() => { clearInterval(wait); btnSummary.hidden = !items.length; }, 120000);

  syncSpeakers();
}

async function syncSpeakers() {
  try {
    const profiles = diar.getProfiles();
    if (profiles.length) await gasPost('speakers.put', { profiles, device: navigator.userAgent.slice(0, 60) }, { timeout: 20000 });
  } catch {}
}

/* ---------- bản chuẩn ---------- */
function showPanel(text) {
  finalEl.classList.add('on');
  listEl.style.display = 'none';
  finalEl.textContent = text;
  finalEl.scrollTop = finalEl.scrollHeight;
}

async function buildFinal() {
  if (!items.length) return;
  showPanel('');
  btnFinal.disabled = true;
  finalText = '';
  try {
    const r = await gasPost('final', { items: items.map((i) => ({ zh: i.zh })) }, { timeout: 180000 });
    finalText = r.text || '';
    showPanel(finalText);
    // tự học tên riêng cho các buổi sau (không chặn UI)
    if (finalText.length > 40) {
      gasPost('names.extract', { text: finalText }, { timeout: 60000 }).catch(() => {});
    }
  } catch (e) {
    msg('Lỗi bản chuẩn: ' + e.message, 6000);
    listEl.style.display = '';
    finalEl.classList.remove('on');
  }
  btnFinal.disabled = false;
}

/* ---------- tóm tắt (map-reduce, có resume) ---------- */
async function buildSummary() {
  if (!items.length) return;
  const passed = items.filter((i) => i.vi).map((i) => ({ vi: i.vi, t: i.t, spk: i.spkName || i.spk }));
  if (!passed.length) return;

  btnSummary.disabled = true;
  btnSummary.textContent = 'Tóm tắt…';
  showPanel('Đang tóm tắt…');

  try {
    const start = await gasPost('summaryStart', { items: passed, sessionId: 'S' + Date.now() }, { timeout: 60000 });
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
      btnSave.disabled = false;
    } else {
      showPanel('Tóm tắt chưa xong — bấm lại để chạy tiếp.');
      btnSummary.textContent = 'Tóm tắt';
    }
  } catch (e) {
    showPanel('Lỗi tóm tắt: ' + e.message);
    btnSummary.textContent = 'Tóm tắt';
  }
  btnSummary.disabled = false;
}

async function saveAll() {
  const body = summaryText.trim() ? summaryText.trim() : finalText.trim();
  const md = body
    ? `# Biên bản họp — ${stamp()}\n\n${body}\n`
    : `# Biên bản họp — ${stamp()}\n\n${items.map((i) => `**[${i.t}] ${i.spkName || ''}** ${i.vi}`).join('\n\n')}\n`;

  // transcript đầy đủ dạng text nhẹ
  const txt =
    `# ${stamp()}\n\n` +
    items.map((i) => `[${i.t}] ${i.spkName || i.spk || ''}: ${i.vi}`).join('\n') +
    (summaryText.trim() ? `\n\n--- TÓM TẮT ---\n\n${summaryText.trim()}\n` : '');

  try {
    const r = await gasPost('save', {
      md,
      txt,
      lines: items.map((i) => ({ t: i.t, spk: i.spk, spkName: i.spkName, zh: i.zh, vi: i.vi })),
      duration: recordedSec,
      speakerCount: diar.speakerCount,
      summary: summaryText.trim() ? 1 : 0,
      startedAt: startIso,
      device: navigator.userAgent.slice(0, 60),
    }, { timeout: 60000 });
    msg('Đã lưu: ' + (r.mdUrl ? 'Drive' : 'ok'), 8000);
    btnSave.disabled = true;
  } catch (e) {
    msg('Lỗi lưu: ' + e.message, 6000);
  }
}

/* ---------- events ---------- */
recBtn.addEventListener('click', () => (recording ? stopRec() : startRec()));
btnFinal.addEventListener('click', buildFinal);
btnSummary.addEventListener('click', () => {
  if (summaryText.trim()) { showPanel(summaryText); return; }
  buildSummary();
});
btnSave.addEventListener('click', saveAll);
toggleZh.addEventListener('click', () => {
  document.body.classList.toggle('vi-only');
  toggleZh.classList.toggle('on', !document.body.classList.contains('vi-only'));
});

/* setup */
$('btnSetupSave').addEventListener('click', async () => {
  const url = $('inGas').value.trim();
  const tok = $('inToken').value.trim();
  if (!url) return msg('Cần URL /exec', 4000);
  setConfig(url, tok);
  $('setup').classList.remove('on');
  checkHealth();
});
$('btnSetupNode').addEventListener('click', () => {
  setConfig('', '');
  localStorage.removeItem('lr.gas');
  location.search = '?backend=node';
});

async function checkHealth() {
  try {
    const t0 = Date.now();
    const h = await gasPost('health', {}, { timeout: 30000 });
    setGas(h.wbOk ? 'ok' : 'err', h.backend === 'node' ? 'máy' : 'gas');
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
  if (needSetup()) {
    $('setup').classList.add('on');
    setGas('', 'chưa nối');
    return;
  }
  const { gasUrl } = getConfig();
  if (gasUrl) { $('inGas').value = gasUrl; $('inToken').value = localStorage.getItem('lr.token') || ''; }

  checkHealth();
  setInterval(() => { if (recording) checkHealth(); }, 60000);

  // nạp profile giọng của các buổi trước
  try {
    const r = await gasPost('speakers.get', {}, { timeout: 20000 });
    if (r.profiles && r.profiles.length) diar.loadProfiles(r.profiles);
  } catch {}
})();
