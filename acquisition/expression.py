"""Local expression classification; isolated from pupil and artwork processing.

Preprocessing follows OpenCV Zoo Progressive Teacher (Apache-2.0); see
docs/expression.md and third_party/opencv_zoo for attribution and licenses.
"""
import copy
import hashlib
import json
from pathlib import Path
import threading
import time

import cv2
import numpy as np
from .core import stamp

LABELS = ('angry', 'disgust', 'fearful', 'happy', 'neutral', 'sad', 'surprised')
MODEL_DIR = Path(__file__).resolve().parents[1] / 'models' / 'expression'
MODEL_ID = 'opencv-zoo-mobilefacenet-2022july'
ALIGN_POINTS = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                         [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float64)


def model_metadata(folder=MODEL_DIR):
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    return {'id': MODEL_ID, 'revision': manifest['revision'], 'labels': list(LABELS),
            'models': [{k: model[k] for k in ('file', 'sha256', 'license')} for model in manifest['models']]}


def verify_models(folder=MODEL_DIR):
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    for model in manifest['models']:
        path = folder / model['file']
        if not path.is_file() or path.stat().st_size != model['size'] or hashlib.sha256(path.read_bytes()).hexdigest() != model['sha256']:
            raise RuntimeError('表情模型缺失或校验失败，请运行 python scripts/download_expression_models.py')
    return manifest


def aligned_blob(frame, landmarks):
    """Deterministic, non-reflective least-squares similarity to Zoo's 112² face."""
    points = np.asarray(landmarks, dtype=np.float64).reshape(5, 2)
    if not np.isfinite(points).all():
        raise ValueError('Invalid landmarks')
    # Zoo fits the inverse (template -> observed landmarks), then inverts it.
    x, y = ALIGN_POINTS[:, 0], ALIGN_POINTS[:, 1]
    # u = a*x - b*y + tx; v = b*x + a*y + ty.
    matrix = np.zeros((10, 4), dtype=np.float64)
    matrix[0::2] = np.column_stack((x, -y, np.ones(5), np.zeros(5)))
    matrix[1::2] = np.column_stack((y, x, np.zeros(5), np.ones(5)))
    solution, _, rank, _ = np.linalg.lstsq(matrix, points.reshape(-1), rcond=None)
    if rank < 4:
        raise ValueError('Degenerate landmarks')
    a, b, tx, ty = solution
    transform = np.array([[a, -b, tx], [b, a, ty], [0, 0, 1]])
    if abs(np.linalg.det(transform)) < 1e-12:
        raise ValueError('Degenerate landmarks')
    image = cv2.warpAffine(frame, np.linalg.inv(transform)[:2], (112, 112))
    image = (cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0 - .5) / .5
    return cv2.dnn.blobFromImage(image)


def expression_scores(logits):
    values = np.asarray(logits, dtype=np.float64).reshape(-1)
    if values.size != 7 or not np.isfinite(values).all():
        raise ValueError('Expected seven finite expression logits')
    weights = np.exp(values - values.max())
    return dict(zip(LABELS, (weights / weights.sum()).tolist()))


class ExpressionModel:
    def __init__(self, folder=MODEL_DIR):
        manifest = verify_models(folder)
        # Buffer APIs avoid OpenCV's Windows non-ASCII filename limitation.
        face_bytes = np.frombuffer((folder / manifest['models'][0]['file']).read_bytes(), dtype=np.uint8)
        self.face = cv2.FaceDetectorYN.create('onnx', face_bytes, np.array([], dtype=np.uint8),
                                             (320, 320), .9, .3, 5000)
        self.net = cv2.dnn.readNetFromONNX(np.frombuffer((folder / manifest['models'][1]['file']).read_bytes(), dtype=np.uint8))
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)

    def infer(self, frame):
        h, w = frame.shape[:2]
        scale = min(1.0, 640 / max(h, w))
        size = (max(1, round(w * scale)), max(1, round(h * scale)))
        image = cv2.resize(frame, size) if size != (w, h) else frame
        self.face.setInputSize(size)
        _, faces = self.face.detect(image)
        count = 0 if faces is None else len(faces)
        result = {'quality': 'no_face' if count == 0 else 'multiple_faces' if count > 1 else 'classified_unvalidated',
                  'face_count': count, 'face_box': None, 'face_score': None, 'scores': None, 'label': None}
        if count == 1:
            face = faces[0]
            # Scale landmarks and bbox to the original frame, preserving exact rounded resize factors.
            ratio = np.array([w / size[0], h / size[1]])
            points = face[4:14].reshape(5, 2) * ratio
            self.net.setInput(aligned_blob(frame, points), 'data')
            scores = expression_scores(self.net.forward('label'))
            result.update(face_box=(face[:4] * np.tile(ratio, 2)).astype(float).tolist(),
                          face_score=float(face[-1]), scores=scores, label=max(scores, key=scores.get))
        return result


class ExpressionWorker(threading.Thread):
    def __init__(self, camera, publisher, rate=5, model_factory=ExpressionModel):
        super().__init__(daemon=True)
        self.camera, self.publisher, self.rate, self.model_factory = camera, publisher, rate, model_factory
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.state = 'loading'
        self.error = None
        self.model_info = model_metadata()

    def stop(self):
        self.stop_event.set()
        with self.lock:
            self.latest = None
            self.state = 'stopped'

    def snapshot(self):
        with self.lock:
            latest = copy.deepcopy(self.latest)
            age = (time.monotonic_ns() - latest[1]['host_monotonic_ns']) / 1e9 if latest else None
            running = self.is_alive() and not self.stop_event.is_set()
            fresh = bool(running and latest and 0 <= age <= 1)
            return {'running': running, 'state': self.state, 'error': self.error, 'target_hz': self.rate,
                    'fresh': fresh, 'age_s': age, 'sample': latest[0] if latest else None,
                    'model': self.model_info}

    def run(self):
        try:
            model = self.model_factory()
            with self.lock:
                self.state = 'running'
            previous, processed, due = None, -1, 0
            while not self.stop_event.is_set():
                if self.camera.stop_event.is_set() or not self.camera.is_alive():
                    break
                if self.stop_event.wait(max(0, due - time.monotonic())):
                    break
                with self.camera.lock:
                    raw = self.camera.raw
                if raw is None or raw[1] == processed or time.monotonic_ns() - raw[2]['host_monotonic_ns'] > 1_000_000_000:
                    self.stop_event.wait(.01)
                    continue
                frame, frame_id, clock = raw
                processed = frame_id
                begin = time.monotonic_ns()
                due = begin / 1e9 + 1 / self.rate
                sample = model.infer(frame)
                completed = stamp()
                sample.update(frame_id=frame_id, frame_width=frame.shape[1], frame_height=frame.shape[0],
                              model_id=MODEL_ID, processing_ms=(completed['host_monotonic_ns']-begin)/1e6,
                              frame_age_ms=(completed['host_monotonic_ns']-clock['host_monotonic_ns'])/1e6,
                              completed_monotonic_ns=completed['host_monotonic_ns'], completed_utc=completed['host_utc'],
                              observed_hz=None if previous is None else 1e9/(begin-previous))
                previous = begin
                with self.lock:
                    if self.stop_event.is_set() or self.camera.stop_event.is_set():
                        break
                    self.publisher.publish('expression', sample, clock)
                    self.latest = (sample, clock)
        except Exception as exc:
            with self.lock:
                self.state, self.error = 'error', str(exc)
        finally:
            self.stop_event.set()
            with self.lock:
                self.latest = None
                if self.state != 'error':
                    self.state = 'stopped'


def idle_state():
    return {'running': False, 'state': 'stopped', 'error': None, 'target_hz': 5,
            'fresh': False, 'age_s': None, 'sample': None, 'model': model_metadata()}
