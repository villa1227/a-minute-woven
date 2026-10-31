# 开发接口：绘制作品与接入传感器

## 1. 从作品参数绘制最终图片

交付给绘图同学的最小文件：一份**完成后的** `recordings/<会话>/artwork.json`。它包含固定的绘制参数和种子，不需要视频、串口或原始生理记录。请由参与者自行选择分享的作品参数，仓库不提交真实记录。

### 现成的离线工具

双击仓库的 `web/render-artwork.html`，选择 `artwork.json`，即可预览并导出 2400 × 3200 PNG。也可以启动主程序后访问 http://127.0.0.1:8765/render-artwork.html 。文件只在浏览器中读取，无文件上传接口。

支持作品格式 `schema_version: 1` 和 `2`，当前绘图风格 `renderer: "woven-v1"`。工具仅接受完成的 12 段作品；取消或未完成记录不会伪装成完整作品。

仓库提供 [完全合成的作品参数](../examples/artwork.synthetic.json)，可直接导入试绘，包含双眼独立变化和缺失数据场景。[样例说明及重新生成方法](../examples/README.md)适用于自定义绘图验收；它不包含真实参与者记录。

### 在自己的页面中调用 Canvas 绘图

引入 `web/weave.js` 后使用全局 `Weave`；Node.js 可 `require('./web/weave.js')`，但实际绘图仍需调用方提供兼容 Canvas 2D 的上下文。

```javascript
// artwork 来自本机文件或你自己的数据加载代码。
Weave.validateArtwork(artwork); // 校验格式、完成状态、段数和参数范围，错误抛异常
canvas.width = Weave.WIDTH;    // 2400
canvas.height = Weave.HEIGHT;  // 3200
Weave.draw(canvas.getContext('2d'), artwork); // 导出用完整分辨率
// 小尺寸预览也使用同一函数：
Weave.draw(preview.getContext('2d'), artwork, 720, 960);
```

`draw(ctx, artwork, width=2400, height=3200, elapsed=artwork.elapsed_s)`：绘制背景、可见织纹、作品编号、日期和二维码留白。完成的作品始终完整绘制。`drawBand(ctx, band)` 只绘制某一段，坐标为 2400 × 3200 的作品坐标。

`createAnimator(canvas)` 返回 `(artwork, elapsedSeconds) => void`，缓存纸张和固定段图形；调用方用 `requestAnimationFrame` 驱动。一个作品 ID 内已经发布的段必须保持不可变，改变段参数应创建新作品 ID 或重新创建 animator。v2 中第 i 段的揭示比例为 `clamp((elapsed-5-i*5)/5,0,1)`。网络轮询不是动画帧率。

### 作品字段与自定义风格

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 1：旧时序；2：5 秒准备，60 秒采集，65 秒绘制结束 |
| `renderer` | 当前为 `woven-v1`；另写风格时使用新的名称，不静默更改已有作品含义 |
| `id`, `created_at` | 作品编号和带时区日期；`id` 也参与纸张随机种子 |
| `status`, `downloadable` | 完整作品为 `completed`、`true` |
| `duration_s`, `interval_s`, `band_count` | 60、5、12；区间为 `[0,5)` 到 `[55,60)` |
| `preparation_s`, `display_duration_s`, `elapsed_s`, `phase` | v2 新增展示时间为 5、65；phase 为 preparing/weaving/finishing/completed（或 idle/cancelled/error） |
| `references` | left/right/heart 各自首次有效窗口中位数，缺失为 null |
| `bands[i].index`, `start_s`, `end_s`, `seed` | 段位置、采样区间和固定纹理种子 |
| `bands[i].values`, `counts` | left/right 为候选像素直径，heart 为 bpm；有效样本中位数及数量 |
| `bands[i].amplitude.left/right` | 相对参考 ±30% 限幅后映射到段高度的 0.08～0.24；缺失为 null |
| `bands[i].threads`, `base_threads` | 心率相对参考 ±20 bpm 映射为 16～40；心率缺失用 22，基础织纹为 22 |
| `bands[i].empty` | 生理通道全缺失；仍绘制基础织纹 |
| `canvas.qr_space` | `[1920,2760,320,320]`，应保持留白 |

v1 早期作品可能没有 `base_threads`，绘图已有默认回退；`preview` 只属于旧版临时预览，不是最终作品数据。自定义绘图可忽略现成 Canvas 实现，直接读取 `bands`；必须用固定种子保证刷新、重绘、导出一致，不从缺失值推导心理判断。不同平台字体栅格化可能有差异。

如需改变数据到图形的映射，修改作品聚合器 `acquisition/artwork.py`，增加对应测试，并为新字段/不兼容语义升级格式或 renderer；只改外观时可提供独立 renderer。皮电当前保存在原始记录中，**尚未进入 `bands`**。

## 2. 替换或增加设备采集

新增设备的推荐出口是 `acquisition.interfaces.SamplePublisher`，它不依赖 HTTP 或具体硬件，统一发布到 `LiveTrace` 和当前 `Recorder`。`SensorAdapter` 是可选的结构化类型约定：`start()` 启动后台读取，`stop(timeout=5)` 释放传输资源。`skin_sigma.GsrService` 保留原有 connect/disconnect 生命周期，`acquisition/eda.py` 展示了如何把已有服务桥接到 publisher。

```python
from acquisition.interfaces import SamplePublisher
from acquisition.core import stamp

publisher = SamplePublisher(recorder, trace)

def on_transport_packet(packet):
    clock = stamp()  # 真正收到数据时取一次主机时间，不在网页轮询时取样
    sample = decode_packet(packet)  # 调用方的协议解析函数
    publisher.publish('eda', {
        'device_seq': sample['seq'], 'device_ms': sample['millis'],
        'adc': sample['adc'], 'quality': 'received_unvalidated',
        'break_before': sample['gap'], 'segment': sample['segment'],
        'unit': 'ADC', 'raw_hex': bytes(packet).hex(),
    }, clock)

def on_reconnect():
    publisher.event('eda_reset', {'message': 'reconnected'})
```

`publish(source, data, clock=None)` 要求 source 为小写字母开头、最多 64 字符的字母/数字/下划线名称；data 是 JSON 对象，无 NaN/Infinity。接口复制数据后同步发布，不创建虚构样本，不负责设备协议解析或自动线程调度。缺少 clock 时取当前主机时间。磁盘写入异常抛给采集器，调用方应显示错误或结束记录。

每个 clock 仅包含 `host_monotonic_ns`（本进程单调纳秒整数）和 `host_utc`（UTC ISO 字符串）。设备 `millis`、序号必须放在 data 中。不要把其他电脑或设备的单调时间冒充主机时钟。未记录时仍有实时反馈；记录启动前的样本不补写。创作截止时间拒收截止后的内置传感器样本，普通记录没有该截止限制。

### 内置数据通道契约

| source | 主字段与有效性 | 现有消费者 |
| --- | --- | --- |
| `camera` | `eyes.image_left/right`，各自包含 `quality`、`candidate_diameter_px`；有效候选为 `candidate_unvalidated` 且直径为有限正数；缺失直径 null | 双眼图表、JSONL/CSV、作品聚合 |
| `heart_rate` | `bpm` 有限正数；`contact_detected` 不为 false，quality 不为 contact_lost/zero_bpm；可选 RR 保持原始含义 | 心率图表、JSONL/CSV、作品聚合 |
| `eda` | `adc` 为 0～1023 整数（0 是合法 ADC），quality 为 received_unvalidated；`break_before` 在缺帧/断点为 true，`segment` 在重启/回绕改变 | 皮电图表、JSONL/CSV；不影响作品 |
| `event` | `kind` 加事件字段；使用 camera_reset、heart_reset、eda_reset 可清除对应页面参考 | 图表与 JSONL |
| 新名称，如 `temperature` | 自定义 JSON 对象，带明确 unit/quality | 通用 JSONL、实时 trace；不会自动生成 UI、CSV 或作品映射 |

替换瞳孔算法时，还需保持预览所需的 `roi`、`roi_mode`、`candidate_center_px`、`candidate_ellipse_px` 字段；具体结构见 `acquisition/eye.py`。空值也要提供字段，避免预览假定键不存在。左右按未额外翻转的图像位置，不是生理左右眼。

### 数据记录、线程与扩展清单

- `Recorder.emit(source, data, clock)` 是底层写入接口；`camera`、`heart_rate`、`eda` 写对应 CSV，所有通道写 `samples.jsonl`。主机行 `seq` 属于 Recorder，设备序号使用 `device_seq`，避免覆盖 CSV 主机序号。
- 同一会话同一 source 的 CSV 字段必须稳定，缺失值用 null。嵌套结构以 JSON 保存；新增自定义通道默认只写 JSONL，需要 CSV 时显式扩展 Recorder 的 CSV 通道列表并测试字段稳定性。
- 同一设备不要同时调用 publisher 和原来 recorder/trace 的路径，否则会重复记录。现有摄像头与心率仍保留原有发布路径；新适配器推荐 publisher。
- 回调同步执行，不能阻塞等待 UI，也不要在回调持有设备锁时获取 Controller 锁。锁顺序保持设备 → recorder → artwork；Controller 不应在持有 recorder 锁时再查询设备。
- 替换已有硬件只需规范化为上述字段，保留质量状态及原始协议；新 source 要进一步添加 Controller 生命周期/状态、`record_settings` 元数据、LiveTrace 精简字段、前端展示和必要作品聚合，不能只改一个 source 字符串。
- 对 USB/串口使用完整枚举（pyserial），不依赖 Win32_SerialPort，避免漏掉 CH340；设备断开时发 reset 事件，保留已采记录，不阻塞其他通道。

## 3. 本机 HTTP 接口

新增表情通道 `expression`，包含七类分数、质量状态及对应帧时间。它通过 SamplePublisher 写入 JSONL/CSV，只显示并记录，不参与作品聚合。完整的启停接口、字段和安装方式见 [表情接口](expression.md)。

服务仅监听 127.0.0.1:8765。获取首页后，其内联 `const token` 为会话令牌；开发工具可读首页提取，令牌不应写入文件或提交仓库。前端脚本使用现有 `token`。服务重启需要重新获取令牌。

| 接口 | 参数 / 结果 |
| --- | --- |
| GET `/api/state` | 当前设备状态、最新数据、新鲜度、camera_metrics、eda 状态及端口、记录状态 |
| GET `/api/trace?after=N` | 180 秒环形缓冲：stream_id、now_s、cursor、rows；row 为 seq/t/source/data，不是原始记录文件结构 |
| GET `/api/artwork` | 当前作品参数和时间状态；v2 preview 为 null，前端只动画显示固定 bands |
| GET `/api/frame` | 最近预览 JPEG，暂无新鲜画面时 204；请求不产生记录样本 |
| POST `/api/artwork_start`, `/api/artwork_cancel` | JSON `{}`，成功 `{ok:true}`；创作与普通记录互斥 |
| POST `/api/camera_start` | index、rate（1～60，默认20）、save_frames；stop 为 `/api/camera_stop` |
| POST `/api/roi` | side=image_left/image_right/both，roi=[x,y,w,h] 或 null；both 仅允许 null |
| POST `/api/scan`, `/api/heart_connect`, `/api/heart_stop` | 心率连接传 address；scan 异步更新 state |
| POST `/api/eda_scan`, `/api/eda_connect`, `/api/eda_stop` | 皮电连接传 port，如 COM6；115200 固定 |
| POST `/api/record_start`, `/api/record_stop`, `/api/marker` | marker 传 label；停止后原始文件在 recordings/ |

API GET 需要 `X-Session-Token`；POST 还需要 `Content-Type: application/json`、匹配 localhost/127.0.0.1 的 Origin 和 Host。成功为 200，操作错误为 400 `{error:消息}`，鉴权失败为 403。接口没有远程设备写入端点，设备适配器应运行在本进程内；不要为方便远程调用移除本机访问限制。

trace 的 cursor 仅适用于相同 stream_id，服务重启后先从 after=0 重新获取；缓冲有时间/数量上限，不应当作永久记录。对完整作品分享应读取本机 artwork.json，HTTP 只恢复当前运行进程状态，不能在服务重启后自动加载旧会话。

## 4. 验证与本地回退

```powershell
python -m unittest discover -s tests -v
node --test tests/test_feedback.cjs tests/test_weave.cjs
```

离线导入/导出检查（需要 Playwright 和 Edge）：`node tests/check_render_import.cjs`。使用合成作品参数，不连接传感器，不创建真实采集记录。

可选浏览器检查：安装 Playwright 并具备 Edge 后，启动主程序，执行 `node tests/check_browser.cjs`。该检查会短暂创建并取消一幅测试作品，原始记录保留本机。硬件对比运行 `python tests/check_camera_performance.py --index 0`，不保存图片；需要本地备份标签 `backup/gsr-before-smooth-render`，仅比较该机器当时状态。

本地备份提交 `a503865` 包含皮电接入但尚无平滑动画。备份标签仅留本机，当前发布只推送 main 分支。
