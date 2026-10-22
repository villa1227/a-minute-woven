import threading
import cv2
from .core import stamp
from .eye import PupilDetector

class CameraWorker(threading.Thread):
    def __init__(self, index, backend, rate, recorder, status, save_frames, on_sample=None):
        super().__init__(daemon=True)
        self.index, self.backend, self.rate = index, backend, rate
        self.recorder, self.status, self.save_frames = recorder, status, save_frames
        self.on_sample = on_sample
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.rois = {"image_left": None, "image_right": None}
        self.frame_id = 0
        self.camera_info = {}

    def set_roi(self, roi, side):
        with self.lock:
            if side == "both":
                self.rois = {"image_left": None, "image_right": None}
            else:
                self.rois[side] = roi
        self.recorder.emit("event", {"kind": "camera_roi_changed", "side": side, "roi": roi})

    def run(self):
        cap = None
        try:
            cap = cv2.VideoCapture(self.index, self.backend)
            if not cap.isOpened():
                raise RuntimeError("无法打开，请检查摄像头编号、占用情况和 Windows 相机权限")
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            self.camera_info = {"index": self.index, "backend": cap.getBackendName(),
                "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                "reported_fps": cap.get(cv2.CAP_PROP_FPS)}
            self.status("camera", "摄像头已打开；双眼分别采集，可选择画面左/右眼区后拖动框选")
            self.recorder.emit("event", {"kind": "camera_opened", **self.camera_info})
            detector = PupilDetector()
            due = 0.0
            previous = None
            failures = 0
            while not self.stop_event.is_set():
                ok, frame = cap.read()
                clock = stamp()
                if not ok:
                    failures += 1
                    if failures >= 10:
                        raise RuntimeError("连续读取画面失败，请重新连接摄像头")
                    self.stop_event.wait(0.05)
                    continue
                failures = 0
                now = clock["host_monotonic_ns"] / 1e9
                if now < due:
                    continue
                due = now + 1 / self.rate
                with self.lock:
                    rois = dict(self.rois)
                sample = detector.measure_pair(frame, rois)
                sample.update(frame_id=self.frame_id,
                    frame_width=frame.shape[1], frame_height=frame.shape[0],
                    observed_interval_ms=None if previous is None else (now-previous)*1000,
                    frame_path=None)
                previous = now
                with self.recorder.lock:
                    if self.recorder.active:
                        if self.save_frames:
                            sample["frame_path"] = self.recorder.save_frame(frame, self.frame_id)
                        self.recorder.emit("camera", sample, clock)
                with self.lock:
                    self.latest = (frame, sample, clock)
                if self.on_sample:
                    self.on_sample(sample, clock)
                self.frame_id += 1
        except Exception as exc:
            self.status("camera", "摄像头错误：" + str(exc))
            self.recorder.emit("event", {"kind": "camera_error", "error": str(exc)})
        finally:
            if cap is not None:
                cap.release()
            self.recorder.emit("event", {"kind": "camera_closed"})


