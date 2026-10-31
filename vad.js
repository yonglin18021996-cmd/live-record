/**
 * vad.js — cắt câu theo khoảng lặng (VAD năng lượng), có chặn max để câu không quá dài.
 * Chạy trên máy, thuần JS, 0 phụ thuộc, không tải model.
 *
 * Vì sao: cắt cứng 8s làm chờ 8.7s mới thấy chữ đầu tiên. Cắt theo khoảng lặng cho ra
 * câu trọn vẹn dài 2-4s → chữ Trung hiện sau ~1s kể từ lúc người nói ngừng.
 *
 * Tham số mặc định (đo bằng audio họp fixtures):
 *   silenceMs 300   — ngừng nói 300ms thì chốt câu (ngắn hơn dễ cứa giữa từ)
 *   preRollMs 250   — lấy lùi 250ms trước khi bắt đầu nói để không mất phụ âm đầu
 *   minMs    1200   — câu ngắn hơn thì gộp, ASR mới đủ ngữ cảnh
 *   maxMs    5000   — chặn câu dài / nói chồng
 *   valleyMs  400   — khi chạm max, cắt ở frame năng lượng thấp nhất trong 400ms cuối
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Vad = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FS = 320; // 20ms @ 16kHz
  const SR = 16000;

  const DEFAULTS = {
    silenceMs: 300,
    preRollMs: 250,
    minMs: 1200,
    maxMs: 5000,
    valleyMs: 400,
    speechMarginDb: 6,
  };

  function create(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const SIL = Math.round(o.silenceMs / 20);
    const PRE = Math.round(o.preRollMs / 20);
    const MINF = Math.round(o.minMs / 20);
    const MAXF = Math.round(o.maxMs / 20);
    const LOOK = Math.round(o.valleyMs / 20);

    let acc = new Float32Array(0); // mẫu chưa cắt
    let frameDb = [];              // dB từng frame của acc
    let noiseHist = [];            // để ước lượng noise floor
    let inSpeech = false;
    let segStart = 0;              // frame
    let silenceRun = 0;

    const floorDb = () => {
      if (!noiseHist.length) return -55;
      const s = noiseHist.slice().sort((a, b) => a - b);
      return Math.max(-55, s[Math.floor(0.1 * (s.length - 1))] + o.speechMarginDb);
    };

    function dbAt(off) {
      let e = 0;
      for (let i = 0; i < FS; i++) { const v = acc[off + i]; e += v * v; }
      return 10 * Math.log10(e / FS + 1e-12);
    }

    /** Cắt acc từ frame f1 trở đi, trả segment [f0, f1). Ngắn hơn minMs thì KHÔNG cắt (để gộp câu sau). */
    function cut(f0, f1) {
      const s = f0 * FS;
      const e = Math.min(f1 * FS, acc.length);
      if (e - s < SR * 0.3) return null;
      if (e - s < (o.minMs / 1000) * SR * 0.9) return null; // quá ngắn: giữ lại để gộp
      const seg = acc.slice(s, e);
      acc = acc.slice(e);
      frameDb = frameDb.slice(f1);
      segStart = 0;
      return seg;
    }

    function step(out) {
      const f = frameDb.length - 1;
      const speech = frameDb[f] > floorDb();

      if (!inSpeech) {
        if (speech) {
          inSpeech = true;
          // nếu đang giữ câu ngắn chưa cắt thì nối tiếp, không reset điểm đầu
          if (segStart === 0) segStart = Math.max(0, f - PRE);
          silenceRun = 0;
        } else if (acc.length > SR * 3 && segStart === 0) {
          // im lặng dài, không có gì đang giữ: bỏ bớt để không phình bộ nhớ
          const drop = Math.floor((acc.length - SR) / FS);
          acc = acc.slice(drop * FS);
          frameDb = frameDb.slice(drop);
          segStart = 0;
        }
        return;
      }

      silenceRun = speech ? 0 : silenceRun + 1;
      const frames = f - segStart + 1;

      if (frames >= MAXF) {
        // chạm trần: cắt ở đáy năng lượng trong LOOK frame cuối
        let best = f, bestDb = Infinity;
        for (let i = Math.max(segStart, f - LOOK); i <= f; i++) {
          if (frameDb[i] < bestDb) { bestDb = frameDb[i]; best = i; }
        }
        const seg = cut(segStart, best + 1);
        if (seg) out.push(seg);
        inSpeech = true; // câu còn tiếp, không chờ khoảng lặng
        segStart = 0;
        silenceRun = 0;
        return;
      }

      if (silenceRun >= SIL && frames >= MINF) {
        const seg = cut(segStart, f + 1 - silenceRun);
        if (seg) {
          out.push(seg);
          inSpeech = false;
          segStart = 0;
        } else if (silenceRun > 250) {
          // câu quá ngắn + im lặng rất dài: bỏ hẳn để không phình
          acc = new Float32Array(0);
          frameDb = [];
          inSpeech = false;
          segStart = 0;
        } else {
          // giữ lại, chờ câu sau nối vào
          inSpeech = false;
        }
        silenceRun = 0;
      }
    }

    return {
      /**
       * @param {Float32Array} block mẫu 16kHz từ ScriptProcessor
       * @returns {Float32Array[]} các câu đã chốt trong lần đẩy này (thường rỗng)
       */
      push(block) {
        const out = [];
        const a = new Float32Array(acc.length + block.length);
        a.set(acc);
        a.set(block, acc.length);
        acc = a;

        let pos = frameDb.length;
        while ((pos + 1) * FS <= acc.length) {
          frameDb.push(dbAt(pos * FS));
          noiseHist.push(frameDb[frameDb.length - 1]);
          if (noiseHist.length > 300) noiseHist.shift();
          pos++;
          step(out);
        }
        return out;
      },

      /** Dừng ghi: lấy nốt câu đang dở. */
      flush() {
        const out = [];
        if (inSpeech && frameDb.length > segStart) {
          const seg = cut(segStart, Math.max(segStart + 1, frameDb.length - silenceRun));
          if (seg) out.push(seg);
        }
        acc = new Float32Array(0);
        frameDb = [];
        noiseHist = [];
        inSpeech = false;
        segStart = 0;
        silenceRun = 0;
        return out;
      },

      /** Số ms đang giữ trong bộ đệm — dùng cho vòng tiến độ. */
      get pendingMs() { return Math.round((acc.length / SR) * 1000); },
      get speaking() { return inSpeech; },
      options: o,
    };
  }

  return { create, DEFAULTS, FS, SR };
});
