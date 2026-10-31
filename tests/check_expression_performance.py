"""Optional real-camera CPU comparison; no frames or sensor records are saved."""
import argparse
import json
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / '.deps'))
import cv2
from acquisition.camera import CameraWorker
from acquisition.core import Recorder
from acquisition.expression import ExpressionWorker
from acquisition.interfaces import SamplePublisher
from acquisition.live import LiveTrace


def median(values):
    return statistics.median(values) if values else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--index', type=int, default=0)
    parser.add_argument('--seconds', type=float, default=5)
    args = parser.parse_args()
    if args.seconds < 1:
        parser.error('--seconds must be >= 1')
    rows, messages = [], []
    rec, trace = Recorder(), LiveTrace()
    camera = CameraWorker(args.index, cv2.CAP_DSHOW, 20, rec, lambda *x: messages.append(x), False,
                          lambda sample, clock: rows.append(sample))
    expression = None

    def phase():
        rows.clear()
        ages, capture, previews = [], [], 0
        begin = time.monotonic()
        while time.monotonic() - begin < args.seconds:
            if not camera.is_alive():
                raise RuntimeError('Camera stopped: ' + str(messages))
            if camera.preview_jpeg(): previews += 1
            with camera.lock:
                metrics = dict(camera.metrics)
            if metrics.get('capture_hz'): capture.append(metrics['capture_hz'])
            if metrics.get('frame_age_ms') is not None: ages.append(metrics['frame_age_ms'])
            time.sleep(.05)
        elapsed = time.monotonic() - begin
        intervals = [r['observed_interval_ms'] for r in rows if r['observed_interval_ms']]
        return {'camera_samples': len(rows), 'eye_hz': 1000/statistics.mean(intervals) if intervals else None,
                'capture_hz_median': median(capture), 'eye_frame_age_ms_median': median(ages),
                'preview_requests_per_s': previews/elapsed}

    try:
        camera.start()
        deadline = time.monotonic() + 10
        while not rows and camera.is_alive() and time.monotonic() < deadline: time.sleep(.05)
        if not rows:
            raise RuntimeError('No camera data: ' + str(messages))
        time.sleep(1)
        baseline = phase()
        expression = ExpressionWorker(camera, SamplePublisher(rec, trace), 5)
        expression.start()
        deadline = time.monotonic() + 10
        while not expression.snapshot()['fresh'] and expression.is_alive() and time.monotonic() < deadline:
            time.sleep(.05)
        if not expression.snapshot()['fresh']:
            raise RuntimeError('Expression unavailable: ' + str(expression.snapshot()))
        cursor = trace.snapshot()['cursor']
        enabled = phase()
        samples = [r['data'] for r in trace.snapshot(cursor)['rows'] if r['source'] == 'expression']
        enabled.update(expression_samples=len(samples),
                       expression_hz_median=median([s['observed_hz'] for s in samples if s['observed_hz']]),
                       expression_ms_median=median([s['processing_ms'] for s in samples]),
                       expression_frame_age_ms_median=median([s['frame_age_ms'] for s in samples]),
                       single_face_samples=sum(s['face_count'] == 1 for s in samples))
        print(json.dumps({'baseline': baseline, 'expression_enabled': enabled}, indent=2))
    finally:
        if expression:
            expression.stop(); expression.join(5)
        camera.stop_event.set(); camera.join(5)
        print('Camera released:', not camera.is_alive())


if __name__ == '__main__':
    main()
