import threading
import time
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
        self.raw = None
        self.rois = {'image_left': None, 'image_right': None}
        self.roi_version = 0
        self.frame_id = 0
        self.camera_info = {}
        self.metrics = {}
        self.jpeg_lock = threading.Lock()
        self.jpeg_key = None
        self.jpeg = None
        self.capture_error = None

    def set_roi(self, roi, side):
        with self.lock:
            if side == 'both':
                self.rois = {'image_left': None, 'image_right': None}
            else:
                self.rois[side] = roi
            self.roi_version += 1
        self.recorder.emit('event', {'kind': 'camera_roi_changed', 'side': side, 'roi': roi})

    def _capture(self, cap):
        failures, previous = 0, None
        try:
            while not self.stop_event.is_set():
                begin = time.monotonic_ns()
                ok, frame = cap.read()
                clock = stamp()
                if not ok:
                    failures += 1
                    if failures >= 10:
                        raise RuntimeError('连续读取画面失败，请重新连接摄像头')
                    self.stop_event.wait(.05)
                    continue
                failures = 0
                now = clock['host_monotonic_ns']
                with self.lock:
                    self.frame_id += 1
                    self.raw = (frame, self.frame_id, clock)
                    self.metrics['capture_ms'] = (now - begin) / 1e6
                    self.metrics['capture_hz'] = 1e9 / (now - previous) if previous and now > previous else None
                previous = now
        except Exception as exc:
            self.capture_error = exc
            self.stop_event.set()
        finally:
            cap.release()

    def preview_jpeg(self):
        # Serialize encoding across browsers; never hold the frame lock while encoding.
        with self.jpeg_lock:
            with self.lock:
                raw, latest, version = self.raw, self.latest, self.roi_version
            if raw is None:
                return None
            frame, frame_id, clock = raw
            age = (time.monotonic_ns() - clock['host_monotonic_ns']) / 1e9
            if age > 1 or self.stop_event.is_set():
                return None
            if self.jpeg_key == frame_id:
                return self.jpeg
            begin = time.monotonic_ns()
            frame = frame.copy()
            sample = latest[1] if latest else None
            # Overlay only recent results from the current ROI configuration.
            if (sample and sample['roi_version'] == version
                    and 0 <= clock['host_monotonic_ns'] - latest[2]['host_monotonic_ns'] < 150_000_000):
                for side, eye in sample['eyes'].items():
                    color = (0, 210, 255) if side == 'image_left' else (255, 190, 70)
                    if eye['roi']:
                        x, y, w, h = eye['roi']
                        cv2.rectangle(frame, (x, y), (x+w, y+h), color, 2)
                        cv2.putText(frame, 'IMG-L' if side == 'image_left' else 'IMG-R', (x, max(18, y-5)), cv2.FONT_HERSHEY_SIMPLEX, .5, color, 1)
                    if eye['candidate_center_px']:
                        center = tuple(round(v) for v in eye['candidate_center_px'])
                        a, b, angle = eye['candidate_ellipse_px']
                        cv2.ellipse(frame, center, (max(1, round(a/2)), max(1, round(b/2))), angle, 0, 360, (70, 255, 70), 1)
            ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                return None
            self.jpeg = encoded.tobytes()
            self.jpeg_key = frame_id
            with self.lock:
                self.metrics['encode_ms'] = (time.monotonic_ns() - begin) / 1e6
            return self.jpeg

    def run(self):
        cap, capture = None, None
        try:
            cap = cv2.VideoCapture(self.index, self.backend)
            if not cap.isOpened():
                raise RuntimeError('无法打开，请检查摄像头编号、占用情况和 Windows 相机权限')
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            self.camera_info = {'index': self.index, 'backend': cap.getBackendName(),
                'width': int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), 'height': int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                'reported_fps': cap.get(cv2.CAP_PROP_FPS)}
            self.status('camera', '摄像头已打开；连续预览与双眼识别独立运行')
            self.recorder.emit('event', {'kind': 'camera_opened', **self.camera_info})
            capture = threading.Thread(target=self._capture, args=(cap,), daemon=True)
            capture.start()
            detector = PupilDetector()
            due, previous, processed = 0, None, -1
            while not self.stop_event.is_set():
                wait = due - time.monotonic()
                if wait > 0:
                    self.stop_event.wait(wait)
                    continue
                with self.lock:
                    raw, rois, version = self.raw, dict(self.rois), self.roi_version
                if raw is None or raw[1] == processed:
                    self.stop_event.wait(.002)
                    continue
                frame, frame_id, clock = raw
                processed = frame_id
                begin = time.monotonic_ns()
                due = begin / 1e9 + 1 / self.rate
                sample = detector.measure_pair(frame, rois)
                end = time.monotonic_ns()
                sample.update(frame_id=frame_id, frame_width=frame.shape[1], frame_height=frame.shape[0],
                    roi_version=version, processing_ms=(end-begin)/1e6,
                    frame_age_ms=(end-clock['host_monotonic_ns'])/1e6,
                    observed_interval_ms=None if previous is None else (begin-previous)/1e6, frame_path=None)
                previous = begin
                with self.recorder.lock:
                    if self.recorder.active:
                        if self.save_frames and (self.recorder.deadline_ns is None or clock['host_monotonic_ns'] < self.recorder.deadline_ns):
                            sample['frame_path'] = self.recorder.save_frame(frame, frame_id)
                        self.recorder.emit('camera', sample, clock)
                with self.lock:
                    self.latest = (frame, sample, clock)
                    self.metrics.update(processing_ms=sample['processing_ms'], frame_age_ms=sample['frame_age_ms'],
                        processing_hz=1000/sample['observed_interval_ms'] if sample['observed_interval_ms'] else None)
                if self.on_sample:
                    self.on_sample(sample, clock)
            if self.capture_error:
                raise self.capture_error
        except Exception as exc:
            self.status('camera', '摄像头错误：' + str(exc))
            self.recorder.emit('event', {'kind': 'camera_error', 'error': str(exc)})
        finally:
            self.stop_event.set()
            # Reader owns cap.release(); do not race release against cap.read().
            if capture:
                capture.join()
            elif cap is not None:
                cap.release()
            self.recorder.emit('event', {'kind': 'camera_closed'})
