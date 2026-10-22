(() => {
  const canvas = $('artCanvas'), ctx = canvas.getContext('2d');
  let artwork = {status: 'idle', bands: []}, renderKey = '', inFlight = false, exporting = false;
  const start = $('artStart'), cancel = $('artCancel'), download = $('artDownload');
  const live = () => artwork.status === 'running';
  function render() {
    const key = JSON.stringify([artwork.id, artwork.bands, artwork.preview]);
    if (key !== renderKey) {
      renderKey = key;
      Weave.draw(ctx, artwork, canvas.width, canvas.height);
    }
    start.disabled = inFlight || live() || Boolean(state?.recording);
    start.textContent = artwork.id && !live() ? '再织一幅' : '开始创作';
    cancel.hidden = !live(); cancel.disabled = inFlight;
    download.hidden = !artwork.downloadable; download.disabled = exporting;
    const elapsed = Math.min(60, Math.max(0, artwork.elapsed_s || 0));
    $('artProgress').value = elapsed;
    $('artTime').textContent = live() ? Math.ceil(60 - elapsed) + ' 秒' : '60 秒';
    $('artBands').textContent = artwork.bands.length + ' / 12';
    $('artHint').hidden = artwork.status !== 'idle';
    $('artCanvas').setAttribute('aria-label', '数据织锦，已完成 ' + artwork.bands.length + ' 段，共 12 段');
    const messages = {
      idle: '准备好后，留下一分钟。',
      running: artwork.bands.length ? '织纹正在生长。已完成的部分将留在画面上。' : '正在收集第一段纹理，5 秒后落下第一笔。',
      completed: '这一分钟，已经织成。',
      cancelled: '本次创作已取消，原始记录已保留。',
      error: artwork.error || '创作中断，请检查设备与记录状态。'
    };
    $('artStatus').textContent = messages[artwork.status] || '等待创作';
    if (artwork.status === 'completed' && artwork.bands.every(band => band.empty)) {
      $('artStatus').textContent = '传感器没有有效数据，作品仍由基础织纹完成。';
    }
  }
  async function refresh() {
    const response = await fetch('/api/artwork', {headers: {'X-Session-Token': token}});
    if (!response.ok) throw Error(response.status === 403 ? '服务已重启，请刷新页面。' : '暂时无法获取作品，请稍后重试。');
    artwork = await response.json(); render();
  }
  async function command(name) {
    if (inFlight) return;
    inFlight = true; $('artError').textContent = ''; render();
    try {
      const response = await fetch('/api/' + name, {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Session-Token': token}, body: '{}'});
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '操作未完成');
      await refresh();
      if (name === 'artwork_start') $('devicePanel').open = false;
    } catch (error) {
      $('artError').textContent = error.message;
    } finally {inFlight = false; render();}
  }
  start.onclick = () => command('artwork_start');
  cancel.onclick = () => command('artwork_cancel');
  download.onclick = async () => {
    if (!artwork.downloadable || exporting) return;
    exporting = true; $('artError').textContent = ''; render();
    try {
      const output = document.createElement('canvas');
      output.width = Weave.WIDTH; output.height = Weave.HEIGHT;
      Weave.draw(output.getContext('2d'), artwork);
      const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
      if (!blob) throw Error('图片导出失败，请重试');
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'woven_' + artwork.id + '.png';
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $('artStatus').textContent = '下载已发起，请在浏览器下载列表中查看。';
    } catch (error) {$('artError').textContent = error.message;}
    finally {exporting = false; download.disabled = false;}
  };
  async function pollArtwork() {
    try {await refresh(); $('artConnection').textContent = '';}
    catch (error) {$('artConnection').textContent = error.message; start.disabled = true;}
    setTimeout(pollArtwork, 500);
  }
  render(); pollArtwork();
})();
