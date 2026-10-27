import time
import unittest
from unittest.mock import patch, Mock
import numpy as np
import cv2
from acquisition.camera import CameraWorker
from acquisition.core import Recorder, stamp
from acquisition.eye import PupilDetector


class CameraPipelineTests(unittest.TestCase):
    def test_manual_rois_skip_cascade_and_auto_is_time_based(self):
        detector = PupilDetector()
        frame = np.full((100, 200, 3), 150, np.uint8)
        with patch.object(detector, 'automatic_rois', side_effect=AssertionError('unnecessary detection')):
            detector.measure_pair(frame, {'image_left': (10, 10, 50, 50), 'image_right': (100, 10, 50, 50)})
        detector.face = Mock()
        detector.face.detectMultiScale.return_value = []
        gray = frame[:, :, 0]
        with patch('acquisition.eye.time.monotonic', side_effect=[0, .1, .49, .5]):
            for _ in range(4): detector.automatic_rois(gray)
        self.assertEqual(detector.face.detectMultiScale.call_count, 2)

    def test_preview_cache_no_samples_and_stale_overlay(self):
        rec = Recorder()
        worker = CameraWorker(0, 0, 20, rec, lambda *a: None, False)
        frame = np.zeros((100, 100, 3), np.uint8)
        clock = stamp()
        worker.raw = (frame, 1, clock)
        worker.latest = (frame, {'roi_version': 0, 'eyes': {}}, clock)
        with patch('acquisition.camera.cv2.imencode', wraps=cv2.imencode) as encode:
            first = worker.preview_jpeg()
            self.assertEqual(first, worker.preview_jpeg())
            self.assertEqual(encode.call_count, 1)
        self.assertFalse(rec.active)
        worker.raw = (frame, 2, {**clock, 'host_monotonic_ns': time.monotonic_ns() - 2_000_000_000})
        self.assertIsNone(worker.preview_jpeg())

    def test_slow_detection_skips_old_frames_and_releases_capture(self):
        frame = np.zeros((100, 100, 3), np.uint8)
        cap = Mock()
        cap.isOpened.return_value = True
        cap.get.return_value = 30
        cap.getBackendName.return_value = 'fake'
        def read():
            time.sleep(.003)
            return True, frame
        cap.read.side_effect = read
        detector = Mock()
        def measure(*args):
            time.sleep(.04)
            return {'eyes': {}}
        detector.measure_pair.side_effect = measure
        samples = []
        worker = CameraWorker(0, 0, 20, Recorder(), lambda *a: None, False,
                              lambda sample, clock: samples.append(sample))
        with patch('acquisition.camera.cv2.VideoCapture', return_value=cap), patch('acquisition.camera.PupilDetector', return_value=detector):
            worker.start()
            deadline = time.monotonic() + 2
            while len(samples) < 4 and time.monotonic() < deadline: time.sleep(.01)
            worker.stop_event.set(); worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        cap.release.assert_called_once()
        self.assertGreaterEqual(len(samples), 4)
        self.assertTrue(all(b['frame_id'] - a['frame_id'] > 1 for a,b in zip(samples, samples[1:])))
        self.assertLess(samples[-1]['frame_age_ms'], 200)
