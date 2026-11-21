import threading
import time
import unittest
from unittest.mock import Mock, patch
import numpy as np
import cv2
from acquisition.eye import PupilDetector
from acquisition.camera import CameraWorker
from acquisition.core import Recorder
from server import Controller


class DualCameraTests(unittest.TestCase):
    def test_closeup_finds_eyes_without_face_and_missing_half_stays_missing(self):
        detector = PupilDetector()
        detector.face = Mock(); detector.face.detectMultiScale.return_value = []
        detector.eye = Mock(); detector.eye.detectMultiScale.side_effect = [np.array([[30,40,90,60]]),np.array([[50,45,100,65]])]
        rois = detector.automatic_rois(np.zeros((300,600),np.uint8))
        self.assertEqual(rois['image_left'],(30,40,90,60))
        self.assertEqual(rois['image_right'],(350,45,100,65))
        detector.next_detection=0;detector.eye.detectMultiScale.side_effect=[[],np.array([[50,45,100,65]])]
        rois=detector.automatic_rois(np.zeros((300,600),np.uint8))
        self.assertIsNone(rois['image_left']);self.assertIsNotNone(rois['image_right'])

    def test_expression_independent_camera_and_release(self):
        c=Controller();self.addCleanup(c.close)
        c.cameras=[{'index':0,'name':'eyes'},{'index':1,'name':'face'}]
        eyes=Mock();eyes.index=0;eyes.is_alive.return_value=True;eyes.stop_event=threading.Event();c.camera=eyes
        face=Mock();face.is_alive.return_value=True;face.index=1;face.stop_event=threading.Event()
        expression=Mock();expression.is_alive.return_value=True;expression.camera=face
        with patch('server.CameraWorker',return_value=face) as factory,patch('server.ExpressionWorker',return_value=expression) as expr:
            c.action('expression_start',{'camera_index':1,'rate':5})
            self.assertTrue(factory.call_args.kwargs['capture_only'])
            expr.assert_called_once_with(face,c.publisher,5)
            c.action('camera_stop',{})
            self.assertTrue(eyes.stop_event.is_set());self.assertFalse(face.stop_event.is_set())
            expression.stop.assert_not_called()
            c.action('expression_stop',{});self.assertTrue(face.stop_event.is_set())
            expression.stop.assert_called_once()

    def test_capture_only_never_runs_pupil_or_records_camera_samples(self):
        cap=Mock();cap.isOpened.return_value=True;cap.get.return_value=30;cap.getBackendName.return_value='test'
        def read():time.sleep(.005);return True,np.zeros((80,160,3),np.uint8)
        cap.read.side_effect=read
        rec=Mock();worker=CameraWorker(1,cv2.CAP_DSHOW,20,rec,lambda *args:None,False,capture_only=True)
        with patch('acquisition.camera.cv2.VideoCapture',return_value=cap),patch('acquisition.camera.PupilDetector',side_effect=AssertionError('eye detector on face camera')):
            worker.start()
            try:
                deadline=time.monotonic()+2
                while worker.raw is None and worker.is_alive() and time.monotonic()<deadline:time.sleep(.01)
                self.assertIsNotNone(worker.raw);self.assertIsNotNone(worker.preview_jpeg())
            finally:worker.stop_event.set();worker.join(2)
        self.assertFalse(worker.is_alive());cap.release.assert_called_once()
        self.assertFalse(any(call.args[0]=='camera' for call in rec.emit.call_args_list))
