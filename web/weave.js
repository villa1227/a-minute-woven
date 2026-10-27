/* One deterministic renderer for the live composition and its full-size PNG. */
(function (root) {
  'use strict';
  const WIDTH = 2400, HEIGHT = 3200;
  const PAPER = '#f4efe5', INDIGO = '#28455e', VERMILION = '#af5141';
  const QR = {x: 1920, y: 2760, size: 320};
  function random(seed) {
    let hash = 2166136261;
    for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return () => {
      hash += 0x6D2B79F5;
      let t = Math.imul(hash ^ hash >>> 15, 1 | hash);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function drawBand(ctx, band) {
    const x0 = 160, width = 2080, height = 210, y0 = 150 + band.index * height;
    const rand = random(band.seed);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, width, height); ctx.clip();
    // The baseline is a real, deterministic set of woven strokes rather than
    // a barely visible grid. It stays quiet enough to leave room for sensor
    // overlays, but still gives every five-second passage visible authorship.
    const baseCount = Math.max(10, Math.round((band.base_threads || band.threads || 22) * .58));
    ctx.strokeStyle = '#65757d'; ctx.globalAlpha = band.empty ? .34 : .22;
    ctx.lineWidth = 1.55;
    for (let line = 0; line < baseCount; line++) {
      const offset = (line / Math.max(1, baseCount - 1) - .5) * height * .66;
      const phase = rand() * Math.PI * 2;
      const frequency = .75 + rand() * .9;
      const amplitude = height * (.07 + rand() * .035);
      ctx.beginPath();
      for (let step = 0; step <= 260; step++) {
        const u = step / 260, x = x0 + u * width;
        const envelope = .42 + .58 * Math.sin(Math.PI * u);
        const wave = Math.sin(u * Math.PI * 2 * frequency + phase + line * .08)
          + .24 * Math.sin(u * Math.PI * 4.7 - phase);
        const y = y0 + height / 2 + offset + wave * amplitude * envelope;
        if (step === 0 || (step + line * 5) % 31 === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const [side, color, direction] of [['left', INDIGO, 1], ['right', VERMILION, -1]]) {
      const amplitude = band.amplitude[side];
      if (amplitude === null) continue;
      const count = band.threads;
      const phase = rand() * Math.PI * 2, frequency = 1.15 + rand() * 1.4;
      for (let line = 0; line < count; line++) {
        const offset = (line / Math.max(1, count - 1) - .5) * height * .46;
        const flutter = rand() * 4, stroke = 1.3 + rand() * 1.8;
        ctx.strokeStyle = color; ctx.globalAlpha = .4 + rand() * .4; ctx.lineWidth = stroke;
        ctx.beginPath();
        for (let step = 0; step <= 260; step++) {
          const u = step / 260, x = x0 + u * width;
          const envelope = .38 + .62 * Math.pow(Math.sin(Math.PI * u), .7);
          const wave = Math.sin(u * Math.PI * 2 * frequency + phase + line * .035) * .78
            + Math.sin(u * Math.PI * 2 * (frequency + 1.3) - phase) * .22;
          const y = y0 + height / 2 + offset + direction * wave * amplitude * height * envelope
            + Math.sin(step * .16 + line) * flutter * .3;
          // Small alternating breaks suggest interlaced threads rather than plotted curves.
          if (step === 0 || (step + line * 3 + (side === 'right' ? 7 : 0)) % 23 === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function fraction(artwork, index, elapsed) {
    if ((artwork.schema_version || 1) < 2 || artwork.status === 'completed') return 1;
    return Math.max(0, Math.min(1, (elapsed - (artwork.preparation_s || 5) - index * 5) / 5));
  }
  function draw(ctx, artwork, width = WIDTH, height = HEIGHT, elapsed = artwork.elapsed_s || 0) {
    ctx.save(); ctx.scale(width / WIDTH, height / HEIGHT);
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const rand = random((artwork.id || 'blank') + ':paper');
    ctx.fillStyle = '#b9ab93'; ctx.globalAlpha = .14;
    for (let i = 0; i < 16000; i++) {
      ctx.fillRect(rand() * WIDTH, rand() * HEIGHT, .6 + rand() * 1.4, .5 + rand() * 1.5);
    }
    ctx.globalAlpha = 1;
    for (const band of artwork.bands || []) {
      const progress = fraction(artwork, band.index, elapsed);
      if (!progress) continue;
      ctx.save(); ctx.beginPath(); ctx.rect(160, 150 + band.index * 210, 2080 * progress, 210); ctx.clip();
      drawBand(ctx, band); ctx.restore();
    }
    // The unfinished passage is redrawn from the latest real samples. It is
    // committed to the final 5-second band list only at the boundary.
    if ((artwork.schema_version || 1) < 2 && artwork.preview) drawBand(ctx, artwork.preview);
    // Reserved square is genuinely blank, including the paper grain.
    ctx.fillStyle = PAPER; ctx.fillRect(QR.x, QR.y, QR.size, QR.size);
    if (artwork.id) {
      ctx.fillStyle = '#4d514c'; ctx.font = '28px Georgia, serif';
      ctx.fillText('A MINUTE, WOVEN', 160, 2840);
      ctx.fillStyle = '#858171'; ctx.font = '22px monospace';
      ctx.fillText('NO. ' + artwork.id.toUpperCase(), 160, 2900);
      ctx.fillText((artwork.created_at || '').slice(0, 10).replaceAll('-', ' / '), 160, 2942);
    }
    ctx.restore();
  }
  // Cache paper and per-band rasterization; animation only changes a clip.
  function createAnimator(canvas, makeCanvas = () => document.createElement('canvas')) {
    let identity = '', paper, bands = new Map();
    function layer() {
      const c = makeCanvas(); c.width = canvas.width; c.height = canvas.height; return c;
    }
    return (artwork, elapsed) => {
      const key = [artwork.id, artwork.created_at, canvas.width, canvas.height].join(':');
      if (key !== identity) {
        identity = key; bands.clear(); paper = layer();
        draw(paper.getContext('2d'), {...artwork, bands: [], preview: null}, canvas.width, canvas.height);
      }
      const ctx = canvas.getContext('2d'), sx = canvas.width / WIDTH, sy = canvas.height / HEIGHT;
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(paper, 0, 0);
      for (const band of artwork.bands || []) {
        if (!bands.has(band.index)) {
          const c = layer(), cc = c.getContext('2d'); cc.scale(sx, sy); drawBand(cc, band); bands.set(band.index, c);
        }
        const progress = fraction(artwork, band.index, elapsed);
        if (!progress) continue;
        ctx.save(); ctx.beginPath(); ctx.rect(160 * sx, (150 + band.index * 210) * sy, 2080 * sx * progress, 210 * sy); ctx.clip();
        ctx.drawImage(bands.get(band.index), 0, 0); ctx.restore();
      }
    };
  }
  function validateArtwork(artwork) {
    if (!artwork || typeof artwork !== 'object' || ![1,2].includes(artwork.schema_version || 1)) throw Error('不支持的作品格式版本');
    if (artwork.renderer !== 'woven-v1') throw Error('此页面只支持 woven-v1 绘制器');
    if (artwork.status !== 'completed') throw Error('请选择已完成作品的 artwork.json');
    if (typeof artwork.id !== 'string' || !artwork.id || artwork.id.length > 128) throw Error('作品编号无效');
    if (artwork.created_at !== undefined && typeof artwork.created_at !== 'string') throw Error('作品日期无效');
    if (!Array.isArray(artwork.bands) || artwork.bands.length !== 12) throw Error('完整作品需要 12 段');
    for (let i=0;i<12;i++) {
      const band = artwork.bands[i];
      if (!band || band.index !== i || typeof band.seed !== 'string' || band.seed.length > 256) throw Error('时间段编号或种子无效');
      if (!Number.isInteger(band.threads) || band.threads < 1 || band.threads > 100 ||
          (band.base_threads !== undefined && (!Number.isInteger(band.base_threads) || band.base_threads < 1 || band.base_threads > 100))) throw Error('线条数量无效');
      if (!band.amplitude || !['left','right'].every(side => band.amplitude[side] === null ||
          (Number.isFinite(band.amplitude[side]) && band.amplitude[side] >= 0 && band.amplitude[side] <= .5))) throw Error('线条幅度无效');
    }
    return artwork;
  }
  const api = Object.freeze({draw, drawBand, fraction, createAnimator, validateArtwork, random, WIDTH, HEIGHT, PAPER, QR});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Weave = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
