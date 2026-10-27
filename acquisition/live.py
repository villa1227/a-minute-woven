"""Bounded live view of sensor samples, independent of recording to disk."""
import threading
import time
import uuid
from collections import deque


class LiveTrace:
    def __init__(self, duration=180, maxlen=24000):
        self.origin = time.monotonic_ns()
        self.stream_id = uuid.uuid4().hex
        self.duration = duration
        self.rows = deque(maxlen=maxlen)
        self.seq = 0
        self.lock = threading.Lock()

    def emit(self, source, data, clock=None):
        t = ((clock['host_monotonic_ns'] if clock else time.monotonic_ns()) - self.origin) / 1e9
        if source == 'camera':
            data = {'eyes': {side: {key: eye.get(key) for key in (
                'candidate_diameter_px', 'quality', 'brightness', 'roi_mode')}
                for side, eye in data['eyes'].items()}}
        elif source == 'heart_rate':
            data = {key: data.get(key) for key in ('bpm', 'quality', 'contact_detected')}
        elif source == 'eda':
            data = {key: data.get(key) for key in ('adc', 'quality', 'break_before', 'segment', 'stream_id')}
        else:
            data = dict(data)
        with self.lock:
            self.seq += 1
            self.rows.append({'seq': self.seq, 't': t, 'source': source, 'data': data})
            self._prune((time.monotonic_ns() - self.origin) / 1e9)

    def _prune(self, now):
        while self.rows and self.rows[0]['t'] < now - self.duration:
            self.rows.popleft()

    def snapshot(self, after=0):
        with self.lock:
            now = (time.monotonic_ns() - self.origin) / 1e9
            self._prune(now)
            return {'stream_id': self.stream_id, 'now_s': now, 'cursor': self.seq,
                    'rows': [row for row in self.rows if row['seq'] > after]}
