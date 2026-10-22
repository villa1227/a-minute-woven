import json
import csv
import tempfile
import threading
import unittest
from pathlib import Path

import cv2
import numpy as np

from acquisition.core import Recorder, stamp
from acquisition.eye import PupilDetector
from acquisition.heart import parse_measurement


class HeartTests(unittest.TestCase):
    def test_standard_bpm_and_optional_fields(self):
        sample = parse_measurement(bytes([0x1f, 0x2c, 0x01, 7, 0, 0, 4, 0x33, 3]))
        self.assertEqual(sample["bpm"], 300)
        self.assertTrue(sample["contact_detected"])
        self.assertEqual(sample["energy_expended_kj"], 7)
        self.assertEqual(sample["rr_1024s"], [1024, 819])
        self.assertEqual(sample["rr_ms"][0], 1000)

    def test_no_rr_is_not_invented(self):
        sample = parse_measurement(bytes([0, 72]))
        self.assertEqual(sample["rr_ms"], [])
        self.assertIsNone(sample["contact_detected"])
        self.assertEqual(sample["raw_hex"], "0048")
        self.assertEqual(parse_measurement(bytes([4, 72]))["quality"], "contact_lost")

    def test_malformed(self):
        for packet in (b"", b"\x01\x48", b"\x08\x48\x00", b"\x10\x48", b"\x10\x48\x00", b"\x00\x48\xff"):
            with self.subTest(packet=packet), self.assertRaises(ValueError):
                parse_measurement(packet)


class RecordingTests(unittest.TestCase):
    def test_both_eyes_have_separate_saved_columns(self):
        with tempfile.TemporaryDirectory() as temp:
            rec = Recorder()
            path = rec.start(temp, {})
            frame = np.full((160, 320, 3), 180, dtype=np.uint8)
            cv2.circle(frame, (80, 80), 12, (18, 18, 18), -1)
            cv2.circle(frame, (240, 80), 18, (18, 18, 18), -1)
            sample = PupilDetector().measure_pair(frame, {
                'image_left': (30, 30, 100, 100), 'image_right': (190, 30, 100, 100)})
            rec.emit('camera', sample)
            rec.stop()
            with (path / 'camera.csv').open(encoding='utf-8-sig', newline='') as handle:
                row = next(csv.DictReader(handle))
            self.assertLess(float(row['image_left_candidate_diameter_px']),
                            float(row['image_right_candidate_diameter_px']))
            self.assertEqual(set(json.loads(row['eyes'])), {'image_left', 'image_right'})

    def test_concurrent_sources_and_clock(self):
        with tempfile.TemporaryDirectory() as temp:
            rec = Recorder()
            old = stamp()
            path = rec.start(temp, {"test": True})
            rec.emit("camera", {"value": -1}, old)
            def send(source):
                for i in range(20):
                    rec.emit(source, {"value": i})
            threads = [threading.Thread(target=send, args=(s,)) for s in ("camera", "heart_rate", "eda")]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            rec.emit("marker", {"label": "task_start"})
            rec.stop()
            rows = [json.loads(line) for line in (path / "samples.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 63)
            self.assertEqual([r["seq"] for r in rows], list(range(63)))
            self.assertTrue(all(r["session_s"] >= 0 for r in rows))
            meta = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["counts"]["eda"], 20)
            self.assertTrue((path / "camera.csv").exists())
            self.assertTrue((path / "heart_rate.csv").exists())


class PupilTests(unittest.TestCase):
    def test_binocular_candidates_are_independent(self):
        frame = np.full((160, 320, 3), 180, dtype=np.uint8)
        cv2.circle(frame, (80, 80), 12, (18, 18, 18), -1)
        cv2.circle(frame, (240, 80), 18, (18, 18, 18), -1)
        sample = PupilDetector().measure_pair(frame, {
            'image_left': (30, 30, 100, 100), 'image_right': (190, 30, 100, 100)})
        left, right = sample['eyes']['image_left'], sample['eyes']['image_right']
        self.assertAlmostEqual(left['candidate_diameter_px'], 24, delta=4)
        self.assertAlmostEqual(right['candidate_diameter_px'], 36, delta=4)
        self.assertEqual(left['roi_mode'], 'manual')
        self.assertEqual(right['roi_mode'], 'manual')

    def test_single_detection_stays_on_correct_image_side(self):
        class Cascade:
            def __init__(self, boxes):
                self.boxes = boxes
            def detectMultiScale(self, *_args, **_kwargs):
                return self.boxes
        detector = PupilDetector()
        detector.face = Cascade([(0, 0, 100, 80)])
        detector.eye = Cascade([(130, 30, 40, 40)])
        rois = detector.automatic_rois(np.full((160, 200), 128, dtype=np.uint8))
        self.assertIsNone(rois['image_left'])
        self.assertEqual(rois['image_right'], (130, 30, 40, 40))

    def test_missing_side_does_not_copy_other_eye(self):
        frame = np.full((160, 320, 3), 180, dtype=np.uint8)
        cv2.circle(frame, (80, 80), 12, (18, 18, 18), -1)
        detector = PupilDetector()
        detector.automatic_rois = lambda gray: {'image_left': None, 'image_right': None}
        sample = detector.measure_pair(frame, {'image_left': (30, 30, 100, 100)})
        self.assertIsNotNone(sample['eyes']['image_left']['candidate_diameter_px'])
        self.assertEqual(sample['eyes']['image_right']['quality'], 'no_eye_roi')
        self.assertIsNone(sample['eyes']['image_right']['candidate_diameter_px'])

    def test_synthetic_dark_circle_candidate(self):
        frame = np.full((140, 200, 3), 180, dtype=np.uint8)
        cv2.circle(frame, (100, 70), 16, (18, 18, 18), -1)
        sample = PupilDetector().measure(frame, (40, 25, 120, 90))
        self.assertEqual(sample["quality"], "candidate_unvalidated")
        self.assertAlmostEqual(sample["candidate_diameter_px"], 32, delta=4)
        self.assertAlmostEqual(sample["candidate_center_px"][0], 100, delta=2)

    def test_blank_frame_does_not_become_measurement(self):
        frame = np.full((100, 100, 3), 128, dtype=np.uint8)
        sample = PupilDetector().measure(frame, (10, 10, 80, 80))
        self.assertEqual(sample["quality"], "blurred")
        self.assertIsNone(sample["candidate_diameter_px"])


if __name__ == "__main__":
    unittest.main()
