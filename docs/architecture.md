# 架构说明

本文描述仓库各部分的职责、依赖方向和数据流，便于在不读代码的情况下定位问题或做扩展。目录名沿用历史（`web/` 是第一版前端，`mirror/` 是正式版），本文件解释这种命名。

## 一、三层结构

```
┌──────────────────────────────────────────────────────────────────┐
│ 前端（浏览器）                                                   │
│  web/         一刻织锦（前身）      由 8765 服务直接托管           │
│  mirror/      赛博镜子 · 描摹版      /                           │
│  mirror/      赛博镜子 · 背景涂绘版  /background   ← 正式版       │
├──────────────────────────────────────────────────────────────────┤
│ 服务层（Python，仅监听 127.0.0.1）                                │
│  server.py        Controller：设备、/api/state、/api/trace、      │
│                   /api/frame、原始记录、织锦会话   端口 8765       │
│  mirror/serve.py  统一镜子服务：复用 8765 或在进程内加载 Controller │
│                   /api/sensors、/api/device-frame、/api/device/*、 │
│                   /api/share/upload                端口 8767       │
│  mirror/sharing.py ImgLoc 上传（仅最终作品 PNG，需页面勾选同意）     │
├──────────────────────────────────────────────────────────────────┤
│ 采集层 acquisition/（被 server.py 使用，三个前端共用）            │
│  camera / eye / heart / eda / expression / live / core / artwork  │
│  interfaces.SamplePublisher：新增传感器的统一发布接口             │
│  skin_sigma/  UNO 固件与串口解析（eda.py 复用 gsr.py）             │
│  models/expression/  OpenCV DNN 模型清单（onnx 不入库）            │
└──────────────────────────────────────────────────────────────────┘
```

依赖方向自上而下：`mirror/serve.py` 通过 `sys.path` 回头导入仓库根目录的 `server.Controller`，因此采集层只有一个实现，没有为镜子复制一份。

## 二、两条启动路径

| 用途 | 命令 | 端口 | 说明 |
| --- | --- | --- | --- |
| 只用赛博镜子（推荐） | `python mirror/serve.py` | 8767 | 启动时探测 8765：已运行则复用（Bridge 模式）；未运行则在同一进程内加载 Controller（内置模式）。模式在启动时固定 |
| 织锦页 + 赛博镜子 | 先 `python app.py`，再 `python mirror/serve.py` | 8765 + 8767 | 两个服务共用一个 Controller，避免两套采集争用摄像头、串口和蓝牙 |
| 只用织锦页 | `python app.py` 或 `start.bat` | 8765 | 前身版本，仍可运行 |

同一端口不能跑两个服务。退出镜子服务会释放它内置的设备并保存活动记录；复用模式不会关闭另一个进程管理的设备。

## 三、一次创作中的数据流

1. **采集**：`acquisition/` 的各工作线程从摄像头、蓝牙手环、串口皮电和表情模型得到真实样本，带主机单调时间戳写入 `Recorder`（`core.py`）和 `LiveTrace`（`live.py`，最近 180 秒的增量缓冲）。缺失、失去接触和长时间无更新保持缺失，不插值补造。
2. **读取**：镜子服务按增量游标向 Controller 读 `/api/state` 与 `/api/trace`，打包成 `/api/sensors`（含 `reset`、`trace.stream_id`、`cursor`、`rows`）。页面只消费 `rows` 里真实存在的样本。
3. **参考与映射**：页面 `sensors.js` / `background-sensors.js` 为每路通道建立个人参考（最近 5 秒有效值），`brush-mapping.js` 把相对变化平滑后转成笔刷参数（眼：宽度与硬度；心率：摆动；皮电：透明度与柔边；表情：颜色与纹理）。
4. **绘制**：`pen-input.js` 读取 Pointer Events，`background-renderer.js`（描摹版为 `brush-renderer.js`）按快照绘制；线稿由 `line-art-worker.js` 在 Worker 中从已确认照片本地生成。照片、线稿和笔画只在页面内存。
5. **导出与分享**：`artwork-caption.js` 合成带时间戳与落款的作品；`artwork-share.js` 在参与者勾选同意后 `POST /api/share/upload`，`sharing.py` 校验 PNG、展平白底、重新编码后上传 ImgLoc，页面用本地 `vendor/qrcode.js` 生成二维码。
6. **交接**：`participant.js` 的“下一位参与者”先确认没有进行中的记录，再重载页面清空本次全部状态；落盘的 `recordings/` 不受影响。

## 四、文件索引

| 关注点 | 文件 |
| --- | --- |
| 设备连接、ROI、记录 | `acquisition/camera.py`、`eye.py`、`heart.py`、`eda.py`、`expression.py`；前端 `mirror/devices.js` |
| HTTP 接口与鉴权 | `server.py`、`mirror/serve.py`；说明见 `mirror/brush-data.md`“接口与鉴权”与 `docs/interfaces.md` |
| 线稿算法 | `mirror/line-art-engine.js`（纯函数，Node 可 require）、`line-art-worker.js`、`line-preset.js` |
| 笔输入 | `mirror/pen-input.js`（`PenInput`，可独立使用） |
| 数据画笔 | `mirror/brush-mapping.js`、`brush-renderer.js`、`background-renderer.js`、`background-tracing.js` |
| 织纹层 | `mirror/woven-layer.js`，复用 `web/weave.js` 的 `drawBand`，经 `/woven-renderer.js` 只读提供 |
| 作品与分享 | `mirror/artwork-caption.js`、`artwork-share.js`、`sharing.py`、`participant.js` |
| 固件 | `skin_sigma/skin_sigma.ino`、`skin_sigma/gsr.py` |
| 原始记录格式 | `docs/interfaces.md`；可视化与报告表述 `docs/visualization-notes.md` |

## 五、设计约束

- 服务只监听本机回环地址；不开放局域网访问，不使用云端推理。
- 人脸照片、摄像头原图、原始信号不上传；只有最终作品 PNG 在明确同意后上传。
- 不为缺失通道生成样本，不把渲染插值当作真实采样，不由 BPM 反推 HRV，不由 ADC 声称电导率或情绪。
- 两个镜子页面和织锦页面共用同一个采集器；设备启停对一个页面生效即对所有页面生效。
- 实验版本（织锦页、描摹页）保留但不新增体验功能；正式维护入口是 `/background`。

## 六、历史说明

仓库最初以“一刻织锦 · A Minute, Woven”发布，所以第一版前端位于 `web/`，采集服务直接托管它。赛博镜子以独立目录 `mirror/` 加入，并逐步成为正式形态；为避免破坏既有测试与文档链接，目录名没有再次改动。GitHub 仓库名已于 2026-11 更改为 `cyber-mirror`，旧地址 `a-minute-woven` 由 GitHub 自动重定向。
