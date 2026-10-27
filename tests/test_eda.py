import csv
import json
import queue
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from acquisition.core import Recorder
from acquisition.eda import EdaService
from acquisition.live import LiveTrace
from skin_sigma.gsr import GsrService, LineFramer, parse_line, UINT32


def packet(seq, ms, adc=500):
    return f'GSR,1,{seq},{ms},{adc}\r\n'.encode()


class FakeSerial:
    def __init__(self, **kwargs):
        self.options = kwargs
        self.queue = queue.Queue()
        self.closed = False

    @property
    def in_waiting(self):
        return 0

    def read(self, size):
        try:
            value = self.queue.get(timeout=.02)
        except queue.Empty:
            return b''
        if isinstance(value, Exception):
            raise value
        return value

    def close(self):
        self.closed = True


class EdaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = time.monotonic_ns()
        self.service = GsrService(self.temp.name, clock=lambda: self.now)
        self.service.connected = True

    def test_parser_and_split_frames(self):
        self.assertEqual(parse_line(packet(1, 50, 0))['adc'], 0)
        for raw in (b'sensorValue=500\n', b'GSR,2,1,50,500\n', packet(1, 50, 1024),
                    packet(-1, 50), packet(UINT32, 50), b'GSR,1,1,50,nan\n', b'\xff\n'):
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                parse_line(raw)
        f = LineFramer()
        data = packet(0, 0) + packet(1, 50)
        self.assertEqual(f.feed(data[:7]), [])
        self.assertEqual(len(f.feed(data[7:])), 2)
        rows = f.feed(b'x' * 700 + b'\n' + packet(2, 100))
        self.assertIsNotNone(rows[0][1])
        self.assertEqual(parse_line(rows[1][0])['seq'], 2)

    def test_20hz_reference_freshness_and_polling(self):
        for i in range(1200):
            self.now += 50_000_000
            self.service.feed(packet(i, i * 50, 500 + i % 2))
        state = self.service.snapshot()
        self.assertAlmostEqual(state['rate_hz'], 20)
        self.assertEqual(state['device_interval_median_ms'], 50)
        self.assertEqual(state['stats']['samples'], 1200)
        self.assertEqual(self.service.set_reference(), 501)
        cursor = self.service.snapshot()['cursor']
        for _ in range(5):
            self.assertEqual(self.service.snapshot(cursor)['rows'], [])
        self.assertEqual(self.service.stats['samples'], 1200)
        self.now += 1_000_000_000
        self.assertFalse(self.service.snapshot()['fresh'])
        with self.assertRaises(ValueError):
            self.service.set_reference()

    def test_missing_duplicate_reset_and_wrap(self):
        s = self.service
        s.feed(packet(10, 500))
        s.feed(packet(10, 500))
        s.feed(packet(12, 600))
        self.assertEqual(s.stats['samples'], 2)
        self.assertEqual(s.stats['duplicates'], 1)
        self.assertEqual(s.stats['missing'], 1)
        self.assertTrue(s.last['break_before'])
        s.reference = 500
        s.feed(packet(0, 0))
        self.assertEqual(s.stats['resets'], 1)
        self.assertIsNone(s.reference)
        s.last_wire = (100, UINT32 - 25)
        s.feed(packet(101, 25))
        self.assertEqual(s.stats['time_wraps'], 1)
        self.assertEqual(s.last['device_interval_ms'], 50)
        self.assertTrue(s.last['break_before'])
        s.last_wire = (UINT32 - 1, 100)
        s.feed(packet(0, 150))
        self.assertEqual(s.stats['sequence_wraps'], 1)
        s.feed(b'#GSR,1,UNO,A0,10,20\n')
        self.assertIsNone(s.last)
        self.assertFalse(s.snapshot()['fresh'])

    def test_serial_busy_disconnect_and_reconnect(self):
        def busy(**kwargs):
            raise PermissionError('port busy')
        s = GsrService(self.temp.name, serial_factory=busy)
        with self.assertRaises(PermissionError):
            s.connect('COM6')
        self.assertFalse(s.connected)
        s.serial_factory = FakeSerial
        self.addCleanup(s.close)
        s.connect('COM6')
        stream = s.stream_id
        with self.assertRaises(ValueError):
            s.connect('COM6')
        self.assertEqual(s.connection.options['baudrate'], 115200)
        connection = s.connection
        connection.queue.put(OSError('USB removed'))
        s.worker.join(timeout=1)
        self.assertFalse(s.connected)
        self.assertTrue(connection.closed)
        self.assertIn('USB removed', s.status)
        s.connect('COM6')
        self.assertNotEqual(s.stream_id, stream)
        s.disconnect()
        self.assertFalse(s.worker.is_alive())

    def test_shared_recording_keeps_host_and_device_sequences(self):
        rec = Recorder()
        rec.start(self.temp.name, {})
        self.addCleanup(rec.stop)
        trace = LiveTrace()
        service = EdaService(rec, trace, self.temp.name)
        service.port = 'COM6'
        service.feed(packet(1000, 50000, 0))
        service.feed(packet(1000, 50000, 0))
        service.feed(b'bad line\n')
        service.feed(packet(1001, 50050, 510))
        rec.stop()
        with (rec.path / 'eda.csv').open(encoding='utf-8-sig') as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['seq'], '1')
        self.assertEqual(rows[0]['device_seq'], '1000')
        self.assertEqual(rows[0]['adc'], '0')
        log = [json.loads(line) for line in (rec.path / 'samples.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual(sum(r['source'] == 'eda' for r in log), 2)
        self.assertEqual(sum(r['source'] == 'eda' for r in trace.snapshot()['rows']), 2)
        self.assertEqual(service.snapshot(include_rows=False)['rows'], [])

    def test_controller_eda_only_recording_and_artwork(self):
        import server
        with patch.object(server, 'ROOT', Path(self.temp.name)), patch.object(server, 'list_ports',
                return_value=[{'port': 'COM6', 'description': 'USB CH340', 'hwid': 'test'}]):
            controller = server.Controller()
            controller.artwork.start_timer = False
            controller.eda.serial_factory = FakeSerial
            self.addCleanup(controller.close)
            controller.action('eda_connect', {'port': 'COM6'})
            controller.eda.feed(packet(0, 0, 500))
            controller.action('record_start', {})
            controller.eda.feed(packet(1, 50, 501))
            controller.recorder.emit('camera', {'value': 2})
            controller.recorder.emit('heart_rate', {'bpm': 70})
            with self.assertRaises(ValueError):
                controller.action('eda_connect', {'port': 'COM6'})
            controller.action('eda_stop', {})
            self.assertTrue(controller.recorder.active)
            self.assertFalse(controller.snapshot()['eda']['fresh'])
            controller.action('record_stop', {})
            meta = json.loads((controller.recorder.path / 'metadata.json').read_text(encoding='utf-8'))
            self.assertTrue(meta['settings']['active_sensors']['eda'])
            self.assertEqual(meta['counts']['eda'], 1)
            self.assertEqual(meta['counts']['camera'], 1)
            self.assertEqual(meta['counts']['heart_rate'], 1)
            controller.action('eda_connect', {'port': 'COM6'})
            controller.action('artwork_start', {})
            controller.eda.feed(packet(0, 0))
            self.assertEqual(controller.recorder.counts['eda'], 1)
            controller.action('artwork_cancel', {})


if __name__ == '__main__':
    unittest.main()
