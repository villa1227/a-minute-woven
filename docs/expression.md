# 本机表情识别

表情模块独立运行，复用当前摄像头最新原图，通过 OpenCV DNN 在 CPU 上计算。它只增加数据接口、设备面板显示与同步记录，**不参与作品聚合、颜色、密度或 PNG 生成**。仅一人完整脸部入镜时分类；不是对参与者真实情绪的测量。

## 安装和使用

使用主项目的 Python 环境和现有依赖，无需 TensorFlow、PyTorch 或云端 API。首次使用显式运行：

```powershell
python scripts/download_expression_models.py
python app.py
```

下载需要访问 GitHub。脚本遵循 HTTP_PROXY/HTTPS_PROXY 环境设置，按固定上游提交下载约 5 MB 的两份 ONNX 模型，并验证尺寸和 SHA-256。已安装且哈希正确的文件不会重复下载。启动主程序、开启识别不会自动联网；模型不随 Git 提交。模型缺失或不匹配只使表情任务报错，面板会显示安装命令。

打开主页面，在“设备与数据”先打开摄像头，再点击“开启表情识别”。默认 5 Hz，可选 1、2、5、10 Hz；实际速率取决于硬件。开启识别后再开始记录或创作。期间禁止启动/修改识别配置，可以停止。摄像头关闭或断连时表情任务退出，重新连接后需要手动开启。

显示七类模型分数与最高分类：angry/愤怒、disgust/厌恶、fearful/恐惧、happy/高兴、neutral/中性、sad/悲伤、surprised/惊讶。网络的 `label` 输出实际是七个 logits，本适配器用稳定 softmax 转成总和为 1 的相对模型分数；这些不是经过个体校准的情绪概率。不做平滑、插值或低分强制改为“中性”。

无人脸/多人脸时不分类；超 1 秒无新鲜结果时隐藏标签和分数。每张新帧至多推理一次，网页查询不增加样本。推理线程只处理最新帧，不累积队列，不在摄像头或瞳孔识别线程中计算。不额外保存脸部图片，已有“保存采样原图”选项仍独立生效。

## 接口与时钟

- `POST /api/expression_start`：JSON `{"rate":5}`，可选频率 1/2/5/10；摄像头必须已开启，记录与创作必须已停止。重复启动返回 400，不创建第二线程。
- `POST /api/expression_stop`：JSON `{}`，允许重复停止；不停止摄像头和记录。
- 鉴权、Origin/Host 与现有 POST 接口相同。
- `GET /api/state` 增加 `expression`：running、state（loading/running/stopped/error）、error、target_hz、fresh、age_s、sample、model。结果过期时 sample 可能保留用于诊断，消费者必须检查 running、fresh 和 sample.quality。停止后 sample 清空。
- `GET /api/trace` 新增 source=`expression`，数据结构与 sample 一致，沿用 cursor/stream_id；trace 的 t 来自帧主机时间。

`expression` 经 `SamplePublisher` 发布，活动记录同时保存到 `samples.jsonl` 和 `expression.csv`。字段如下，所有状态的字段集合固定：

| 字段 | 含义 |
| --- | --- |
| frame_id, frame_width, frame_height | 摄像头帧编号及原图尺寸；重开摄像头会重新编号 |
| quality | classified_unvalidated、no_face 或 multiple_faces |
| face_count, face_box, face_score | 检测到的人脸数；仅单人时给出原图 x/y/w/h 和检测分数 |
| scores, label | 七类分数字典及最高类英文名；无人脸/多人脸为 null，CSV 字典以 JSON 保存 |
| model_id | opencv-zoo-mobilefacenet-2022july |
| processing_ms, frame_age_ms, observed_hz | 本次检测+分类耗时、完成时帧龄、两次推理开始间隔折算频率；首条频率 null |
| completed_monotonic_ns, completed_utc | 推理完成的主机时间 |

JSONL 行级 `host_monotonic_ns`/`host_utc` 对应原始摄像头帧的主机取图时间，**不是推理完成时间，也不是摄像头硬件曝光时间**。会话开始前的帧不写入新会话；创作中第 60 秒及以后取图或完成推理的样本均不写入该记录。第 60～65 秒继续显示最新表情，但不延长采集记录。

记录 metadata.settings.expression 保存启用状态、目标频率、模型 ID、类别顺序、上游版本和模型 SHA-256。停止表情任务不终止其他传感器。替换识别模型时保持以上时钟/质量语义，更新模型 ID、类别及文档，不能悄悄改动类别顺序。

## 模型与许可

固定来源：[OpenCV Zoo 提交 48b10fa](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7)。模型明细见 `models/expression/manifest.json`。

- YuNet `face_detection_yunet_2023mar.onnx`：MIT，提供五点人脸检测。使用 OpenCV 4.x 兼容模型。
- Progressive Teacher / MobileFaceNet `facial_expression_recognition_mobilefacenet_2022july.onnx`：Apache-2.0，按上游约定使用五点非反射相似对齐到 112×112，BGR 转 RGB 后以 (x/255−0.5)/0.5 归一化。
- 对齐和推理适配参考上游 `facial_fer_model.py`，本地增加缓冲加载以支持 Windows 中文路径、完整分数、最新帧任务和记录接口。版权与许可副本见 `third_party/opencv_zoo/`。

## 验证

```powershell
python -m unittest discover -s tests -p "test_*.py"
node --test tests/test_feedback.cjs tests/test_weave.cjs
python tests/check_expression_performance.py --index 0 --seconds 5
```

最后一项需要空闲摄像头及已安装模型，会分阶段比较仅眼部识别与开启表情识别的速率、耗时、帧龄，随后释放摄像头；不保存图像或采集记录。正确输出与性能验证不代表表情分类准确率已被验证。

可选网页检查：安装 Playwright、具备 Edge 后执行 `node tests/check_expression_browser.cjs`，使用合成接口响应验证启停、七类分数、缺失/过期与刷新，确认画布未被改变，不连接设备。

2026-10-31 本机摄像头编号 0 的短时检查：表情任务实际中位频率约 4.93 Hz，检测耗时中位数约 10.4 ms；眼部识别开启前后约 9.96/9.98 Hz，眼部处理帧龄中位数约 8.0/9.1 ms。摄像头取图约 10 Hz，预览请求约 18.9 次/秒（后者不代表独立画面帧数）。本次未检测到单张完整人脸，因此这些是取流/人脸检测分支性能，不能当作完整脸部分类型推理性能或准确率证据。模型分类网络另已用人工输入验证可执行及输出七个 logits；真人表情效果仍需完整脸部入镜检查。

`examples/expression.synthetic.json` 是纯合成的接口示例，不是设备采样，也不会注入主程序或改变作品样例。
