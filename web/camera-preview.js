(() => {
  let last = null, previewHz = null;
  const fmt = x => Number.isFinite(x) ? x.toFixed(1) : '—';
  async function poll() {
    const begin = performance.now();
    if (!document.hidden && $('devicePanel').open && state?.camera_alive) {
      try {
        const r = await fetch('/api/frame', {headers: {'X-Session-Token': token}});
        if (!r.ok) throw Error('预览获取失败');
        if (r.status === 204) {
          $('frame').hidden = true; $('empty').hidden = false;
        } else {
          const next = URL.createObjectURL(await r.blob());
          if (document.hidden || !$('devicePanel').open) URL.revokeObjectURL(next);
          else {
            const old = frameURL; frameURL = next; $('frame').src = next;
            try {await $('frame').decode();} catch (_) {}
            if (old) URL.revokeObjectURL(old);
            $('frame').hidden = false; $('empty').hidden = true;
            const now = performance.now(); previewHz = last ? 1000/(now-last) : null; last = now;
          }
        }
      } catch (_) {last = null;}
    } else {last = null; previewHz = null;}
    const m = state?.camera_metrics || {};
    $('cameraPerformance').textContent = '预览 ' + fmt(previewHz) + ' fps · 取图 ' + fmt(m.capture_hz) +
      ' Hz · 识别 ' + fmt(m.processing_hz) + ' Hz · 取图耗时 ' + fmt(m.capture_ms) +
      ' ms · 识别耗时 ' + fmt(m.processing_ms) + ' ms · 编码 ' + fmt(m.encode_ms) +
      ' ms · 识别帧龄 ' + fmt(m.frame_age_ms) + ' ms';
    setTimeout(poll, Math.max(0, 50 - (performance.now()-begin)));
  }
  poll();
})();
