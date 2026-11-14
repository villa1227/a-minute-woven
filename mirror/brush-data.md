# 统一采集与数据画笔 · expressive-four-channel-v2

## 一条命令与一个页面

运行 `python mirror/serve.py`，打开 http://127.0.0.1:8767/ 。若原采集服务 8765 已运行则复用它；否则加载原 `server.Controller` 到镜子进程，不启动第二个端口、不需要 app.py。模式固定到退出，不在断线时自动创建第二采集器。内置模式退出会关闭自己的设备和记录；复用模式不关闭另一个进程。

同页提供摄像头启停、识别频率、左右眼 ROI 框选、表情启停、心率扫描/连接、皮电刷新/连接和原始记录/标记。它们调用原有 Controller.action，没有改动采集协议、作品或记录算法。浏览器拍照前会查询最新状态：正在记录/创作则拒绝；否则暂停采集摄像头并等它释放后申请浏览器摄像头。拍照失败、关闭、定格或导入均解除拍照锁，但不会自动重开采集。拍完在本页重新开启采集与表情。

实机接入另修复 `acquisition/eye.py` 的既有 CascadeClassifier 空模型错误：Python 文件读取＋内存反序列化、明确失败检查及中文路径回归测试。不改变检测算法。

## 接口与鉴权

- 首页注入每进程随机令牌；API 使用 `X-Mirror-Token`，限制本机 Host。GET 若有 Origin 必须匹配，POST 必须有匹配 Origin 和 application/json。无 CORS 或远程访问。
- `GET /api/sensors?after=N&stream_id=ID`：connected/error/reset/mode/state/trace。mode 为 integrated/shared；state 提供设备枚举、消息、样本、记录状态，排除记录文件路径和令牌。trace 包含 stream_id/now_s/cursor/rows。
- 首次不传 cursor，返回当前 cursor、空 rows；stream 变化同样跳过历史。随后 200 ms 读取新增 seq，不按轮询次数生成采样。403 重取原服务令牌重试一次。失败清 cursor，重连重新设参考。
- `POST /api/device/<command>` 仅允许 camera_start/camera_stop/roi、scan/heart_connect/heart_stop、eda_scan/eda_connect/eda_stop、expression_start/expression_stop、record_start/record_stop/marker。参数沿用原接口。上游 POST 不自动重试，避免重复操作；原始设备错误回传用于排查。不开放任意路径、URL、作品生成命令或远程目标。
- `GET /api/device-frame`：已鉴权的 JPEG 预览或 204，仅设备区域展开且可见时请求。请求不新增采样。框选 ROI 使用原画面尺寸和方向。
- 静态白名单只提供本目录 JS/CSS 和首页，不暴露 Python、目录或本地文件。不接受重定向、上传照片；凭据不落盘。

trace 的 t/now_s 属于原采集器单调时基。浏览器使用收到 now_s 时的 performance.now 外推新鲜度，不把 Python 时钟与笔时间相减。网络等待超 1.5 秒暂回退；浏览器读取超时 7 秒，上游 GET 超时 2 秒。图像、输入不写服务端；原始记录按钮只有用户点击后才会调用原记录逻辑。

## 参考与缺失

眼部要求 candidate_unvalidated 和正数直径；心率要求正数、无明确接触丢失；皮电要求 received_unvalidated 且 0～1023 整数（0 合法）；表情要求 classified_unvalidated、完整非负有限七类分数、总和为正。映射内部归一化分数，不改变后端原值。

当前值用眼部/皮电最近 1 秒中位数，心率最近 5 秒中位数。TTL：眼 2 秒、心率 5 秒、皮电/表情 1 秒。最新状态明确无效或设备关闭立即失效，不沿用更早有效值。“设置个人参考”取最近 5 秒有效值，需要每眼 ≥3、心率 ≥2、皮电 ≥20 且当前有效；不足则该通道 ref=null。

换照片、后端重启/重连清全部参考；同照片只重算底稿会清笔画、保留参考。camera_reset/ROI 变更、heart_reset、eda_reset/stream_id/segment 改变清相应参考。双眼独立参考，缺一眼只用另一眼的相对变化。所有通道缺失时依然可画，不伪造信号。

## 可调反馈强度

强度 g 为 1～5、步长 0.5，默认 3“明显”；1 对应先前温和映射。连续参数按 `1-exp(-dt/0.5)` 平滑。调整只作用于新笔画，不修改既有墨迹、原始笔压或坐标。缺失通道独立回到基础：石墨 [54,61,62]、2 px、opacity=0.85、softness=0、hardness=1、wobble=frequency=0、圆笔。关闭映射立即改黑色 2 px、不透明硬边圆笔。

下列尺寸均是处理图像像素，CSS 显示可能缩小：

| 维度 | 强度 1（温和） | 默认强度 3（明显） | 强度 5（强烈） |
| --- | --- | --- | --- |
| 眼部变化限幅 | ±30% | ±10% | ±6% |
| 线宽 | 1.5～4 | 3～16 | 4.5～28 |
| 硬度 | 0.9～0.6 | 0.9～0.35 | 0.9～0.2 |
| 皮电差值限幅 ADC | ±100 | 约 ±33.3 | ±20 |
| 透明度 | 0.90～0.60 | 0.95～0.35 | 0.98～0.23 |
| 柔边 | 0～1.5 | 0～4.5 | 0～7.5 |
| 心率差值限幅 bpm | ±20 | 约 ±6.67 | ±4 |
| 侧向摆动 | 0～0.8 | 0～5.6 | 0～10.4 |

精确公式：e=g−1；眼部 c 为每眼 `(v/ref−1)` 限幅 ±0.3 的有效眼均值，u=(clamp(g*c,−0.3,0.3)+0.3)/0.6；width=1.5+0.75e+(2.5+5.25e)u，hardness=0.9−min(0.7,0.3+0.125e)u。皮电 d=(ADC−ref)，反转时乘 −1；u=(clamp(g*d,−100,100)+100)/200；opacity=min(0.98,0.9+0.025e)−min(0.75,0.3+0.15e)u，softness=1.5g*u。心率 d=bpm−ref，u=(clamp(g*d,−20,20)+20)/40；wobble=(0.8+2.4e)u，frequency=有效 BPM/60。

表情按七类分数混色；g 从 1 到 3 时从原调色渐变为更饱和调色，3～5 保持饱和色。顺序 happy/sad/angry/fearful/surprised/disgust/neutral：原 RGB 为 [183,132,51]/[55,76,135]/[161,73,57]/[119,102,140]/[50,132,126]/[112,120,63]/[54,61,62]；饱和 RGB 为 [228,148,20]/[40,74,204]/[213,47,32]/[143,65,185]/[10,164,141]/[116,145,25]/[54,61,62]。不凭空改写中性分类为彩色。

最高表情分 ≥0.45、同标签持续 ≥1 秒且样本间隙 ≤1 秒后切换纹理家族：happy/neutral 圆润，sad/fearful 纤维，其余颗粒；不稳定或过期用圆笔。textureStrength=g，增强纤维/颗粒的范围、大小和覆盖。参考点处参数位于映射中部，与无信号基础值不同。皮电方向是艺术约定，不声称 ADC 越高电导率越高；节奏不是实际逐搏检测；眼部仍是未标定像素候选。

## 绘制和重放

`BioBrush.BrushMapping(clockSeconds)`：ingest(packet)、disconnect()、reset(keys?)、setReference()、references()、target()、brush()、diagnostics()；设置为 enabled、reverseEda、intensity。`BrushRenderer(ctx,seed).draw(rawPenSample,brushSnapshot)` 沿路径每 0.5 px 生成印记，以 seed/strokeId/序号固定纹理。插值只绘制墨迹、不写 samples；pressure 不控制线宽。柔边为轻量 Canvas 阴影效果，印记 alpha 补偿重叠，反复描画仍叠色。

输入 JSON v2 含 renderSeed/samples/segments/referenceHistory/configurationHistory/mapping，configuration 现在含 intensity；每段实际 brush 包含颜色、尺寸和 textureStrength、intensity、mappingVersion。`BrushRenderer.replay(ctx,exportedV2)` 在同尺寸空透明画布重放，缺少 textureStrength 的旧段按 1 处理，旧版快照仍可重绘。不同系统 Canvas 栅格化可能有差异。本轮不增加不受信文件导入器。

## 验证

单元测试检查参考、过滤、过期、平滑、强度增益及固定种子；HTTP 检查本机鉴权、允许命令、拍照/记录互斥及内置/复用选择。浏览器合成数据覆盖同页设备开关、采集摄像头释放后拍照、记录保护、滑块、原始笔压、旧笔画不变、v2 逐像素重放、PNG 导出和移动排版。

同一合成小变化（单眼 +4%、心率 +5 bpm、ADC +15），同一路径的强度 1/3/5 比较：宽度约 2.92/12.10/24.08 px，摆动约 0.50/4.90/10.40 px。测试比较图仅保存到 diagnostics/mirror/。它证明视觉放大可见，不代表实际参与者信号或真实端到端延迟；实机需另行试画。
