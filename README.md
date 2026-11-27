# 赛博镜子 · Cyber Mirror

一件交互自画像装置：参与者对着镜头留下影像，亲手把自己画成一幅自画像。笔由手控制，笔触同时被参与者自己的瞳孔变化、心率、皮肤电和面部表情改变。全部在本机运行，不上传人脸照片与原始信号；只有最终作品在参与者勾选同意后才上传，用于扫码带走。

项目源自清华大学《现代加工技术与实践》课程的“互动艺术”创意环节。第一个版本是“一刻织锦 · A Minute, Woven”（把一分钟生理数据自动织成一幅作品），此后演进为让参与者亲手运笔的赛博镜子。仓库曾沿用旧名 a-minute-woven，现更名为 cyber-mirror；目录名未改，见下文“目录结构”。

## 它做什么

1. 拍照或导入人像，在浏览器本地生成黑色线稿（四档预设，五个参数可调）。
2. 用数位板在背景上自由涂色，线稿始终在顶层，没有绘画基础也能得到一幅清晰的个人自画像。
3. 四路信号同时调节新落下的笔触：眼部变化控制笔刷宽度与边缘硬度，心率控制笔触的横向摆动，皮电控制透明度与柔度，表情分类参与颜色与纹理选择。映射强度可调；缺失的通道留空，不生成虚构数据。
4. 可选叠加“织纹”底层，由一分钟内的真实采样逐段生成。
5. 完成后作品带时间戳与“Cyber Mirror”落款，可下载 PNG，或勾选同意后上传 ImgLoc 生成二维码；点击“下一位参与者”一键重置。

信号只用作艺术表达的素材，不用于判断情绪、认知或健康状态；系统只使用相对个人自身参考值的变化，不给出任何心理或医学结论。

主要在 Windows、Edge/Chrome、两路 USB 摄像头、Xiaomi Smart Band 10、Arduino UNO + Grove GSR 和 XP-Pen Deco 640 上验证。其他设备组合未系统测试。

## 版本演进

| 版本 | 启动与入口 | 状态 | 说明 |
| --- | --- | --- | --- |
| 一刻织锦 A Minute, Woven | `python app.py` → http://127.0.0.1:8765 | 前身，保留 | 60 秒数据自动织成一幅作品，参与者只能旁观。见“采集后端”一节与 [examples](examples/README.md) |
| 赛博镜子 · 描摹版 | `python mirror/serve.py` → http://127.0.0.1:8767/ | 实验版，保留 | 拍照线稿 + 手写板描摹 + 数据画笔；细致描摹门槛偏高。见 [mirror/README.md](mirror/README.md) |
| 赛博镜子 · 背景涂绘版 | 同一服务 → http://127.0.0.1:8767/background | **正式版** | 黑色线稿在上、大笔刷淡彩在下，多人交接与二维码分享。见 [mirror/background.md](mirror/background.md) |

三个前端共用同一个采集后端。正式展示只用 `/background`；另外两个页面作为实验版本保留，不再同步新增体验功能。各层之间的关系见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

需要 Python 3；连手环需要可用的蓝牙适配器。镜子服务只用 Python 标准库，采集后端需要以下依赖。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\download_expression_models.py   # 可选：表情识别模型
.\.venv\Scripts\python.exe mirror\serve.py
```

打开 http://127.0.0.1:8767/background ，使用当前版本 Edge 或 Chrome。不要直接双击 HTML。

一条命令、一个页面：启动时若原 8765 服务已运行，镜子会复用它；未运行则在镜子进程内加载原采集 Controller，不需要再运行 app.py。两种模式都在页面“设备与采集”里操作摄像头、手环与皮电。只在要同时使用织锦页和镜子时，才先启动 `python app.py` 再启动镜子。

基本流程：拍照 → 确认并生成线稿 → 开启设备，采集约 5 秒后设置个人参考 → 涂色 → 完成并生成二维码 → 下一位。设备、参考值与各面板的细节见 [mirror/README.md](mirror/README.md)。

## 目录结构

| 目录 / 文件 | 角色 | 内容 |
| --- | --- | --- |
| `mirror/` | 赛博镜子前端与统一服务 | `serve.py`（8767：复用或内置采集 Controller，提供 `/api/sensors`、设备指令、`/api/share/upload`）、`sharing.py`（ImgLoc）；描摹版 `index.html`/`app.js`/`tracing.js`，背景涂绘版 `background.*`；共用模块：线稿生成 `line-art-*`、笔输入 `pen-input.js`、数据画笔 `brush-*`、设备 `devices.js`、传感器 `sensors.js`、织纹层 `woven-layer.js`、分享 `artwork-share.js`；文档 `README.md`、`background.md`、`brush-data.md`、`participants-sharing.md` |
| `acquisition/` | 采集后端，三个前端共用 | 摄像头 `camera.py`、双眼候选 `eye.py`、蓝牙心率 `heart.py`、皮电 `eda.py`、表情 `expression.py`、实时缓冲 `live.py`、同步记录 `core.py`、织锦会话 `artwork.py`、传感器接口 `interfaces.py` |
| `server.py` | 采集服务与织锦接口（8765） | 设备管理、`/api/trace`、原始记录、织锦会话；入口 `app.py`，`start.bat` |
| `web/` | 一刻织锦前端（前身） | `index.html`、`weave.js`、`feedback.js`、`artwork.js`、离线重绘 `render-artwork.html`；`woven-layer.js` 复用其中的 `drawBand` |
| `skin_sigma/` | 皮电固件与独立绘图 | UNO 固件 `skin_sigma.ino`、串口解析 `gsr.py`（`eda.py` 复用）、`live_plot.py` |
| `models/expression/` | 表情模型清单 | 模型文件由脚本下载，`.onnx` 不入库 |
| `scripts/` | 工具脚本 | `download_expression_models.py` |
| `diagnose.py` | 硬件检查 | `diagnose.py camera` / `diagnose.py ble` |
| `docs/` | 文档 | 架构、采集与织锦接口契约、表情模块、可视化与报告说明 |
| `examples/` | 合成样例 | 不含任何参与者数据，供测试与离线重绘使用 |
| `tests/` | 测试 | Python unittest、Node `--test`、Playwright 浏览器检查（`check_*_browser.cjs`） |
| `third_party/`、`mirror/vendor/` | 第三方许可 | OpenCV Zoo（YuNet、MobileFaceNet）、qrcode-generator |
| `recordings/`、`diagnostics/`、`.deps/` | 本地数据与依赖 | 被 `.gitignore` 排除，仓库不含个人采集记录、摄像头原图或蓝牙扫描快照 |

## 采集后端（三个前端共用）

### 双眼采集

- 连续取图、识别和网页预览分开运行；识别默认目标 20 Hz，预览目标 20 fps，实际值取决于设备和处理速度。每次识别只处理最新帧，丢弃等待中的旧帧。
- 两只眼睛均手动框选后跳过自动定位；自动定位按约 0.5 秒间隔运行。识别椭圆仅叠加最近 150 ms 内、同一眼区设置的结果；超过时限隐藏，不表示这帧重新识别成功。
- 面板显示取图/识别频率、取图/识别/编码耗时和识别帧龄。设备面板折叠或页面进入后台后暂停预览请求，后台采集不停止。
- 选择摄像头后点击“打开摄像头”，自动模式分别寻找画面左侧和右侧的眼区。自动检测不稳定时，在预览中拖动框住单只眼睛；每侧可单独恢复自动。
- `IMG-L` 和 `IMG-R` 是未额外翻转的图像位置，不直接代表人的生理左眼/右眼。两侧分别输出直径候选、位置和质量，单侧失败时该侧为缺失，不会复制另一眼或补零。
- 现阶段保留像素单位。之后用固定外壳约束相机与眼睛距离，再加入标定物建立尺寸换算；当前没有距离补偿。
- 算法是暗区轮廓候选检测，需要核对绿色椭圆是否贴合瞳孔。眼区框本身不是瞳孔边缘。

### 手环、皮电与表情

- 开启手环心率广播后，扫描并选择自己的 Xiaomi Smart Band 10，再点击连接。2026-10-21 实测此手环提供标准心率通知，未附带 RR 间期；程序保留原始报文，不由 BPM 反推 HRV。
- Grove GSR 使用 `skin_sigma/skin_sigma.ino`（UNO、A0、115200 波特率，目标 20 Hz）。在设备面板刷新串口并选择 USB-SERIAL CH340，点击“连接皮电”；程序不会自动烧录或打开串口。连接前关闭 Arduino IDE 串口监视器或 `skin_sigma/live_plot.py`，避免争用。
- 显示原始 ADC、实测接收频率、电脑/板端间隔及缺帧、重复、解析错误统计。超过 1 秒没有有效数据会停止显示当前值。保留 ADC 读数，不声称已标定电导率，不推断情绪。
- 断开皮电不终止其他设备的同步记录。更换皮电连接前须先结束当前记录或创作。
- 表情识别在本机运行，默认目标 5 Hz，七类分类，仅一人完整脸部入镜时有效；首次运行 `python scripts/download_expression_models.py` 安装模型。详见 [表情模块与接口](docs/expression.md)。

### 实时反馈与参考值（织锦页面的设备面板）

- 面板只显示画面左眼、画面右眼候选直径与实际心率，并显示最近 60 秒的简洁曲线。
- “记下当前值”使用各通道最近 10 秒内有效样本的中位数（皮电取最近 5 秒至少 20 个有效样本），后续显示当前值相对于该个人参考值的差（px / bpm）。参考值属于本次页面。
- 新参考至少需要 3 个有效眼区样本、2 个有效心率样本，并且通道仍有新数据。切换摄像头、修改眼区、重新连接手环或重启皮电时，相应通道的参考值失效。
- 缺失、失去接触和长时间无更新留空。心率旁的脉动按最新 BPM 控制动画速度，是频率示意，不是逐搏检测。
- `/api/trace?after=<cursor>` 提供最近 180 秒的增量采样缓冲，使用与采集状态相同的会话令牌。绘图轮询不会补造传感器样本，也不要求先开始磁盘记录。
- 两个镜子页面的参考规则不同：“设置个人参考”取最近 5 秒有效值，各通道有时效，详见 [mirror/brush-data.md](mirror/brush-data.md)。

### 同步记录与本地数据

每次记录保存在 `recordings/日期_唯一编号/`：

- `metadata.json`：设备、采样设置、双眼手动区域、格式版本（2）和时钟说明。
- `samples.jsonl`：带统一主机时间戳的完整数据，双眼位于 `data.eyes.image_left` / `image_right`；异常报文和重启事件也在这里。
- `camera.csv`、`heart_rate.csv`、`eda.csv`：各通道的表格形式；皮电 CSV 的 `seq` 为主机记录序号，`device_seq` 为板端序号。
- `frames/`：仅勾选保存采样原图后生成 JPEG。

主机单调时钟用于对齐，UTC 用于追溯。它们是主机读取/接收时间，尚未校准相机、蓝牙的传输延迟。停止记录后再更换摄像头。关闭网页不会自动停止服务；结束前停止记录、关闭设备，再在命令窗口按 Ctrl+C。

`recordings/`、`diagnostics/`、`.deps/`、虚拟环境与缓存被 Git 忽略。

### 扩展接口

完整接口契约、数据字段、HTTP API 和扩展示例见 **[开发接口说明](docs/interfaces.md)**。

- 新增适配器使用 `acquisition.interfaces.SamplePublisher.publish(source, data, clock)` 发布真实采样，统一进入实时缓冲与原始记录；皮电已采用此接口。新增 source 的图表、CSV、作品映射需按接口文档显式接入。
- `acquisition/eda.py` 复用 `skin_sigma/gsr.py` 的串口解析和采集，通过真实采样回调调用 `Recorder.emit('eda', data, clock)` 进入同一会话。独立绘图程序仍可单独使用，但不能与主程序同时占用同一串口。
- 织锦作品交付：完成后的 `artwork.json` 可用 [离线重绘页面](web/render-artwork.html) 加载并导出，或调用 `Weave.draw()` 自定义 Canvas 页面。

## 验证

```powershell
python -m unittest discover -s tests -p "test_*.py"
node --test tests/test_mirror.cjs tests/test_pen_input.cjs tests/test_brush.cjs tests/test_background_brush.cjs tests/test_mirror_woven.cjs
node --test tests/test_weave.cjs tests/test_feedback.cjs
```

浏览器检查脚本（`tests/check_*_browser.cjs`）需要 Playwright、Edge 和运行中的镜子服务，使用合成设备响应与笔事件，不操作真实传感器。各脚本的覆盖范围见对应文档；测试图片说明见 [tests/mirror-fixtures.md](tests/mirror-fixtures.md)。

`diagnose.py camera` / `diagnose.py ble` 用于硬件检查。

## 多人展示与分享

“下一位参与者”重载页面并清掉照片、线稿、笔画、参考值与二维码，保留落盘的历史记录；“完成并生成二维码”把最终作品 PNG 上传 ImgLoc（默认保存约 1 年，每 IP 每小时上限 60 张），仅在参与者勾选同意后执行。流程、时效与外部服务限制见 [mirror/participants-sharing.md](mirror/participants-sharing.md)。

## 许可

- 仓库自有代码以 MIT 许可发布，见 [LICENSE](LICENSE)。
- 第三方组件保留各自的许可与署名：OpenCV Zoo 的 YuNet（MIT）与 MobileFaceNet（Apache-2.0）见 `third_party/opencv_zoo/`；qrcode-generator 1.4.4（MIT）见 `mirror/vendor/`。
- 由 `scripts/download_expression_models.py` 下载的模型文件不在仓库内，适用其各自的上游许可（见 `models/expression/manifest.json`）。
