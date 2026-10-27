/* UI only: device callbacks, not browser polling, feed the recorder. */
(() => {
  let portsKey = '';
  $('edaScan').onclick = () => api('eda_scan');
  $('edaConnect').onclick = () => api('eda_connect', {port: $('edaPort').value});
  $('edaStop').onclick = () => api('eda_stop');
  const number = value => Number.isFinite(value) ? value.toFixed(1) : '—';
  function render(s) {
    if (!s?.eda) return;
    const e = s.eda, ports = s.eda_ports || [], key = JSON.stringify(ports);
    if (key !== portsKey) {
      portsKey = key;
      const old = $('edaPort').value;
      $('edaPort').replaceChildren(...ports.map(p => new Option(p.port + ' · ' + p.description, p.port)));
      if (!ports.length) $('edaPort').append(new Option('未找到串口，请连接后刷新', ''));
      const preferred = [e.port, old, 'COM6', ports.find(p => /CH340|Arduino|USB/i.test(p.description))?.port];
      $('edaPort').value = preferred.find(p => ports.some(item => item.port === p)) || ports[0]?.port || '';
    }
    $('edaPort').disabled = e.connected || s.recording;
    $('edaConnect').disabled = e.connected || s.recording || !ports.length;
    $('edaStop').disabled = !e.connected;
    $('edaAdc').textContent = e.fresh ? e.latest.adc : '—';
    $('edaRate').textContent = number(e.rate_hz);
    $('edaStatus').textContent = s.eda_ports_error || e.record_error ||
      (e.connected && !e.fresh ? '等待有效更新 · ' + e.status : e.status);
    $('edaTiming').textContent = '电脑接收间隔中位数 ' + number(e.interval_median_ms) +
      ' ms · 板端采样间隔 ' + number(e.device_interval_median_ms) + ' ms';
    $('edaStats').textContent = '本次连接：有效 ' + e.stats.samples + ' / 缺帧 ' + e.stats.missing +
      ' / 重复 ' + e.stats.duplicates + ' / 解析错误 ' + e.stats.parse_errors + ' / 重启 ' + e.stats.resets;
  }
  window.EdaPanel = {render};
  if (state) render(state);
})();
