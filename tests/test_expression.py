import csv
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

import cv2
import numpy as np
from acquisition.artwork import ArtworkSession
from acquisition.core import Recorder, stamp
from acquisition.expression import (ALIGN_POINTS, LABELS, ExpressionModel, ExpressionWorker,
                                    aligned_blob, expression_scores, verify_models)
from acquisition.interfaces import SamplePublisher
from acquisition.live import LiveTrace


class FakeCamera:
    def __init__(self):
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.raw = (np.zeros((80, 160, 3), np.uint8), 1, stamp())

    def is_alive(self):
        return not self.stop_event.is_set()


def wait_until(check):
    deadline = time.monotonic() + 2
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError('Worker did not reach expected state')
        time.sleep(.005)


class ExpressionTests(unittest.TestCase):
    def test_alignment_rgb_normalization_and_translation(self):
        frame = np.zeros((140, 140, 3), np.uint8)
        frame[:, :, 2] = 255
        blob = aligned_blob(frame, ALIGN_POINTS)
        self.assertEqual(blob.shape, (1, 3, 112, 112))
        self.assertTrue(np.allclose(blob[0, :, 40, 40], [1, -1, -1]))
        rng = np.random.default_rng(7)
        image = rng.integers(0, 256, (112, 112, 3), dtype=np.uint8)
        larger = np.zeros((140, 140, 3), np.uint8)
        larger[9:121, 7:119] = image
        expected = cv2.dnn.blobFromImage((cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32)/255-.5)/.5)
        np.testing.assert_allclose(aligned_blob(larger, ALIGN_POINTS + [7, 9]), expected, atol=1e-6)
        with self.assertRaises(ValueError): aligned_blob(frame, np.zeros((5, 2)))
        with self.assertRaises(ValueError): aligned_blob(frame, np.full((5, 2), np.nan))

    def test_output_logits_not_precalibrated_probabilities(self):
        scores = expression_scores([10000, -10000, 0, 1, 2, 3, 4])
        self.assertEqual(tuple(scores), LABELS)
        self.assertAlmostEqual(sum(scores.values()), 1)
        self.assertEqual(max(scores, key=scores.get), 'angry')
        for bad in ([0]*6, [0]*8, [float('nan')]*7):
            with self.assertRaises(ValueError): expression_scores(bad)

    def test_faces_zero_many_and_one_and_coordinate_scaling(self):
        model = ExpressionModel.__new__(ExpressionModel)
        model.face, model.net = Mock(), Mock()
        image = np.zeros((720, 1280, 3), np.uint8)
        model.face.detect.return_value = (0, None)
        self.assertEqual(model.infer(image)['quality'], 'no_face')
        model.face.detect.return_value = (2, np.ones((2, 15)))
        result = model.infer(image)
        self.assertIsNone(result['label']); self.assertIsNone(result['scores'])
        self.assertEqual(result['quality'], 'multiple_faces')
        model.net.forward.assert_not_called()
        face = np.r_[np.array([10, 20, 80, 90]), ALIGN_POINTS.reshape(-1), .99].astype(np.float32)
        model.face.detect.return_value = (1, face.reshape(1, 15))
        model.net.forward.return_value = np.array([[0, 0, 0, 10, 0, 0, 0]])
        result = model.infer(image)
        self.assertEqual(result['label'], 'happy')
        self.assertEqual(result['face_box'], [20, 40, 160, 180])
        self.assertEqual(result['quality'], 'classified_unvalidated')

    def test_worker_no_duplicate_samples_stale_and_camera_disconnect(self):
        camera, publisher, model = FakeCamera(), Mock(), Mock()
        model.infer.return_value = {'quality': 'no_face', 'face_count': 0, 'scores': None, 'label': None}
        worker = ExpressionWorker(camera, publisher, 10, lambda: model)
        self.addCleanup(lambda: (worker.stop(), worker.join(2)))
        worker.start()
        wait_until(lambda: publisher.publish.call_count == 1)
        time.sleep(.15)
        for _ in range(10): worker.snapshot()
        self.assertEqual(publisher.publish.call_count, 1)
        sample, clock = worker.latest
        self.assertEqual(sample['frame_id'], 1)
        self.assertEqual(clock, camera.raw[2])
        self.assertGreaterEqual(sample['completed_monotonic_ns'], clock['host_monotonic_ns'])
        with worker.lock:
            worker.latest = (sample, {**clock, 'host_monotonic_ns': time.monotonic_ns()-2_000_000_000})
        self.assertFalse(worker.snapshot()['fresh'])
        camera.stop_event.set()
        worker.join(2)
        self.assertIsNone(worker.snapshot()['sample'])
        self.assertFalse(worker.is_alive())
        # A new camera/worker has independent frame IDs and can reconnect.
        second = ExpressionWorker(FakeCamera(), Mock(), 10, lambda: model)
        second.start()
        try: wait_until(lambda: second.snapshot()['fresh'])
        finally: second.stop(); second.join(2)

    def test_stopping_discards_inflight_result(self):
        camera, publisher = FakeCamera(), Mock()
        entered, release = threading.Event(), threading.Event()
        def infer(frame):
            entered.set(); release.wait(2)
            return {'quality': 'no_face'}
        worker = ExpressionWorker(camera, publisher, 5, lambda: Mock(infer=infer))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            worker.stop()
        finally:
            release.set(); worker.join(2)
        publisher.publish.assert_not_called()
        self.assertIsNone(worker.snapshot()['sample'])

    def test_model_and_inference_errors_do_not_stop_camera(self):
        for factory in (Mock(side_effect=RuntimeError('model absent')),
                        lambda: Mock(infer=Mock(side_effect=RuntimeError('inference failed')))):
            camera = FakeCamera()
            worker = ExpressionWorker(camera, Mock(), 5, factory)
            worker.start(); worker.join(2)
            self.assertEqual(worker.snapshot()['state'], 'error')
            self.assertFalse(camera.stop_event.is_set())
            self.assertIsNone(worker.snapshot()['sample'])

    def test_model_hash_failure_has_install_instruction(self):
        with tempfile.TemporaryDirectory() as folder:
            from acquisition.expression import MODEL_DIR
            path = Path(folder)
            (path/'manifest.json').write_bytes((MODEL_DIR/'manifest.json').read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'download_expression_models'):
                verify_models(path)

    def test_controller_start_guards_stop_and_recording_metadata(self):
        from unittest.mock import patch
        from server import Controller
        from acquisition.expression import idle_state
        controller = Controller()
        self.addCleanup(controller.close)
        with self.assertRaisesRegex(ValueError, '摄像头'):
            controller.action('expression_start', {})
        controller.camera = FakeCamera()
        controller.camera.latest = None
        controller.camera.metrics = {}
        with self.assertRaises(ValueError): controller.action('expression_start', {'rate': 20})
        with self.assertRaises(ValueError): controller.action('expression_start', {'rate': True})
        with patch('server.ExpressionWorker') as worker_type:
            worker = worker_type.return_value
            worker.is_alive.return_value = True
            controller.action('expression_start', {})
            worker_type.assert_called_once_with(controller.camera, controller.publisher, 5)
            worker.start.assert_called_once()
            with self.assertRaises(ValueError): controller.action('expression_start', {})
            controller.recorder.active = True
            try:
                with self.assertRaises(ValueError): controller.action('expression_start', {})
                controller.action('expression_stop', {})
                worker.stop.assert_called_once()
            finally: controller.recorder.active = False
        # Test metadata without requiring live hardware.
        state = {'camera_fresh':False,'eda':{'port':None,'stream_id':None},'heart_fresh':False,'expression':idle_state()}
        state['eda']['fresh'] = False
        meta = controller.record_settings(state)['expression']
        self.assertEqual(meta['model']['labels'], list(LABELS))
        self.assertEqual(len(meta['model']['models'][1]['sha256']), 64)
        controller.camera = None

    def test_recording_csv_deadline_session_boundary_and_no_artwork_effect(self):
        with tempfile.TemporaryDirectory() as root:
            rec, trace = Recorder(), LiveTrace()
            art = ArtworkSession(rec, start_timer=False)
            art.start(root, {})
            pub = SamplePublisher(rec, trace)
            origin = rec.origin
            def send(frame, captured, completed):
                pub.publish('expression', {'frame_id': frame, 'scores': dict.fromkeys(LABELS, 1/7),
                                          'label': 'neutral', 'completed_monotonic_ns': origin+int(completed*1e9)},
                            {'host_monotonic_ns': origin+int(captured*1e9), 'host_utc': 'synthetic'})
            try:
                send(1, -1, .1)  # Frame belongs to an older session.
                send(2, 1, 1.1)
                send(3, 59.9, 60)  # Inference finishes after the deadline.
                send(4, 60, 60.1)
                self.assertEqual(rec.counts['expression'], 1)
                self.assertEqual(len(trace.snapshot()['rows']), 4)
                self.assertTrue(all(not bucket['left'] and not bucket['right'] and not bucket['heart'] for bucket in art.buckets))
                art.tick(origin+65_000_000_000)
                self.assertTrue(all(b['empty'] for b in art.snapshot()['bands']))
                with (rec.path/'expression.csv').open(encoding='utf-8-sig') as handle:
                    rows = list(csv.DictReader(handle))
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]['frame_id'], '2')
                self.assertEqual(set(json.loads(rows[0]['scores'])), set(LABELS))
                rec.start(root, {})
                pub.publish('expression', {'frame_id': 9, 'completed_monotonic_ns': time.monotonic_ns()},
                            {'host_monotonic_ns': origin, 'host_utc':'synthetic'})
                self.assertEqual(rec.counts['expression'], 0)
            finally:
                rec.stop(); art.close()
