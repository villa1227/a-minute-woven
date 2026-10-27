import json
import tempfile
import unittest
from acquisition.core import Recorder, stamp
from acquisition.live import LiveTrace
from acquisition.interfaces import SamplePublisher


class PublisherTests(unittest.TestCase):
    def test_live_without_recording_and_immutable_snapshot(self):
        rec, trace = Recorder(), LiveTrace()
        publisher = SamplePublisher(rec, trace)
        data = {'unit': 'C', 'values': [20]}
        publisher.publish('temperature', data)
        data['values'][0] = 100
        self.assertEqual(trace.snapshot()['rows'][0]['data']['values'], [20])
        self.assertFalse(rec.active)
        for source, data in [('Bad/name', {}), ('x', {'x': float('nan')}), ('x', [])]:
            with self.assertRaises(ValueError): publisher.publish(source, data)
        with self.assertRaises(ValueError): publisher.publish('eda', {}, {'host_monotonic_ns': True,'host_utc':'bad'})
        self.assertEqual(len(trace.snapshot()['rows']), 1)

    def test_custom_channel_jsonl_and_events(self):
        with tempfile.TemporaryDirectory() as root:
            rec, trace = Recorder(), LiveTrace()
            pub = SamplePublisher(rec, trace)
            rec.start(root, {'sensor': 'custom'})
            try:
                clock = stamp()
                pub.publish('temperature', {'value': 20, 'unit': 'C'}, clock)
                pub.event('temperature_reset', {'message':'disconnected'})
            finally: rec.stop()
            rows = [json.loads(l) for l in (rec.path/'samples.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(rows[1]['source'],'temperature')
            self.assertEqual(rows[1]['host_monotonic_ns'],clock['host_monotonic_ns'])
            self.assertEqual(rows[2]['data']['kind'],'temperature_reset')
            self.assertEqual(len(trace.snapshot()['rows']),2)
