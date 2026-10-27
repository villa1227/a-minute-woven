"""Optional local hardware comparison; no images are saved. Run with --index N."""
import argparse
import json
import statistics
import subprocess
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / '.deps'))
import cv2
from acquisition.camera import CameraWorker
from acquisition.core import Recorder


def baseline():
    eye = types.ModuleType('old_eye')
    exec(subprocess.check_output(['git', 'show', 'backup/gsr-before-smooth-render:acquisition/eye.py'], cwd=ROOT).decode(), eye.__dict__)
    module = types.ModuleType('acquisition.old_camera')
    module.__package__ = 'acquisition'
    source = subprocess.check_output(['git', 'show', 'backup/gsr-before-smooth-render:acquisition/camera.py'], cwd=ROOT).decode()
    source = source.replace('from .eye import PupilDetector', '')
    module.PupilDetector = eye.PupilDetector
    exec(source, module.__dict__)
    return module.CameraWorker


def check(cls, index, rate):
    rows, messages, ages = [], [], []
    worker = cls(index, cv2.CAP_DSHOW, rate, Recorder(), lambda *args: messages.append(args), False,
                 lambda sample, clock: rows.append(sample))
    worker.start()
    deadline = time.monotonic() + 8
    previews = 0
    try:
        while time.monotonic() < deadline and worker.is_alive():
            if hasattr(worker, 'preview_jpeg') and worker.preview_jpeg(): previews += 1
            with worker.lock:
                if worker.latest: ages.append((time.monotonic_ns()-worker.latest[2]['host_monotonic_ns'])/1e6)
            time.sleep(.05 if rate == 20 else .4)
    finally:
        worker.stop_event.set(); worker.join(timeout=5)
    intervals = [r['observed_interval_ms'] for r in rows if r['observed_interval_ms']]
    return {'target_hz':rate, 'samples':len(rows), 'observed_hz':1000/statistics.mean(intervals) if intervals else None,
            'median_latest_age_ms':statistics.median(ages) if ages else None,
            'preview_requests_succeeded':previews, 'metrics':getattr(worker, 'metrics', {}),
            'stopped':not worker.is_alive(), 'messages':messages}


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--index',type=int,default=0)
    args=parser.parse_args()
    print(json.dumps({'baseline':check(baseline(),args.index,10)},ensure_ascii=True),flush=True)
    print(json.dumps({'updated':check(CameraWorker,args.index,20)},ensure_ascii=True),flush=True)
