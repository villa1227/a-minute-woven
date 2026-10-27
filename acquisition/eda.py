"""Bridge the verified GSR serial service into the shared recorder and trace."""
from skin_sigma.gsr import GsrService, list_ports


class EdaService(GsrService):
    def __init__(self, recorder, trace, root, **kwargs):
        self.recorder = recorder
        self.trace = trace
        self.record_error = None
        super().__init__(root, on_row=self._publish, **kwargs)

    def _publish(self, row):
        # Called under the GSR lock: never acquire the controller lock here.
        clock = {key: row[key] for key in ('host_monotonic_ns', 'host_utc')}
        if row['kind'] == 'sample':
            source = 'eda'
            data = {key: row.get(key) for key in (
                'seq', 'device_ms', 'segment', 'adc', 'interval_ms',
                'device_interval_ms', 'break_before', 'raw', 'raw_hex')}
            data.update(quality='received_unvalidated', unit='ADC', port=self.port,
                        stream_id=self.stream_id)
            data['device_seq'] = data.pop('seq')
        else:
            source = 'event'
            message = row.get('message', '')
            reset = (message in ('connected', 'board_boot', 'board_reset_detected', '主动断开')
                     or message.startswith('串口断连'))
            data = {'kind': 'eda_reset' if reset else 'eda_event',
                    'event_type': row['kind'], 'message': message,
                    'segment': row['segment'], 'port': self.port,
                    'raw': row.get('raw'), 'raw_hex': row.get('raw_hex')}
        self.trace.emit(source, data, clock)
        try:
            self.recorder.emit(source, data, clock)
            self.record_error = None
        except Exception as exc:
            self.record_error = '皮电记录写入失败：' + str(exc)

    def snapshot(self, after=0, include_rows=True):
        result = super().snapshot(after, include_rows)
        result['record_error'] = self.record_error
        return result
