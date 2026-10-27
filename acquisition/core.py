import csv
import json
import threading
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def stamp():
    # Both values describe host receipt/processing, not device acquisition time.
    return {"host_monotonic_ns": time.monotonic_ns(),
            "host_utc": datetime.now(timezone.utc).isoformat(timespec="microseconds")}


class Recorder:
    """One common clock/schema for camera, BLE, markers and future EDA."""
    def __init__(self, on_sample=None):
        self.lock = threading.RLock()
        self.active = False
        self.path = None
        self.on_sample = on_sample

    def start(self, root, settings):
        with self.lock:
            if self.active:
                raise RuntimeError("Already recording")
            now = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.path = Path(root) / (now + "_" + uuid.uuid4().hex[:6])
            self.path.mkdir(parents=True)
            self.origin = time.monotonic_ns()
            self.counts = Counter()
            self.seq = 0
            self.meta = {"schema_version": 2, "settings": settings,
                         "started_utc": stamp()["host_utc"],
                         "clock": "host monotonic nanoseconds; host timestamps are not sensor timestamps",
                         "pupil_algorithm": "dark-contour-binocular-v2; separate image-left/right unvalidated candidates, pixels only"}
            self.meta_file = self.path / "metadata.json"
            self.meta_file.write_text(json.dumps(self.meta, ensure_ascii=False, indent=2), encoding="utf-8")
            self.handle = (self.path / "samples.jsonl").open("w", encoding="utf-8")
            self.csv_files = {}
            self.csv_writers = {}
            self.active = True
            self.emit("event", {"kind": "recording_started"})
            return self.path

    def emit(self, source, data, clock=None):
        with self.lock:
            if not self.active:
                return
            clock = clock or stamp()
            # Drop samples captured before this session, e.g. queued BLE callbacks.
            if clock["host_monotonic_ns"] < self.origin:
                return
            row = {"seq": self.seq, "source": source, **clock,
                   "session_s": (clock["host_monotonic_ns"] - self.origin) / 1e9,
                   "data": data}
            self.handle.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
            self.handle.flush()
            self.seq += 1
            self.counts[source] += 1
            # CSV is a convenience view. JSONL retains nested/raw values.
            if source in ("camera", "heart_rate", "eda"):
                flat = {k: row[k] for k in ("seq", "host_monotonic_ns", "host_utc", "session_s")}
                flat.update({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v
                             for k, v in data.items()})
                if source not in self.csv_files:
                    f = (self.path / (source + ".csv")).open("w", newline="", encoding="utf-8-sig")
                    self.csv_files[source] = f
                    self.csv_writers[source] = csv.DictWriter(f, fieldnames=list(flat))
                    self.csv_writers[source].writeheader()
                self.csv_writers[source].writerow(flat)
                self.csv_files[source].flush()
            if self.on_sample and source in ('camera', 'heart_rate'):
                self.on_sample(row)

    def save_frame(self, frame, frame_id):
        import cv2
        with self.lock:
            if not self.active:
                return None
            folder = self.path / "frames"
            folder.mkdir(exist_ok=True)
            relative = "frames/%09d.jpg" % frame_id
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
            if not ok:
                raise OSError("JPEG encoding failed")
            encoded.tofile(str(self.path / relative))
            return relative

    def stop(self):
        with self.lock:
            if not self.active:
                return self.path
            self.emit("event", {"kind": "recording_stopped"})
            self.active = False
            self.handle.close()
            for f in self.csv_files.values():
                f.close()
            self.meta.update(ended_utc=stamp()["host_utc"], counts=dict(self.counts))
            self.meta_file.write_text(json.dumps(self.meta, ensure_ascii=False, indent=2), encoding="utf-8")
            return self.path
