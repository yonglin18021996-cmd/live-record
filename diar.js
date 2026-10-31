/**
 * diar.js — gom cụm người nói từ speaker embedding (512 chiều, WavLM).
 * Không chứa model, không chứa FFT — chỉ clustering. Nhờ vậy test được bằng Node
 * và chạy được cả browser lẫn server GAS (nếu sau này cần).
 *
 * Vì sao KHÔNG dùng MFCC: đo trên 2 giọng thật (fixtures/), cosine MFCC cho
 *   cùng người khác đoạn 0.792..0.955
 *   khác người cùng nội dung 0.586..0.904   -> chồng lấn, không ngưỡng nào cứu được.
 * MFCC đo NỘI DUNG đang nói, không đo DANH TÍNH giọng.
 *
 * WavLM (Xenova/wavlm-base-plus-sv) trên cùng dữ liệu:
 *   khác nội dung: same 0.839..0.937 | diff 0.319..0.752
 *   cùng nội dung: same 0.825..0.958 | diff 0.529..0.776
 *   -> chọn accept 0.80, delta 0.05.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Diar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    accept: 0.80,     // cosine tối thiểu để nhận là cùng người
    delta: 0.05,      // phải hơn runner-up chừng này
    softDelta: 0.05,  // ngưỡng mềm: cụm còn ít mẫu thì dễ nhận hơn (tránh tạo cụm rác)
    maxSpeakers: 6,
    emaCap: 200,      // chặn để centroid không đông cứng sau hội thoại dài
    minRmsDb: -55,    // chunk im lặng hơn mức này thì bỏ
    minVoicedRatio: 0.15,
  };

  function l2(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const n = Math.sqrt(s) || 1;
    const o = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
    return o;
  }
  function cos(a, b) {
    let s = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return s / (Math.sqrt(na * nb) || 1);
  }

  /** RMS dB của cả chunk — dùng để bỏ đoạn im lặng trước khi embed. */
  function rmsDb(pcm) {
    let sq = 0;
    for (let i = 0; i < pcm.length; i++) sq += pcm[i] * pcm[i];
    return 10 * Math.log10(sq / (pcm.length || 1) + 1e-12);
  }

  function create(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    let centroids = [];
    let nextId = 1;

    function newSpeaker(emb) {
      const id = 'V' + nextId++;
      const c = {
        id, name: id, centroid: l2(emb), count: 1,
        reused: false, confirm: 0, fresh: true,
      };
      centroids.push(c);
      return c;
    }

    function update(c, emb) {
      const n = Math.min(c.count, o.emaCap);
      const v = new Float64Array(emb.length);
      for (let i = 0; i < emb.length; i++) v[i] = (n * c.centroid[i] + emb[i]) / (n + 1);
      c.centroid = l2(v); // giữ centroid trên mặt cầu đơn vị để cosine ổn định
      c.count++;
      c.confirm++;
    }

    /**
     * @param {Float32Array|number[]|Float64Array} embRaw embedding 512 chiều
     * @returns {{speaker:string, conf:number, s1:number, s2:number, isNew:boolean}}
     */
    function processEmbedding(embRaw) {
      const emb = l2(embRaw);

      if (!centroids.length) {
        const c = newSpeaker(emb);
        return { speaker: c.id, conf: 1, s1: 0, s2: 0, isNew: true };
      }

      let s1 = -9, s2 = -9, i1 = -1;
      for (let i = 0; i < centroids.length; i++) {
        const c = centroids[i];
        const s = cos(emb, c.centroid);
        // profile tái dùng từ buổi trước: 3 lần đầu phải khớp chặt hơn
        const need = c.reused && c.confirm < 3 ? o.accept + 0.04 : o.accept;
        const eff = s >= need ? s : s - 9;
        if (eff > s1) { s2 = s1; s1 = eff; i1 = i; }
        else if (eff > s2) s2 = eff;
      }

      const pass = i1 >= 0 && s1 >= o.accept && (centroids.length === 1 || s1 - s2 >= o.delta);

      if (pass) {
        update(centroids[i1], emb);
        return {
          speaker: centroids[i1].id,
          conf: Number(s1.toFixed(3)),
          s1: Number(s1.toFixed(3)),
          s2: Number(s2 < -8 ? -1 : s2.toFixed(3)),
          isNew: false,
        };
      }

      // Ngưỡng mềm: cụm còn ít mẫu (<3) thì dễ nhận hơn. Chunk ngắn bị cắt giữa câu
      // thường cho cosine thấp hơn 0.05-0.08 so với chunk đầy đủ, tạo cụm rác nếu quá chặt.
      const soft = i1 >= 0 && s1 >= o.accept - o.softDelta && centroids[i1].count < 3 && !centroids[i1].reused;
      if (soft) {
        update(centroids[i1], emb);
        return {
          speaker: centroids[i1].id,
          conf: Number(s1.toFixed(3)),
          s1: Number(s1.toFixed(3)),
          s2: Number(s2 < -8 ? -1 : s2.toFixed(3)),
          isNew: false,
          lowconf: true,
        };
      }

      if (centroids.length < o.maxSpeakers) {
        const c = newSpeaker(emb);
        return {
          speaker: c.id, conf: 1,
          s1: Number(Math.max(s1, -1).toFixed(3)), s2: Number(s2 < -8 ? -1 : s2.toFixed(3)),
          isNew: true,
        };
      }

      // đã đủ người: gán tạm vào gần nhất, đánh dấu độ tin thấp
      return {
        speaker: centroids[i1 >= 0 ? i1 : 0].id,
        conf: Number(Math.max(0, s1).toFixed(3)),
        s1: Number(Math.max(s1, -1).toFixed(3)),
        s2: Number(s2 < -8 ? -1 : s2.toFixed(3)),
        isNew: false,
        lowconf: true,
      };
    }

    function getProfiles() {
      return centroids.map((c) => ({
        id: c.id, name: c.name, dim: c.centroid.length,
        centroid: Array.from(c.centroid), count: c.count, reused: c.reused,
      }));
    }

    function loadProfiles(list) {
      for (const p of list || []) {
        const arr = Array.from(p.centroid || []);
        // embedding thật là 512 chiều; bỏ profile rác/khác phiên bản model
        if (arr.length < 128) continue;
        if (centroids.some((x) => x.id === p.id)) continue;
        if (centroids.length && arr.length !== centroids[0].centroid.length) continue;
        centroids.push({
          id: p.id, name: p.name || p.id, centroid: l2(arr),
          count: 0, reused: true, confirm: 0, fresh: false,
        });
        const num = parseInt(String(p.id).replace(/\D/g, ''), 10);
        if (!isNaN(num) && num >= nextId) nextId = num + 1;
      }
    }

    function rename(id, name) {
      const c = centroids.find((x) => x.id === id);
      if (c) c.name = name;
    }

    function merge(fromId, toId) {
      const a = centroids.find((x) => x.id === fromId);
      const b = centroids.find((x) => x.id === toId);
      if (!a || !b || a === b) return;
      const n = Math.max(1, a.count + b.count);
      const v = new Float64Array(a.centroid.length);
      for (let i = 0; i < v.length; i++) v[i] = (a.centroid[i] * a.count + b.centroid[i] * b.count) / n;
      b.centroid = l2(v);
      b.count = n;
      centroids = centroids.filter((x) => x !== a);
    }

    return {
      processEmbedding, getProfiles, loadProfiles, rename, merge, rmsDb,
      has(id) { return centroids.some((c) => c.id === id); },
      nameOf(id) { const c = centroids.find((x) => x.id === id); return c ? c.name : id; },
      reset() { centroids = []; nextId = 1; },
      get speakerCount() { return centroids.length; },
      options: o,
    };
  }

  return { create, l2, cos, rmsDb, DEFAULTS };
});
