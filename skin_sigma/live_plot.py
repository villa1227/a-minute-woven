"""Grove GSR 实时导电性曲线。

在现有采集服务 gsr.GsrService 之上加一层 matplotlib 实时绘图：
- 打开 COM 串口（默认 COM6，115200），由 GsrService 后台线程持续收数；
- 每帧轮询 snapshot(after=cursor) 增量取回新样本；
- 绘制「原始 ADC」与「1 s 滑动平均」两条曲线，时间轴滚动显示最近 window 秒。

用法：
    python live_plot.py                  # COM6
    python live_plot.py --port COM4 --window 30

依赖：pyserial、numpy、matplotlib（见 requirements.txt）。
"""
import argparse
from collections import deque

import matplotlib
import matplotlib.pyplot as plt
import numpy as np

from gsr import GsrService

# 参考配色（dataviz 默认浅色面）：单一指标用同一个蓝色系，原始=浅阶、平滑=深阶。
SURFACE = "#fcfcfb"
INK_PRIMARY = "#0b0b0b"
INK_SECONDARY = "#52514e"
MUTED = "#898781"
GRIDLINE = "#e1e0d9"
BASELINE = "#c3c2b7"
RAW_LINE = "#9ec5f4"      # 蓝 200
SMOOTH_LINE = "#2a78d6"   # 蓝 slot 1


def trailing_mean(a, n):
    """因果滑动平均（只用当前及过去 n-1 个点），首段窗口自动收缩，无边缘凹陷。"""
    a = np.asarray(a, dtype=float)
    out = np.empty_like(a)
    s = 0.0
    for i, x in enumerate(a):
        s += x
        if i >= n:
            s -= a[i - n]
        out[i] = s / min(i + 1, n)
    return out


class LiveGsrPlot:
    def __init__(self, port, window, smooth_samples):
        self.window = float(window)
        self.smooth_samples = int(smooth_samples)
        self.t0_ns = None
        self.cursor = 0
        self.t = deque()
        self.adc = deque()

        self.service = GsrService(root=".")
        self.service.connect(port)

        matplotlib.rcParams.update({
            "font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
            "axes.unicode_minus": False,
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "axes.edgecolor": BASELINE,
            "axes.labelcolor": INK_SECONDARY,
            "text.color": INK_PRIMARY,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "grid.color": GRIDLINE,
            "grid.linewidth": 0.6,
        })
        self.fig, self.ax = plt.subplots(figsize=(11, 5))
        self.fig.canvas.manager.set_window_title("皮肤导电性 (GSR) 实时曲线")
        (self.raw_line,) = self.ax.plot([], [], color=RAW_LINE, linewidth=1.0,
                                        alpha=0.35, label="原始 ADC")
        (self.smooth_line,) = self.ax.plot([], [], color=SMOOTH_LINE,
                                           linewidth=2.0, label="1 s 平滑")
        self.ax.set_xlabel("时间 (s)")
        self.ax.set_ylabel("导电性 ADC (0–1023)")
        self.ax.grid(True, which="both", linestyle="-", linewidth=0.6, alpha=0.6)
        self.ax.set_ylim(-5, 1023)
        self.ax.legend(loc="upper right", frameon=False)
        self.readout = self.ax.text(0.01, 0.97, "", transform=self.ax.transAxes,
                                    va="top", ha="left", fontsize=9,
                                    color=INK_SECONDARY,
                                    bbox=dict(boxstyle="round,pad=0.35",
                                              facecolor=SURFACE, edgecolor=GRIDLINE,
                                              alpha=0.9))
        plt.tight_layout()

    def _update(self):
        snap = self.service.snapshot(after=self.cursor)
        self.cursor = snap["cursor"]
        for r in snap["rows"]:
            if r.get("kind") == "sample" and r.get("adc") is not None:
                if self.t0_ns is None:
                    self.t0_ns = r["host_monotonic_ns"]
                self.t.append((r["host_monotonic_ns"] - self.t0_ns) / 1e9)
                self.adc.append(r["adc"])

        # 丢弃窗口外的旧点。
        if self.t:
            cutoff = self.t[-1] - self.window
            while self.t and self.t[0] < cutoff:
                self.t.popleft()
                self.adc.popleft()

        x = np.asarray(self.t)
        y = np.asarray(self.adc, dtype=float)
        self.raw_line.set_data(x, y)

        smoothed = trailing_mean(y, self.smooth_samples) if len(y) else np.empty(0)
        self.smooth_line.set_data(x, smoothed)

        if len(x):
            right = max(self.window, x[-1])
            self.ax.set_xlim(right - self.window, right)
            lo, hi = float(y.min()), float(y.max())
            pad = max(20.0, (hi - lo) * 0.1)
            self.ax.set_ylim(lo - pad, hi + pad)
            latest = int(y[-1])
            smooth_latest = f"{smoothed[-1]:.1f}" if len(smoothed) else "—"
        else:
            latest, smooth_latest = None, "—"

        if latest is None:
            readout = f"状态：{snap['status']}\n等待连续皮电数据…"
        else:
            touch = "" if latest > 5 else "\n注意：未检测到手指接触（ADC~0）"
            rate = snap.get("rate_hz")
            rate_txt = f"{rate:.1f}" if rate else "—"
            readout = (
                f"状态：{snap['status']}\n"
                f"最新 ADC：{latest}   平滑：{smooth_latest}\n"
                f"采样率：{rate_txt} Hz   样本：{snap['stats']['samples']}"
                f"{touch}"
            )
        self.readout.set_text(readout)
        self.ax.set_title("皮肤导电性 (GSR) 实时曲线", loc="left",
                          color=INK_PRIMARY, fontsize=13)

    def run(self):
        try:
            while plt.fignum_exists(self.fig.number):
                self._update()
                self.fig.canvas.draw_idle()
                plt.pause(0.05)
        except KeyboardInterrupt:
            pass
        finally:
            self.service.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Grove GSR 实时导电性曲线")
    parser.add_argument("--port", default="COM6", help="串口（默认 COM6）")
    parser.add_argument("--window", type=float, default=60.0,
                        help="滚动窗口秒数（默认 60，采集服务仅保留最近 60 s）")
    parser.add_argument("--smooth", type=int, default=21,
                        help="滑动平均点数（20 Hz 下默认 21 ≈ 1 s）")
    args = parser.parse_args(argv)

    plot = LiveGsrPlot(args.port, args.window, args.smooth)
    plot.run()


if __name__ == "__main__":
    main()
