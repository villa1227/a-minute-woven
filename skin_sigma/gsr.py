"""Independent serial acquisition; no camera/BLE or main-project imports."""
import csv
import json
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

UINT32 = 2 ** 32
HEADER = '#GSR,1,UNO,A0,10,20'
CSV_FIELDS = ('cursor', 'kind', 'host_monotonic_ns', 'host_utc', 'source',
              'segment', 'seq', 'device_ms', 'adc', 'delta_adc', 'interval_ms',
              'device_interval_ms', 'break_before', 'raw', 'raw_hex', 'message')


def parse_line(raw):
    text = raw.decode('ascii').strip()
    if text == HEADER:
        return {'kind': 'boot'}
    fields = text.split(',')
    if len(fields) != 5 or fields[:2] != ['GSR', '1']:
        raise ValueError('需要 GSR,1,序号,millis,ADC；请上传连续采样固件并使用 115200 波特率')
    if any(not value.isascii() or not value.isdigit() for value in fields[2:]):
        raise ValueError('序号、millis 和 ADC 必须是非负整数')
    seq, device_ms, adc = map(int, fields[2:])
    if seq >= UINT32 or device_ms >= UINT32 or not 0 <= adc <= 1023:
        raise ValueError('读数超出 UNO 协议范围')
    return {'kind': 'sample', 'seq': seq, 'device_ms': device_ms, 'adc': adc}


class LineFramer:
    """Bounded framing, including recovery after an oversized or broken line."""
    def __init__(self, limit=512):
        self.buffer = bytearray()
        self.limit = limit
        self.discarding = False

    def feed(self, chunk):
        lines = []
        for byte in chunk:
            if self.discarding:
                if byte == 10:
                    self.discarding = False
                continue
            self.buffer.append(byte)
            if byte == 10:
                lines.append((bytes(self.buffer), None))
                self.buffer.clear()
            elif len(self.buffer) > self.limit:
                lines.append((bytes(self.buffer), '串口行过长，丢弃至下一个换行'))
                self.buffer.clear()
                self.discarding = True
        return lines

    def finish(self):
        raw = bytes(self.buffer)
        self.buffer.clear()
        return [(raw, '断开前收到不完整串口行')] if raw else []


def list_ports():
    from serial.tools import list_ports as ports
    return [{'port': p.device, 'description': p.description, 'hwid': p.hwid}
            for p in ports.comports()]


class GsrService:
    def __init__(self, root, clock=time.monotonic_ns, serial_factory=None, on_row=None):
        self.root = Path(root)
        self.clock = clock
        self.serial_factory = serial_factory
        self.on_row = on_row
        self.lock = threading.RLock()
        self.worker = None
        self.connection = None
        self.stop_event = threading.Event()
        self.connected = False
        self.status = '未连接 Arduino'
        self.port = None
        self.recording = False
        self.record_path = None
        self._reset()

    def _reset(self):
        self.stream_id = uuid.uuid4().hex
        self.rows = deque(maxlen=10000)
        self.cursor = 0
        self.segment = 0
        self.last = None
        self.last_wire = None
        self.last_wire_ns = None
        self.last_receipt_ns = None
        self.reference = None
        self.pending_break = True
        self.framer = LineFramer()
        self.stats = dict(samples=0, duplicates=0, missing=0, parse_errors=0,
                          resets=0, time_wraps=0, sequence_wraps=0)

    def _row(self, kind, now, **fields):
        self.cursor += 1
        row = {'cursor': self.cursor, 'kind': kind, 'host_monotonic_ns': now,
               'host_utc': datetime.now(timezone.utc).isoformat(timespec='microseconds'),
               'source': 'eda', 'segment': self.segment, **fields}
        self.rows.append(row)
        if self.on_row:
            self.on_row(dict(row))
        if self.recording:
            self.raw_file.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')
            self.raw_file.flush()
            self.csv_writer.writerow({key: row.get(key) for key in CSV_FIELDS})
            self.csv_file.flush()
        return row

    def connect(self, port):
        if not isinstance(port, str) or not port.strip():
            raise ValueError('请选择串口')
        with self.lock:
            if self.connected or self.worker and self.worker.is_alive():
                raise ValueError('请先断开当前串口')
            if self.recording:
                raise ValueError('请先停止记录')
            factory = self.serial_factory
            if factory is None:
                import serial
                factory = serial.Serial
            connection = factory(port=port, baudrate=115200, timeout=.2)
            self._reset()
            self.port = port
            self.connection = connection
            self.connected = True
            self.stop_event = threading.Event()
            self.status = '已连接；等待固件数据（打开串口可能使 UNO 重启）'
            self._row('event', self.clock(), message='connected')
            self.worker = threading.Thread(target=self._collect, args=(connection, self.stop_event), daemon=True)
            self.worker.start()

    def _collect(self, connection, stop_event):
        reason = '主动断开'
        try:
            while not stop_event.is_set():
                chunk = connection.read(max(1, min(connection.in_waiting, 4096)))
                if chunk:
                    self.feed(chunk)
        except Exception as exc:
            reason = '串口断连：' + str(exc)
        finally:
            try:
                connection.close()
            finally:
                with self.lock:
                    for raw, error in self.framer.finish():
                        self._ingest(raw, error)
                    self.connected = False
                    self.pending_break = True
                    self.reference = None
                    self.status = reason
                    self._row('event', self.clock(), message=reason)
                    if self.recording:
                        self.stop_recording(reason)

    def disconnect(self):
        with self.lock:
            self.stop_event.set()
            worker = self.worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout=2)
            if worker.is_alive():
                raise RuntimeError('串口尚未关闭，请稍后重试')

    def feed(self, chunk):
        with self.lock:
            for raw, error in self.framer.feed(chunk):
                self._ingest(raw, error)

    def _ingest(self, raw, framing_error=None):
        now = self.clock()
        original = {'raw': raw.decode('ascii', errors='replace'), 'raw_hex': raw.hex()}
        try:
            if framing_error:
                raise ValueError(framing_error)
            parsed = parse_line(raw)
        except (ValueError, UnicodeError) as exc:
            self.stats['parse_errors'] += 1
            self.pending_break = True
            self._row('error', now, **original, message=str(exc))
            self.status = '报文无效：' + str(exc)
            return
        if parsed['kind'] == 'boot':
            if self.last_wire is not None:
                self.stats['resets'] += 1
                self.segment += 1
            self.last_wire = self.last_wire_ns = None
            self.last = None
            self.reference = None
            self.pending_break = True
            self._row('event', now, **original, message='board_boot')
            return
        seq, ms = parsed['seq'], parsed['device_ms']
        interval = None if self.last_receipt_ns is None else (now - self.last_receipt_ns) / 1e6
        self.last_receipt_ns = now
        device_interval = None
        if self.last_wire is not None:
            previous_seq, previous_ms = self.last_wire
            seq_delta = (seq - previous_seq) % UINT32
            ms_delta = (ms - previous_ms) % UINT32
            if seq_delta == 0 and ms == previous_ms:
                self.stats['duplicates'] += 1
                self._row('duplicate', now, **original, seq=seq, device_ms=ms, adc=parsed['adc'],
                          interval_ms=interval, message='duplicate_frame')
                return
            # A small modular step at the uint32 limit is wrap, a backward
            # jump elsewhere is a reset. Both create separate curve segments.
            seq_wrap = seq < previous_seq and previous_seq > UINT32 - 10000 and seq_delta < 10000
            time_wrap = ms < previous_ms and previous_ms > UINT32 - 60000 and ms_delta < 60000
            reset = (seq_delta == 0 or seq_delta >= UINT32 // 2
                     or ms_delta == 0 or ms_delta >= UINT32 // 2
                     or seq < previous_seq and not seq_wrap
                     or ms < previous_ms and not time_wrap)
            if reset:
                self.segment += 1
                self.stats['resets'] += 1
                self.reference = None
                self.pending_break = True
                self._row('event', now, message='board_reset_detected')
            else:
                device_interval = ms_delta
                if seq_delta > 1:
                    self.stats['missing'] += seq_delta - 1
                    self.pending_break = True
                if seq_wrap or time_wrap:
                    self.segment += 1
                    self.pending_break = True
                    self.stats['sequence_wraps'] += int(seq_wrap)
                    self.stats['time_wraps'] += int(time_wrap)
                    self._row('event', now, message='counter_wrap')
                if (self.last_wire_ns is not None and now - self.last_wire_ns > 1e9) or ms_delta > 1000:
                    self.pending_break = True
        self.last_wire = (seq, ms)
        self.last_wire_ns = now
        self.stats['samples'] += 1
        self.last = self._row('sample', now, **original, seq=seq, device_ms=ms, adc=parsed['adc'],
                             delta_adc=None if self.reference is None else parsed['adc'] - self.reference,
                             interval_ms=interval, device_interval_ms=device_interval,
                             break_before=self.pending_break)
        self.pending_break = False
        self.status = '正在接收连续皮电数据'

    def _fresh(self, now):
        return bool(self.connected and self.last and now - self.last['host_monotonic_ns'] < 1e9)

    def set_reference(self):
        with self.lock:
            now = self.clock()
            samples = [r['adc'] for r in self.rows if r['kind'] == 'sample'
                       and r['segment'] == self.segment and now - r['host_monotonic_ns'] <= 5e9]
            if not self._fresh(now) or len(samples) < 20:
                raise ValueError('需要最新 5 秒内至少 20 个有效样本，且数据仍在更新')
            self.reference = median(samples)
            self._row('event', now, message='reference_adc=' + str(self.reference))
            return self.reference

    def snapshot(self, after=0, include_rows=True):
        with self.lock:
            now = self.clock()
            recent = [r for r in self.rows if r['kind'] == 'sample'
                      and r['segment'] == self.segment and now - r['host_monotonic_ns'] <= 5e9]
            rate = None
            if len(recent) > 1:
                span = (recent[-1]['host_monotonic_ns'] - recent[0]['host_monotonic_ns']) / 1e9
                rate = (len(recent) - 1) / span if span > 0 else None
            intervals = [r['interval_ms'] for r in recent if r.get('interval_ms') is not None]
            device_intervals = [r['device_interval_ms'] for r in recent
                                if r.get('device_interval_ms') is not None and not r['break_before']]
            return {'stream_id': self.stream_id, 'cursor': self.cursor, 'connected': self.connected,
                    'status': self.status, 'port': self.port, 'baudrate': 115200, 'target_hz': 20,
                    'now_ns': now, 'fresh': self._fresh(now),
                    'age_s': None if not self.last else (now - self.last['host_monotonic_ns']) / 1e9,
                    'latest': dict(self.last) if self.last else None, 'reference_adc': self.reference,
                    'rate_hz': rate if self._fresh(now) else None,
                    'interval_median_ms': median(intervals) if intervals else None,
                    'interval_max_ms': max(intervals) if intervals else None,
                    'device_interval_median_ms': median(device_intervals) if device_intervals else None,
                    'stats': dict(self.stats), 'recording': self.recording,
                    'record_path': str(self.record_path) if self.record_path else None,
                    'downloadable': self.record_path is not None and not self.recording,
                    'truncated': bool(self.rows and after and after < self.rows[0]['cursor'] - 1),
                    'rows': [dict(r) for r in self.rows if include_rows and r['cursor'] > after
                             and now - r['host_monotonic_ns'] <= 60e9]}

    def start_recording(self):
        with self.lock:
            if self.recording:
                raise ValueError('已经在记录')
            if not self._fresh(self.clock()):
                raise ValueError('请先连接并收到有效皮电数据')
            folder = self.root / (datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:6])
            folder.mkdir(parents=True)
            self.raw_file = (folder / 'samples.jsonl').open('w', encoding='utf-8')
            try:
                self.csv_file = (folder / 'eda.csv').open('w', encoding='utf-8-sig', newline='')
            except Exception:
                self.raw_file.close()
                raise
            self.csv_writer = csv.DictWriter(self.csv_file, fieldnames=CSV_FIELDS)
            self.csv_writer.writeheader()
            self.record_path = folder
            self.record_meta = {'schema_version': 1, 'source': 'eda', 'protocol': 'GSR,1,seq,millis,adc',
                                'port': self.port, 'baudrate': 115200, 'board': 'UNO', 'pin': 'A0',
                                'adc_bits': 10, 'target_hz': 20, 'unit': 'ADC', 'calibrated': False,
                                'reference_adc': self.reference, 'stream_id': self.stream_id,
                                'started_utc': datetime.now(timezone.utc).isoformat(),
                                'start_stats': dict(self.stats),
                                'clock': 'host receipt monotonic ns and UTC; device millis is not synchronized'}
            try:
                self._save_meta()
            except Exception:
                self.raw_file.close()
                self.csv_file.close()
                self.record_path = None
                raise
            self.recording = True
            self._row('event', self.clock(), message='recording_started')

    def _save_meta(self):
        path = self.record_path / 'metadata.json'
        temporary = path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self.record_meta, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(path)

    def stop_recording(self, reason='主动停止记录'):
        with self.lock:
            if not self.recording:
                raise ValueError('当前没有记录')
            try:
                self._row('event', self.clock(), message='recording_stopped: ' + reason)
            finally:
                self.recording = False
                self.raw_file.close()
                self.csv_file.close()
                self.record_meta.update(ended_utc=datetime.now(timezone.utc).isoformat(),
                                        stop_reason=reason, end_stats=dict(self.stats),
                                        record_stats={k: self.stats[k] - self.record_meta['start_stats'][k]
                                                      for k in self.stats})
                self._save_meta()

    def marker(self, label):
        with self.lock:
            if not self.recording:
                raise ValueError('请先开始记录')
            if not isinstance(label, str) or not label.strip() or len(label) > 200:
                raise ValueError('阶段标记需要 1～200 个字符')
            self._row('marker', self.clock(), message=label.strip())

    def export_csv(self):
        with self.lock:
            if not self.record_path or self.recording:
                raise ValueError('请先停止记录，再下载 CSV')
            return (self.record_path / 'eda.csv').read_bytes(), self.record_path.name + '_eda.csv'

    def close(self):
        self.disconnect()
        with self.lock:
            if self.recording:
                self.stop_recording('服务关闭')
