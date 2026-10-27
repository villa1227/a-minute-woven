/* Live traces use sensor sample times; display polling never creates samples. */
(() => {
  const channels = {
    left: {label: '画面左眼', color: '#087f8c', unit: 'px', ttl: 2, values: [], ref: null, reset: -Infinity},
    right: {label: '画面右眼', color: '#8a53a1', unit: 'px', ttl: 2, values: [], ref: null, reset: -Infinity},
    heart: {label: '心率', color: '#c15350', unit: 'bpm', ttl: 5, values: [], ref: null, reset: -Infinity},
    eda: {label: '皮电', color: '#a37a24', unit: 'ADC', ttl: 1, values: [], ref: null, reset: -Infinity}
  };
  let cursor = 0, streamId = null, now = 0, markers = [], referenceTime = null;
  let connected = false, tooltipChart = null, tooltipX = null;
  const plots = [
    {id: 'eyeTrace', empty: 'eyeEmpty', keys: ['left', 'right'], minSpan: 2},
    {id: 'heartTrace', empty: 'heartEmpty', keys: ['heart'], minSpan: 10},
    {id: 'edaTrace', empty: 'edaEmpty', keys: ['eda'], minSpan: 10}
  ];
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const relative = () => $('traceMode').value === 'relative';
  const windowSize = () => Number($('traceWindow').value);
  const current = channel => {
    const last = channel.values.at(-1);
    return connected && last && now - last.t < channel.ttl && finite(last.value) ? last : null;
  };
  const valueOf = (channel, value) => finite(value) && (!relative() || finite(channel.ref))
    ? value - (relative() ? channel.ref : 0) : null;
  function invalidate(keys, t) {
    for (const key of keys) {
      const channel = channels[key];
      channel.values.push({t, value: null});
      channel.ref = null;
      channel.reset = t;
    }
  }
  function ingest(payload) {
    if (streamId && streamId !== payload.stream_id) {
      for (const channel of Object.values(channels)) {
        channel.values = []; channel.ref = null; channel.reset = -Infinity;
      }
      markers = []; referenceTime = null;
    }
    streamId = payload.stream_id;
    now = payload.now_s;
    cursor = payload.cursor;
    for (const row of payload.rows) {
      if (row.source === 'camera') {
        for (const [side, key] of [['image_left', 'left'], ['image_right', 'right']]) {
          const eye = row.data.eyes?.[side];
          channels[key].values.push({t: row.t,
            value: eye?.quality === 'candidate_unvalidated' && finite(eye.candidate_diameter_px)
              ? eye.candidate_diameter_px : null,
            brightness: eye?.brightness, quality: eye?.quality});
        }
      } else if (row.source === 'heart_rate') {
        channels.heart.values.push({t: row.t, value: row.data.contact_detected !== false
          && row.data.quality !== 'contact_lost' && finite(row.data.bpm) && row.data.bpm > 0 ? row.data.bpm : null});
      } else if (row.source === 'eda') {
        const adc = row.data.adc;
        channels.eda.values.push({t: row.t, breakBefore: Boolean(row.data.break_before),
          value: row.data.quality === 'received_unvalidated' && Number.isInteger(adc)
            && adc >= 0 && adc <= 1023 ? adc : null});
      } else if (row.source === 'marker') {
        markers.push({t: row.t, label: row.data.label});
      } else if (row.source === 'event') {
        if (row.data.kind === 'camera_reset') invalidate(['left', 'right'], row.t);
        if (row.data.kind === 'heart_reset') invalidate(['heart'], row.t);
        if (row.data.kind === 'eda_reset') invalidate(['eda'], row.t);
        if (row.data.kind === 'camera_roi_changed') {
          invalidate(row.data.side === 'both' ? ['left', 'right']
            : [row.data.side === 'image_left' ? 'left' : 'right'], row.t);
        }
      }
    }
    for (const channel of Object.values(channels)) {
      channel.values = channel.values.filter(point => point.t >= now - 180).sort((a, b) => a.t - b.t);
    }
    markers = markers.filter(marker => marker.t >= now - 180);
  }
  function readouts() {
    for (const [key, suffix] of [['left', 'Left'], ['right', 'Right'], ['heart', 'Heart'], ['eda', 'Eda']]) {
      const channel = channels[key], point = current(channel);
      $('live' + suffix).textContent = point ? point.value.toFixed(['heart', 'eda'].includes(key) ? 0 : 2) + ' ' + channel.unit : '—';
      if (!point) {
        $('delta' + suffix).textContent = channel.values.length ? '暂无有效更新' : '等待数据';
      } else if (finite(channel.ref)) {
        const delta = point.value - channel.ref;
        $('delta' + suffix).textContent = '较参考 ' + (delta >= 0 ? '+' : '') + delta.toFixed(key === 'heart' ? 1 : 2) + ' ' + channel.unit;
      } else {
        $('delta' + suffix).textContent = key === 'eda' ? '原始 ADC · 未标定' : key === 'heart' ? '实时接收' : '候选测量';
      }
    }
    const refs = Object.values(channels).filter(channel => finite(channel.ref));
    $('clearReference').disabled = !refs.length;
    $('referenceStatus').textContent = refs.length
      ? '个人参考已记录 · ' + refs.map(channel => channel.label + ' ' + channel.ref.toFixed(channel.unit === 'bpm' ? 1 : 2)).join(' / ')
      : '还没有个人参考值';
    if (referenceTime && refs.length) $('referenceStatus').title = '设置于 ' + referenceTime;
    const recent = ['left', 'right'].map(key => {
      const points = channels[key].values.filter(point => point.t >= now - windowSize() && point.t >= channels[key].reset);
      return points.length ? channels[key].label + ' ' + Math.round(100 * points.filter(point => finite(point.value)).length / points.length) + '%' : null;
    }).filter(Boolean);
    $('traceStatus').textContent = connected
      ? (recent.length ? '候选数据：' + recent.join(' / ') : current(channels.eda) ? '皮电实时接收中' : '等待传感器数据')
      : '正在重连';
    $('eyeAxisUnit').textContent = relative() ? 'Δ px' : 'px';
    $('heartAxisUnit').textContent = relative() ? 'Δ bpm' : 'bpm';
    $('edaAxisUnit').textContent = relative() ? 'Δ ADC' : 'ADC';
  }
  function draw(plot) {
    const canvas = $(plot.id), bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(bounds.width * scale);
    canvas.height = Math.round(bounds.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    const w = bounds.width, h = bounds.height, left = 48, right = w - 14, top = 20, bottom = h - 24;
    const start = now - windowSize(), visible = [];
    for (const key of plot.keys) {
      for (const point of channels[key].values) {
        const value = valueOf(channels[key], point.value);
        if (point.t >= start && finite(value)) visible.push(value);
      }
    }
    let low = visible.length ? Math.min(...visible) : 0;
    let high = visible.length ? Math.max(...visible) : plot.minSpan;
    if (relative()) {low = Math.min(low, 0); high = Math.max(high, 0);}
    const span = Math.max(high - low, plot.minSpan), center = (low + high) / 2;
    low = center - span * .65; high = center + span * .65;
    if (!relative()) low = Math.max(0, low);
    const x = t => left + (t - start) / windowSize() * (right - left);
    const y = value => bottom - (value - low) / (high - low) * (bottom - top);
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const value = low + (high - low) * i / 2, yy = y(value);
      ctx.strokeStyle = '#dce7e3'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillStyle = '#71898c'; ctx.textAlign = 'right'; ctx.fillText(value.toFixed(1), left - 8, yy + 4);
    }
    ctx.fillStyle = '#71898c'; ctx.textAlign = 'left'; ctx.fillText(windowSize() + ' 秒前', left, h - 5);
    ctx.textAlign = 'right'; ctx.fillText('现在', right, h - 5);
    ctx.save(); ctx.beginPath(); ctx.rect(left, top - 5, right - left, bottom - top + 10); ctx.clip();
    if (relative()) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#8ba49b'; ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const marker of markers.filter(item => item.t >= start)) {
      const xx = x(marker.t);
      ctx.strokeStyle = '#b7a263'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#8a743e'; ctx.textAlign = xx > right - 90 ? 'right' : 'left';
      ctx.fillText(marker.label.slice(0, 18), xx + (xx > right - 90 ? -4 : 4), top - 5);
    }
    for (const key of plot.keys) {
      const channel = channels[key]; let previous = null, last = null;
      ctx.strokeStyle = channel.color; ctx.fillStyle = channel.color; ctx.lineWidth = 1.8; ctx.beginPath();
      for (const point of channel.values) {
        if (point.t < start) continue;
        const value = valueOf(channel, point.value);
        if (!finite(value)) {previous = null; continue;}
        if (previous && !point.breakBefore && point.t - previous.t < channel.ttl) ctx.lineTo(x(point.t), y(value));
        else {
          ctx.moveTo(x(point.t), y(value));
          ctx.fillRect(x(point.t) - 1, y(value) - 1, 2, 2);
        }
        previous = point; last = {t: point.t, value};
      }
      ctx.stroke();
      if (last) {ctx.beginPath(); ctx.arc(x(last.t), y(last.value), 3, 0, Math.PI * 2); ctx.fill();}
    }
    if (tooltipChart === plot.id && tooltipX !== null) {
      ctx.strokeStyle = '#99aaa5'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tooltipX, top); ctx.lineTo(tooltipX, bottom); ctx.stroke();
    }
    ctx.restore();
    const unset = relative() && plot.keys.every(key => !finite(channels[key].ref));
    $(plot.empty).textContent = unset ? '请先设置此通道的参考值' : (plot.id === 'eyeTrace' ? '等待有效眼区数据' : plot.id === 'edaTrace' ? '等待皮电串口数据' : '等待心率广播');
    $(plot.empty).hidden = visible.length > 0;
    canvas.setAttribute('aria-label', (plot.id === 'eyeTrace' ? '双眼候选直径' : plot.id === 'edaTrace' ? '皮电 ADC' : '心率') + '，最近 ' + windowSize() + ' 秒，' + (visible.length ? '已显示真实采样曲线' : '暂无有效数据'));
  }
  function render() {readouts(); plots.forEach(draw);}
  $('setReference').onclick = () => {
    const captured = [];
    for (const channel of Object.values(channels)) {
      channel.ref = null;
      const points = channel.values.filter(point => point.t >= Math.max(now - (channel.unit === 'ADC' ? 5 : 10), channel.reset) && finite(point.value));
      if (current(channel) && points.length >= (channel.unit === 'ADC' ? 20 : channel.unit === 'bpm' ? 2 : 3)) {
        channel.ref = median(points.map(point => point.value)); captured.push(channel.label);
      }
    }
    if (captured.length) {
      referenceTime = new Date().toLocaleTimeString(); $('traceMode').value = 'relative';
    }
    render();
    $('traceStatus').textContent = captured.length ? '已记录：' + captured.join('、') : '请采集几秒后再记参考值';
  };
  $('clearReference').onclick = () => {
    Object.values(channels).forEach(channel => {channel.ref = null;});
    referenceTime = null; $('traceMode').value = 'raw'; render();
  };
  $('traceMode').onchange = render; $('traceWindow').onchange = render;
  for (const plot of plots) {
    const canvas = $(plot.id);
    canvas.addEventListener('pointermove', event => {
      const bounds = canvas.getBoundingClientRect(), xx = Math.max(48, Math.min(bounds.width - 14, event.clientX - bounds.left));
      const t = now - windowSize() + (xx - 48) / (bounds.width - 62) * windowSize();
      tooltipChart = plot.id; tooltipX = xx;
      const lines = [Math.max(0, now - t).toFixed(1) + ' 秒前'];
      for (const key of plot.keys) {
        const channel = channels[key];
        const nearest = channel.values.reduce((best, point) => !best || Math.abs(point.t - t) < Math.abs(best.t - t) ? point : best, null);
        const value = nearest && Math.abs(nearest.t - t) <= channel.ttl ? valueOf(channel, nearest.value) : null;
        lines.push(channel.label + '：' + (finite(value) ? value.toFixed(channel.unit === 'bpm' ? 0 : 2) + ' ' + (relative() ? 'Δ ' : '') + channel.unit : '无有效数据'));
      }
      for (const marker of markers.filter(item => Math.abs(item.t - t) < windowSize() / 60)) lines.push('标记：' + marker.label);
      const tip = $('traceTooltip'); tip.textContent = lines.join('\n'); tip.hidden = false;
      tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, event.clientX + 14)) + 'px';
      tip.style.top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, event.clientY + 14)) + 'px';
      draw(plot);
    });
    canvas.addEventListener('pointerleave', () => {tooltipChart = null; tooltipX = null; $('traceTooltip').hidden = true; draw(plot);});
  }
  new ResizeObserver(() => plots.forEach(draw)).observe(document.querySelector('.feedback'));
  async function pollTrace() {
    try {
      const response = await fetch('/api/trace?after=' + cursor, {headers: {'X-Session-Token': token}});
      if (!response.ok) throw Error('trace unavailable');
      const payload = await response.json();
      // An old cursor can exceed the new server's sequence after a restart.
      if (streamId && streamId !== payload.stream_id) {
        const retry = await fetch('/api/trace?after=0', {headers: {'X-Session-Token': token}});
        if (!retry.ok) throw Error('trace unavailable');
        ingest(await retry.json());
      } else ingest(payload);
      connected = true;
    } catch (_) {connected = false;}
    render();
    setTimeout(pollTrace, 200);
  }
  pollTrace();
})();
