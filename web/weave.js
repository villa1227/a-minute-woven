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
  function draw(ctx, artwork, width = WIDTH, height = HEIGHT) {
    ctx.save(); ctx.scale(width / WIDTH, height / HEIGHT);
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const rand = random((artwork.id || 'blank') + ':paper');
    ctx.fillStyle = '#b9ab93'; ctx.globalAlpha = .14;
    for (let i = 0; i < 16000; i++) {
      ctx.fillRect(rand() * WIDTH, rand() * HEIGHT, .6 + rand() * 1.4, .5 + rand() * 1.5);
    }
    ctx.globalAlpha = 1;
    for (const band of artwork.bands || []) drawBand(ctx, band);
    // The unfinished passage is redrawn from the latest real samples. It is
    // committed to the final 5-second band list only at the boundary.
    if (artwork.preview) drawBand(ctx, artwork.preview);
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
  const api = Object.freeze({draw, drawBand, random, WIDTH, HEIGHT, PAPER, QR});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Weave = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
