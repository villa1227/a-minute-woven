import copy
import json
import tempfile
import unittest
from pathlib import Path

from acquisition.artwork import ArtworkSession
from acquisition.core import Recorder


def camera(left=None, right=None):
    return {'eyes': {side: {'candidate_diameter_px': value,
        'quality': 'candidate_unvalidated' if value is not None else 'no_candidate'}
        for side, value in (('image_left', left), ('image_right', right))}}


class ArtworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.rec = Recorder()
        self.now = 0
        self.art = ArtworkSession(self.rec, clock=lambda: self.now, start_timer=False)
        self.art.start(self.temp.name, {})
        self.origin = self.rec.origin
        self.now = self.origin
        self.addCleanup(self.art.close)

    def send(self, source, data, second):
        self.rec.emit(source, data, {'host_monotonic_ns': self.origin + int(second * 1e9), 'host_utc': 'test'})

    def advance(self, second):
        self.now = self.origin + int(second * 1e9)
        self.art.tick()

    def test_boundaries_exactly_twelve_and_disk_snapshot(self):
        self.send('camera', camera(99), -.001)
        self.send('camera', camera(20), 0)
        self.send('camera', camera(22), 4.999999999)
        self.send('camera', camera(30), 5)
        self.send('camera', camera(40), 59.999999999)
        self.send('camera', camera(90), 60)
        self.advance(5)
        first = copy.deepcopy(self.art.snapshot()['bands'][0])
        self.assertEqual(first['counts']['left'], 2)
        self.assertEqual(first['values']['left'], 21)
        self.advance(60)
        result = self.art.snapshot()
        self.assertEqual(len(result['bands']), 12)
        self.assertEqual(result['bands'][1]['values']['left'], 30)
        self.assertEqual(result['bands'][11]['values']['left'], 40)
        self.assertEqual(result['bands'][0], first)
        self.assertFalse(result['downloadable'])
        self.assertEqual(result['phase'], 'finishing')
        self.assertFalse(self.rec.active)
        disk = json.loads(self.art.path.read_text(encoding='utf-8'))
        self.assertEqual(disk, result)
        self.advance(65)
        self.assertEqual(len(self.art.snapshot()['bands']), 12)
        self.assertTrue(self.art.snapshot()['downloadable'])
        self.assertEqual(json.loads(self.art.path.read_text(encoding='utf-8')), self.art.snapshot())

    def test_only_finalized_medians_are_published(self):
        self.send('heart_rate', {'bpm': 70, 'contact_detected': True}, .4)
        first = self.art.snapshot(include_preview=True)['preview']
        self.assertIsNone(first)
        self.assertEqual(self.art.snapshot()['phase'], 'preparing')
        self.send('heart_rate', {'bpm': 100, 'contact_detected': True}, 1.4)
        second = self.art.snapshot(include_preview=True)['preview']
        self.assertIsNone(second)
        self.assertEqual(self.art.snapshot()['bands'], [])
        self.advance(5)
        self.assertIsNone(self.art.snapshot(include_preview=True)['preview'])
        self.assertEqual(self.art.snapshot()['bands'][0]['values']['heart'], 85)
        self.advance(7.5)
        self.assertEqual(self.art.snapshot()['elapsed_s'], 7.5)
        self.advance(60)
        self.assertTrue(self.art.active)
        with self.assertRaises(ValueError):
            self.art.start(self.temp.name, {})
        self.art.cancel()
        self.assertFalse(self.art.snapshot()['downloadable'])

    def test_independent_references_clamping_and_missing_data(self):
        self.send('camera', camera(20), 1)
        # BLE heart-rate notifications need not land on the 5-second boundary;
        # the whole window is reduced to its median.
        self.send('heart_rate', {'bpm': 60, 'contact_detected': True}, 1.2)
        self.send('heart_rate', {'bpm': 120, 'contact_detected': True}, 1.8)
        self.send('heart_rate', {'bpm': 80, 'contact_detected': True}, 2)
        self.advance(5)
        first = self.art.snapshot()['bands'][0]
        self.assertAlmostEqual(first['amplitude']['left'], .16)
        self.assertIsNone(first['amplitude']['right'])
        self.assertEqual(first['threads'], 28)
        self.assertEqual(first['values']['heart'], 80)
        self.assertEqual(first['counts']['heart'], 3)
        self.send('camera', camera(40, 30), 6)
        self.send('heart_rate', {'bpm': 200, 'contact_detected': False}, 7)
        self.advance(10)
        second = self.art.snapshot()['bands'][1]
        self.assertAlmostEqual(second['amplitude']['left'], .24)
        self.assertAlmostEqual(second['amplitude']['right'], .16)
        self.assertEqual(second['threads'], 22)
        self.send('camera', camera(1, 100), 11)
        self.send('heart_rate', {'bpm': 110}, 11)
        self.advance(15)
        third = self.art.snapshot()['bands'][2]
        self.assertAlmostEqual(third['amplitude']['left'], .08)
        self.assertAlmostEqual(third['amplitude']['right'], .24)
        self.assertEqual(third['threads'], 40)
        self.advance(20)
        self.assertTrue(self.art.snapshot()['bands'][3]['empty'])
        self.assertEqual(self.art.snapshot()['bands'][3]['threads'], 22)
        self.assertEqual(self.art.snapshot()['bands'][3]['base_threads'], 22)
        self.assertEqual(self.art.snapshot()['references'], {'left': 20, 'right': 30, 'heart': 80})

    def test_invalid_samples_late_samples_and_cancellation(self):
        self.send('camera', camera(float('nan')), 1) if False else None
        self.send('camera', {'eyes': {'image_left': {'candidate_diameter_px': 20, 'quality': 'blurred'}}}, 1)
        self.send('heart_rate', {'bpm': 0}, 2)
        self.advance(5)
        original = self.art.snapshot()['bands'][0]
        self.assertTrue(original['empty'])
        self.assertEqual(original['threads'], 22)
        self.send('camera', camera(25), 3)
        self.assertEqual(self.art.snapshot()['bands'][0], original)
        self.assertEqual(self.art.snapshot()['late_samples'], 1)
        self.now = self.origin + 6_000_000_000
        self.art.cancel()
        self.assertFalse(self.rec.active)
        self.assertEqual(self.art.snapshot()['status'], 'cancelled')
        self.assertFalse(self.art.snapshot()['downloadable'])
        self.assertTrue((self.rec.path / 'samples.jsonl').exists())
        with self.assertRaises(ValueError):
            self.art.cancel()

    def test_duplicate_start_snapshot_isolation_and_new_session(self):
        original_id = self.art.artwork_id
        with self.assertRaises(ValueError):
            self.art.start(self.temp.name, {})
        self.send('camera', camera(20), 1)
        self.advance(5)
        snapshot = self.art.snapshot()
        snapshot['bands'][0]['values']['left'] = 999
        self.assertEqual(self.art.snapshot()['bands'][0]['values']['left'], 20)
        self.art.cancel()
        self.art.start(self.temp.name, {})
        self.assertNotEqual(self.art.artwork_id, original_id)
        self.assertEqual(self.art.snapshot()['bands'], [])
        self.art.tick(now_ns=self.rec.origin + 60_000_000_000, expected_id=original_id)
        self.assertEqual(self.art.snapshot()['status'], 'running')


class ControllerArtworkTests(unittest.TestCase):
    def test_no_sensor_start_and_roi_lock(self):
        import server
        from unittest.mock import patch
        controller = server.Controller()
        controller.artwork.start_timer = False
        self.addCleanup(controller.close)
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'ROOT', Path(directory)):
            controller.action('artwork_start', {})
            controller.action('artwork_cancel', {})
            clock = {'host_monotonic_ns': __import__('time').monotonic_ns(), 'host_utc': 'test'}
            class Heart:
                stop_event = __import__('threading').Event()
                def is_alive(self):
                    return True
                def join(self, timeout):
                    pass
            controller.heart = Heart()
            controller.on_hr({'bpm': 80, 'contact_detected': True}, clock)
            controller.action('record_start', {})
            with self.assertRaises(ValueError):
                controller.action('artwork_start', {})
            controller.action('record_stop', {})
            controller.action('artwork_start', {})
            for command in ('artwork_start', 'record_start', 'record_stop', 'roi', 'camera_start'):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    controller.action(command, {})
            controller.action('artwork_cancel', {})
            self.assertFalse(controller.recorder.active)


if __name__ == '__main__':
    unittest.main()
