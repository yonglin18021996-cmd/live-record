/**
 * net.js — một cửa duy nhất tới backend (Cloudflare Worker hoặc server.js /exec khi dev).
 * Cấu hình nằm trong config.js, không còn UI nhập.
 *
 * Luôn POST Content-Type: text/plain để tránh preflight.
 */
const API = () => (window.LR && window.LR.api) || '/exec';
const TOKEN = () => (window.LR && window.LR.token) || '';

export const apiInfo = () => ({
  api: API(),
  isWorker: /workers\.dev/.test(API()),
  isLocal: API() === '/exec',
});

const ERR_VI = {
  AUTH: 'Token sai hoặc chưa cấu hình.',
  WB_KEY: 'Key dịch (WorkBuddy) bị từ chối.',
  WB_BLOCKED_IP: 'Gateway WorkBuddy chặn IP. Không tự đổi provider — báo lại để xử lý.',
  ASR: 'Nhận dạng giọng nói lỗi.',
  TOO_BIG: 'Đoạn ghi âm quá lớn.',
  QUOTA: 'Hết quota hôm nay.',
  HAN: 'Model trả lại tiếng Trung, đã thử 3 lần.',
  EMPTY: 'Không có nội dung.',
  BAD_JSON: 'Phản hồi không hợp lệ.',
  TELEGRAM: 'Chưa cấu hình Telegram.',
  INTERNAL: 'Lỗi server.',
};

function makeError(code, detail) {
  const e = new Error(ERR_VI[code] || detail || 'Lỗi không rõ');
  e.code = code;
  e.detail = detail || '';
  return e;
}

/**
 * @param {string} action
 * @param {object} payload
 * @param {{timeout?:number}} [opts]
 */
export async function gasPost(action, payload = {}, opts = {}) {
  const timeout = opts.timeout || 120000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    const r = await fetch(API(), {
      method: 'POST',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: TOKEN(), ...payload }),
    });

    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      if (/accounts\.google\.com|sign in|đăng nhập/i.test(txt)) {
        throw new Error('Phiên Google hết hạn — mở lại link /exec một lần rồi thử lại.');
      }
      throw new Error('Phản hồi không phải JSON: ' + txt.slice(0, 120));
    }

    if (!j || j.ok !== true) {
      throw makeError((j && j.code) || 'INTERNAL', (j && j.error) || '');
    }
    return j;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Quá thời gian chờ (' + Math.round(timeout / 1000) + 's).');
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Như gasPost nhưng đọc response dạng SSE: server đẩy trước chữ Trung, rồi từng delta bản dịch.
 * Dùng cho action 'chunkStream'. Không dùng cho GAS (GAS không stream được).
 *
 * @param {object} payload
 * @param {(ev:{zh?:string, d?:string, reset?:boolean, e?:string, done?:boolean, asrMs?:number})=>void} onEvent
 * @param {{timeout?:number}} [opts]
 */
export async function gasStream(payload = {}, onEvent, opts = {}) {
  const timeout = opts.timeout || 120000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    const r = await fetch(API(), {
      method: 'POST',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'chunkStream', token: TOKEN(), ...payload }),
    });

    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';

    // backend không stream (GAS/fallback) → đọc JSON một cục
    if (!ct.includes('event-stream')) {
      const j = await r.json();
      if (j.ok === false) throw makeError(j.code || 'INTERNAL', j.error || '');
      onEvent({ zh: j.zh, d: j.vi, asrMs: j.asrMs, done: true });
      return;
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          onEvent(JSON.parse(d));
        } catch {}
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Quá thời gian chờ (' + Math.round(timeout / 1000) + 's).');
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
