import json
import threading
import unittest
from unittest.mock import patch

from acquisition.live import LiveTrace


class LiveTraceTests(unittest.TestCase):
    def test_cursor_tracks_real_samples_only(self):
        trace = LiveTrace()
        trace.emit('heart_rate', {'bpm': 72, 'contact_detected': True, 'quality': 'valid'})
        first = trace.snapshot()
        self.assertEqual(len(first['rows']), 1)
        self.assertEqual(first['rows'][0]['data']['bpm'], 72)
        self.assertEqual(trace.snapshot(first['cursor'])['rows'], [])
        trace.emit('heart_rate', {'bpm': 73})
        self.assertEqual([row['data']['bpm'] for row in trace.snapshot(first['cursor'])['rows']], [73])

    def test_missing_eye_stays_missing(self):
        trace = LiveTrace()
        trace.emit('camera', {'eyes': {
            'image_left': {'candidate_diameter_px': 22, 'quality': 'candidate_unvalidated'},
            'image_right': {'candidate_diameter_px': None, 'quality': 'no_candidate'}}})
        data = trace.snapshot()['rows'][0]['data']['eyes']
        self.assertEqual(data['image_left']['candidate_diameter_px'], 22)
        self.assertIsNone(data['image_right']['candidate_diameter_px'])
        json.dumps(trace.snapshot(), allow_nan=False)

    def test_history_expires_without_new_samples(self):
        with patch('acquisition.live.time.monotonic_ns', return_value=1_000_000_000):
            trace = LiveTrace(duration=10)
            trace.emit('marker', {'label': 'test'})
        with patch('acquisition.live.time.monotonic_ns', return_value=12_000_000_000):
            self.assertEqual(trace.snapshot()['rows'], [])
            self.assertEqual(trace.snapshot()['cursor'], 1)

    def test_concurrent_sources_and_bounded_memory(self):
        trace = LiveTrace(maxlen=25)
        def emit(source):
            for value in range(20):
                trace.emit(source, {'value': value})
        workers = [threading.Thread(target=emit, args=(source,)) for source in ('marker', 'event')]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        data = trace.snapshot()
        self.assertEqual(data['cursor'], 40)
        self.assertEqual(len(data['rows']), 25)
        self.assertEqual([row['seq'] for row in data['rows']], list(range(16, 41)))


if __name__ == '__main__':
    unittest.main()
