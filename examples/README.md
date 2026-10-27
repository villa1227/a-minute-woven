# 模拟作品

`artwork.synthetic.json` 是完全合成的完成作品，包含 12 个时间段。数值、样本数量和日期均用于演示，不来自任何参与者或设备，不能用于评价采集性能或生理结论。

1. 下载或克隆整个仓库，双击 `web/render-artwork.html`。
2. 选择本目录的 `artwork.synthetic.json`，查看预览并下载 2400 × 3200 PNG，无需运行 Python 或连接设备。
3. 自己编写绘图代码时，读取同一文件的 `bands`，按 [接口文档](../docs/interfaces.md) 绘制；也可直接调用 `Weave.draw`。

样例有意包含双眼不同的变化、心率密度变化、单眼缺失、心率缺失，以及第 10 段全部缺失时的基础织纹，便于检查各种显示状态。作品编号和种子固定，重绘构图一致。

修改样例可编辑 `generate_demo.py` 中的窗口值，然后在仓库根目录运行 `python examples/generate_demo.py`。这只生成示例参数，不启动服务、不注入实时采集、不产生原始记录；`counts` 也是示意数，不代表实际采样。
