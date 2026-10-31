/**
 * net.js — một cửa duy nhất tới backend (Google Apps Script /exec hoặc server.js /exec).
 *
 * Chọn backend bằng URL:
 *   ?gas=https://script.google.com/macros/s/xxx/exec   → GAS
 *   ?backend=node  (hoặc không có ?gas)                → server.js /exec (dev/offline)
 *
 * Luôn POST Content-Type: text/plain để tránh preflight (GAS không có doOptions).
 */
const QS = new URLSearchParams(location.search);

let gasUrl = QS.get('gas') || localStorage.getItem('lr.gas') || '';
export let token = QS.get('token') || localStorage.getItem('lr.token') || '';
const forceNode = QS.get('backend') === 'node';

if (QS.get('gas')) localStorage.setItem('lr.gas', QS.get('gas'));
if (QS.get('token')) localStorage.setItem('lr.token', QS.get('token'));

export function setConfig(url, tok) {
  gasUrl = url || '';
  token = tok || '';
  if (url) localStorage.setItem('lr.gas', url);
  if (tok) localStorage.setItem('lr.token', tok);
}

export function getConfig() {
  return { gasUrl, token, backend: gasUrl && !forceNode ? 'gas' : 'node' };
}

export function needSetup() {
  return !forceNode && !gasUrl;
}

const ERR_VI = {
  AUTH: 'Token sai hoặc chưa nhập.',
  WB_KEY: 'Key dịch (WorkBuddy) bị từ chối.',
  WB_BLOCKED_IP: 'Gateway WorkBuddy chặn IP Google. Không tự đổi provider — báo lại để xử lý.',
  ASR: 'Nhận dạng giọng nói lỗi.',
  TOO_BIG: 'Đoạn ghi âm quá lớn.',
  QUOTA: 'Hết quota Google Apps Script hôm nay.',
  HAN: 'Model trả lại tiếng Trung, đã thử 3 lần.',
  EMPTY: 'Không có nội dung.',
  BAD_JSON: 'Phản hồi không hợp lệ.',
  INTERNAL: 'Lỗi server.',
};

/**
 * @param {string} action
 * @param {object} payload
 * @param {{timeout?:number}} [opts]
 */
export async function gasPost(action, payload = {}, opts = {}) {
  const timeout = opts.timeout || 120000;
  const url = gasUrl && !forceNode ? gasUrl : '/exec';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    const r = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token, ...payload }),
    });

    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      // GAS đôi khi trả trang HTML lỗi/đăng nhập thay vì JSON
      if (/accounts\.google\.com|sign in|đăng nhập/i.test(txt)) {
        throw new Error('Phiên Google hết hạn — mở lại link /exec một lần rồi thử lại.');
      }
      throw new Error('Phản hồi không phải JSON: ' + txt.slice(0, 120));
    }

    if (!j || j.ok !== true) {
      const code = (j && j.code) || 'INTERNAL';
      const msg = ERR_VI[code] || (j && j.error) || 'Lỗi không rõ';
      const err = new Error(msg);
      err.code = code;
      err.detail = (j && j.error) || '';
      throw err;
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
