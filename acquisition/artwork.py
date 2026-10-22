"""A fixed, host-clock artwork session fed by the actual recorded samples."""
import copy
import json
import math
import threading
import time
import uuid
from datetime import datetime
from statistics import median
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def valid_eye(eye):
    return bool(eye and eye.get('quality') == 'candidate_unvalidated'
                and positive(eye.get('candidate_diameter_px')))


def valid_heart(sample):
    return bool(sample and positive(sample.get('bpm')) and sample.get('contact_detected') is not False
                and sample.get('quality') not in ('contact_lost', 'zero_bpm'))


class ArtworkSession:
    duration_s = 60
    interval_s = 5
    band_count = 12
    # A neutral warp is always present so every participant gets a complete
    # composition, even when no sensor channel yields a valid sample.
    base_threads = 22

    def __init__(self, recorder, clock=time.monotonic_ns, start_timer=True):
        self.recorder = recorder
        self.clock = clock
        self.start_timer = start_timer
        self.lock = threading.RLock()
        self.status = 'idle'
        self.artwork_id = None
        self.bands = []
        self.error = None
        self.path = None
        self.elapsed_s = 0
        self.stop_event = threading.Event()
        self.thread = None
        recorder.on_sample = self.on_sample

    @property
    def active(self):
        with self.lock:
            return self.status == 'running'

    def start(self, root, settings):
        # Global order: recorder -> artwork. The recorder invokes on_sample in this order too.
        with self.recorder.lock, self.lock:
            if self.status == 'running' or self.recorder.active:
                raise ValueError('已有创作或记录正在进行，请先结束')
            path = self.recorder.start(root, {**settings, 'artwork': {
                'renderer': 'woven-v1', 'duration_s': 60, 'interval_s': 5}})
            self.origin = self.recorder.origin
            self.path = path / 'artwork.json'
            self.artwork_id = uuid.uuid4().hex[:12]
            try:
                self.created_at = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
            except ZoneInfoNotFoundError:
                from datetime import timedelta, timezone
                self.created_at = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds')
            self.bands = []
            self.buckets = [{key: [] for key in ('left', 'right', 'heart')} for _ in range(12)]
            self.references = dict.fromkeys(('left', 'right', 'heart'))
            self.late_samples = 0
            self.elapsed_s = 0
            self.error = None
            self.status = 'running'
            self.stop_event = threading.Event()
            try:
                self._save()
            except Exception:
                self.status = 'error'
                self.error = '无法保存作品参数，请检查磁盘空间和文件权限'
                self.recorder.stop()
                raise
            if self.start_timer:
                self.thread = threading.Thread(target=self._run, args=(self.artwork_id, self.stop_event), daemon=True)
                self.thread.start()
            return self.snapshot()

    def on_sample(self, row):
        with self.lock:
            if self.status != 'running':
                return
            elapsed_ns = row['host_monotonic_ns'] - self.origin
            if not 0 <= elapsed_ns < 60_000_000_000:
                return
            index = elapsed_ns // 5_000_000_000
            if index < len(self.bands):
                # Keep the raw record, but do not revise a published part of the artwork.
                self.late_samples += 1
                return
            bucket = self.buckets[index]
            if row['source'] == 'camera':
                for side, key in (('image_left', 'left'), ('image_right', 'right')):
                    eye = row['data'].get('eyes', {}).get(side)
                    if valid_eye(eye):
                        bucket[key].append(eye['candidate_diameter_px'])
            elif row['source'] == 'heart_rate' and valid_heart(row['data']):
                bucket['heart'].append(row['data']['bpm'])

    def _band_parameters(self, index, bucket, update_reference):
        values = {key: median(samples) if samples else None for key, samples in bucket.items()}
        references = self.references
        for key, value in values.items():
            if update_reference and value is not None and references[key] is None:
                references[key] = value
        amplitudes = {}
        for key in ('left', 'right'):
            value, reference = values[key], references[key]
            if not update_reference and reference is None and bucket[key]:
                reference = bucket[key][0]
            change = max(-.3, min(.3, value / reference - 1)) if value is not None else None
            amplitudes[key] = None if change is None else .08 + (change + .3) / .6 * .16
        hr = values['heart']
        heart_reference = references['heart']
        if not update_reference and heart_reference is None and bucket['heart']:
            heart_reference = bucket['heart'][0]
        delta = max(-20, min(20, hr - heart_reference)) if hr is not None and heart_reference else None
        threads = self.base_threads if delta is None else int(math.floor(16 + (delta + 20) / 40 * 24 + .5))
        return {'index': index, 'start_s': index * 5, 'end_s': (index + 1) * 5,
                'seed': self.artwork_id + ':' + str(index), 'values': values,
                'counts': {key: len(samples) for key, samples in bucket.items()},
                'amplitude': amplitudes, 'threads': threads,
                'base_threads': self.base_threads,
                'aggregation': 'median over the 5-second window',
                'empty': all(value is None for value in values.values())}

    def _finalize_band(self, index):
        bucket = self.buckets[index]
        self.bands.append(self._band_parameters(index, bucket, update_reference=True))
        self.buckets[index] = {key: [] for key in bucket}

    def _preview_band(self):
        if self.status != 'running' or len(self.bands) >= self.band_count:
            return None
        band = self._band_parameters(len(self.bands), self.buckets[len(self.bands)], update_reference=False)
        band['preview'] = True
        return band

    def tick(self, now_ns=None, expected_id=None):
        with self.recorder.lock, self.lock:
            if self.status != 'running' or expected_id and expected_id != self.artwork_id:
                return
            elapsed_ns = max(0, (self.clock() if now_ns is None else now_ns) - self.origin)
            self.elapsed_s = min(60, elapsed_ns / 1e9)
            target = min(12, elapsed_ns // 5_000_000_000)
            changed = target > len(self.bands)
            while len(self.bands) < target:
                self._finalize_band(len(self.bands))
            if target == 12:
                self.recorder.stop()
                self.status = 'completed'
                self.stop_event.set()
            if changed:
                self._save()

    def _run(self, expected_id, stop_event):
        while not stop_event.wait(.1):
            try:
                self.tick(expected_id=expected_id)
            except Exception as exc:
                with self.recorder.lock, self.lock:
                    if expected_id != self.artwork_id:
                        return
                    self.status = 'error'
                    self.error = '作品保存或记录失败：' + str(exc)
                    stop_event.set()
                    try:
                        self.recorder.stop()
                        self._save()
                    except Exception:
                        pass
                return

    def cancel(self):
        with self.recorder.lock, self.lock:
            if self.status != 'running':
                raise ValueError('当前没有进行中的创作')
            self.elapsed_s = min(60, max(0, (self.clock() - self.origin) / 1e9))
            self.status = 'cancelled'
            self.stop_event.set()
            try:
                self.recorder.stop()
            finally:
                self._save()

    def snapshot(self, include_preview=False):
        with self.lock:
            elapsed = self.elapsed_s
            if self.status == 'running':
                elapsed = min(60, max(0, (self.clock() - self.origin) / 1e9))
            data = {'schema_version': 1, 'renderer': 'woven-v1',
                'id': self.artwork_id, 'status': self.status, 'created_at': getattr(self, 'created_at', None),
                'duration_s': 60, 'interval_s': 5, 'band_count': 12, 'elapsed_s': elapsed,
                'bands': self.bands, 'references': getattr(self, 'references', {}),
                'late_samples': getattr(self, 'late_samples', 0), 'error': self.error,
                'canvas': {'width': 2400, 'height': 3200, 'qr_space': [1920, 2760, 320, 320]},
                'downloadable': self.status == 'completed'}
            if include_preview:
                data['preview'] = self._preview_band()
            return copy.deepcopy(data)

    def _save(self):
        data = self.snapshot()
        temporary = self.path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        temporary.replace(self.path)

    def close(self):
        if self.active:
            self.cancel()
        self.stop_event.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=2)
