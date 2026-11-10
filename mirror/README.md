# 赛博镜子 · 拍照线稿

这是独立的第一版前端，不连接、修改或替换原采集后端，也不改变织锦页面。只实现拍照/导入、确认、照片轮廓线稿和 PNG 下载。

## 启动

在仓库根目录运行：

```powershell
python -m http.server 8767 --bind 127.0.0.1 --directory mirror
```

打开 http://127.0.0.1:8767/ ，使用当前版本 Edge 或 Chrome。页面没有构建步骤、第三方依赖、模型下载或远程请求。需要通过此本机地址打开，不要直接双击 HTML（Worker 和摄像头权限需要安全上下文）。该静态服务器只用于本机开发。

选择摄像头后点击“打开摄像头”，允许浏览器访问。在想拍照的时刻点击“拍照”，然后“确认使用”或“重拍”。没有自动拍摄或倒计时。也可导入 JPEG、PNG、WebP；导入后同样确认。原程序若正使用相同摄像头，请先在原设备面板关闭摄像头。

预览和拍下的照片均为镜像；导入照片不镜像，按 EXIF 方向解码。保留整张画面，不自动裁脸、去背景或修改五官。建议机位拍成大头照、使用简洁背景和均匀照明；照片边缘杂乱时，线稿也可能出现背景和头发纹理。可选“极简／简洁／标准／丰富”，“极简”比“简洁”更强地抑制纹理与短线；这不是生成模型绘制的概括人像。

页面下方“手动调参”可拖动滑块或直接输入数值，自动从同一确认照片重新计算；切换预设会重置这五项，线宽独立保留。点击“恢复当前预设”可撤销手动数值。参数不跨刷新保存。

| 参数 | 范围 | 作用 |
| --- | --- | --- |
| 平滑强度 sigma | 0.5～5 | 越大越少细碎纹理，也可能删去五官 |
| 边缘筛选分位 percentile | 0.10～0.99 | 越大越偏向强边缘，和其他参数共同决定结果 |
| 最低边缘阈值 minHigh | 1～512，整数 | 自动高阈值的下限；较小时可能不改变最终阈值 |
| 碎线过滤长度 minComponent | 0～300，整数 | 以 1000 px 最长边为参考缩放，实际最少 4 点 |
| 弱边缘连接比例 lowRatio | 0.10～0.90 | 越小越容易连接弱线，越大越严格、可能断线 |

想要更少细节，先选择“极简”，再逐项提高平滑、碎线过滤或边缘筛选。不要一次改所有数值；五官消失时往回调。极简不保证每张照片都只留下想要的人脸线条。

最长边限制 1600 像素，不放大小图；所有照片按原比例缩放（整数像素舍入可能有微小误差）。导入上限 25 MB、6000 万像素；解码失败会提示改用支持的照片格式。线宽 1～4 指处理分辨率像素，不是屏幕 CSS 像素。

照片与线稿只存在页面内存；不会上传、写浏览器存储或自动保存。拍照定格、导入照片、关闭摄像头或离开页面时停止媒体轨道。重拍/替换会丢弃旧照片和结果，刷新不会恢复。只有点击下载才交由浏览器保存白底黑线 PNG。

## 图像处理接口

`line-art-engine.js` 提供纯函数，浏览器 Worker 中为 `LineArtEngine.generate(image, options)`，Node.js 可用 `require('./mirror/line-art-engine.js')`。输入与输出：

```javascript
const result = LineArtEngine.generate(
  {width, height, data}, // RGBA，Uint8ClampedArray，单边不超过 1600
  {detail: 'standard', lineWidth: 1, tuning: {sigma: 2.2}} // tuning 可省略或部分覆盖
);
// {width, height, pixels, parameters, algorithm:'contour-canny-v2', edgePixels}
// pixels 是透明底黑线 RGBA：RGB 均为 0，alpha 表示覆盖率。
```

算法为灰度与透明合成、分离高斯平滑、Sobel 梯度、非极大值抑制、分位阈值/滞后连接、去除短小连通分量及线宽扩展。相同照片与参数输出确定；输入不会被修改。没有人脸关键点、语义去背景或云端推理。`edgePixels` 为加粗前的边缘像素数。

`detail` 可为 minimal/simple/standard/rich；`tuning` 只接受上表中的五个有限数值，超范围拒绝。`parameters` 返回预设名、线宽和全部实际生效参数，便于复现；未覆盖的值来自预设。`LineArtEngine.PRESETS`、`RANGES` 与 `resolveParameters(options)` 为同一来源，前端不另存一份默认值。既有三档默认参数保持不变；v2 增加极简和手动控制。

页面使用异步包装：

```javascript
const processor = new LineArtProcessor('line-art-worker.js');
const result = await processor.generate(confirmedImageData, {detail:'standard',lineWidth:1});
// 包含以上字段，额外提供 layer（透明黑线 ImageData）和 processingMs。
layerContext.putImageData(result.layer, 0, 0);
processor.cancel(); // 终止当前任务，Promise 以 AbortError 拒绝
processor.dispose(); // 离开页面时释放 Worker
```

每个新任务终止旧 Worker，始终从已确认照片的副本计算；取消不是仅忽略旧消息，因此不会积压耗时任务。`processingMs` 不包含 Worker 启动和像素复制。预览和 PNG 用同一个透明层合成到白底。快速更改参数时下载禁用，只有最新任务完成后才可导出。

原照片、参考线稿、描摹分别为独立图层。生成线稿后可使用 XP-Pen Deco 640 描摹，固定黑色 2 px；笔压仅读取与显示，不改变线宽或颜色，也没有生理映射和后端数据流。

## 手写板输入

实机状态：用户已于 2026-11-08 确认 XP-Pen Deco 640 在官方驱动下显示“笔输入”，压力随轻压、重压变化。此确认不代表其他品牌、浏览器或驱动组合均已验证，也未测定硬件原始采样率。

使用官方 XP-Pen 驱动和 Edge/Chrome 的 Pointer Events，不直接读取 USB 报文、不占用厂商接口。生成线稿后，在右侧画布落笔即可；诊断区显示笔/鼠标类型、图像位置、0～1 笔压、倾斜与旋转、最近一秒实际接触点数及累计记录点数。悬停只更新读数，不存储或画线。零倾斜/旋转不证明硬件支持；鼠标压力明确标为回退，不当作真实笔压。浏览器不能可靠识别设备型号或 USB 是否断开，等待输入不代表拔出了手写板。

请在驱动中确认 Windows Ink 设置，并使手写板映射到显示该页面的屏幕。若只出现鼠标事件，或轻压重压没有数值变化，先检查驱动设置和浏览器。需要参与者实际轻压、重压、抬笔画几笔，才能确认真实笔压；自动测试生成的 pen 事件不构成实机验证。

主笔尖接触和默认启用的鼠标左键回退可画线；触摸、副指针、侧键和橡皮操作不画线。抬笔、越界重入、失焦、页面隐藏或取消会断开路径；只有新的 pointerdown 能在中断后重新落笔。缩放页面只调整显示坐标，不重置画布。清除描摹不改变底稿；隐藏底稿不影响描摹；现有 PNG 下载仍仅导出底稿。

替换照片或重新计算线稿会清除描摹和本次输入记录。输入仅在页面内存中，最多保留 50,000 点（接触及其释放样本），达到上限停止，需点击“清除描摹”才能重新记录。点击“下载输入 JSON”才保存文件，不含照片。

### 输入扩展接口

`pen-input.js` 的 `PenInput` 可独立使用（Node 可 require）；`reset(width,height,sessionId)` 设置图像坐标与照片会话，`process(pointerEvent,canvasRect)` 读取，`end(reason)` 中断笔画，`snapshot()` 提供诊断，`export()` 提供 JSON。构造时可传 `onSample(sample)`、`onEnd(reason)` 回调，后续笔刷处理应消费这个接口，不修改原始采样值。

统一样本字段：strokeId、eventType、pointerType、pointerId、x/y（原图像素）、nx/ny（未限幅归一化值）、outside、contact、pressure、tiltX/tiltY、twist、button/buttons、eventTimeMs、receivedTimeMs。压力和角度保持浏览器报告值；不声称取得硬件原始压力等级。`getCoalescedEvents()` 存在时只使用其样本列表，不再追加父事件，不生成预测或插值样本。两个时间字段为浏览器单调毫秒，不与原 Python 后端单调时钟混用。

JSON 包含 schemaVersion=1、sessionId（照片 UUID，同一照片重新生成仍相同）、canvas 尺寸、timeOrigin、clock、limit、full 和 samples。重开页面后不恢复。中断原因通过 onEnd 回调传出，不添加虚构的抬笔采样；仅浏览器实际 pointerup 才有对应释放样本。极端情况下上限可能截断笔画，此时 full=true。

`tracing.js` 通过 `MirrorTracing.enable(width,height,sessionId)`／`disable()` 管理独立描摹层。透明画布与底稿可见矩形一致，保留图像坐标而非 CSS 坐标。侧键、笔压映射、Pad 网络连接与完整作品导出留待后续。

## 验证

```powershell
node --test tests/test_mirror.cjs
node --test tests/test_pen_input.cjs
python -m unittest discover -s tests -p "test_*.py"
node --test tests/test_weave.cjs tests/test_feedback.cjs
```

可选完整浏览器验证（需要 Playwright、Edge 和上面的静态服务器）：`node tests/check_mirror_browser.cjs`。使用生成的测试图和模拟浏览器摄像头，覆盖镜像、定格释放、重拍、切换、权限拒绝/占用/断连、导入 EXIF、取消任务、下载和移动排版。样图及验证说明见 `tests/mirror-fixtures.md`。不提交参与者照片。

描摹浏览器验证：`node tests/check_pen_browser.cjs`，使用合成笔事件检查图层对齐、越界断线、输入 JSON、底稿显隐和清除；不代替 XP-Pen 真实输入确认。
