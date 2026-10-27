(() => {
  let artwork = null;
  const get = id => document.getElementById(id);
  get('file').onchange = async () => {
    artwork = null; get('download').disabled = true; get('error').textContent = ''; get('info').textContent = '';
    get('canvas').getContext('2d').clearRect(0,0,720,960);
    try {
      const file = get('file').files[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) throw Error('作品参数文件应小于 2 MB');
      const candidate = JSON.parse(await file.text());
      Weave.validateArtwork(candidate);
      artwork = candidate;
      Weave.draw(get('canvas').getContext('2d'), artwork, 720, 960);
      get('info').textContent = '作品 ' + artwork.id + ' · 格式 v' + (artwork.schema_version || 1);
      get('download').disabled = false;
    } catch (e) {get('error').textContent = e.message;}
  };
  get('download').onclick = async () => {
    if (!artwork) return;
    get('download').disabled = true;
    try {
      const canvas = document.createElement('canvas'); canvas.width = Weave.WIDTH; canvas.height = Weave.HEIGHT;
      Weave.draw(canvas.getContext('2d'), artwork);
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      if (!blob) throw Error('PNG 导出失败');
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'woven_' + artwork.id.replace(/[^a-zA-Z0-9_-]/g,'_') + '.png';
      document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
    } catch(e) {get('error').textContent=e.message;}
    finally {get('download').disabled=false;}
  };
})();
