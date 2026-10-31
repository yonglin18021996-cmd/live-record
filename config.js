/**
 * config.js — cấu hình cố định, nạp trước app.js.
 * Đổi backend hoặc token thì sửa file này rồi push lên Pages.
 */
window.LR = {
  api: 'https://live-record.eric-liverecord.workers.dev',
  token: 'eric-lr-9f4c7b21e5',
};

// Chạy dev trên máy thì tự trỏ về server.js local (/exec)
if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
  window.LR.api = '/exec';
  window.LR.token = 'hop2026';
}
