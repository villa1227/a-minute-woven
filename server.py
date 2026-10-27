"""Loopback-only acquisition UI, with no cloud services or browser sensor permissions."""
import asyncio
import json
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / '.deps'))
import cv2
from acquisition.camera import CameraWorker
from acquisition.core import Recorder
from acquisition.heart import HeartWorker, scan_devices
from acquisition.live import LiveTrace
from acquisition.eda import EdaService, list_ports
from acquisition.artwork import ArtworkSession, valid_eye, valid_heart


class Controller:
    def __init__(self):
        self.lock = threading.RLock()
        self.recorder = Recorder()
        self.artwork = ArtworkSession(self.recorder)
        self.trace = LiveTrace()
        self.eda = EdaService(self.recorder, self.trace, ROOT / 'diagnostics' / 'gsr')
        self.eda_ports = []
        self.eda_ports_error = None
        self.camera = self.heart = None
        self.devices = []
        self.cameras = []
        self.scanning = False
        self.messages = {'camera': '摄像头未打开', 'heart': '手环未连接'}
        self.last_hr = None
        self.last_hr_clock = None
        self.selected_device = None
        self.note = '尚未记录'

    def enumerate_cameras(self):
        try:
            from pygrabber.dshow_graph import FilterGraph
            self.cameras = [{'index': i, 'name': name} for i, name in enumerate(FilterGraph().get_input_devices())]
        except Exception as exc:
            self.cameras = [{'index': i, 'name': '摄像头 ' + str(i)} for i in range(3)]
            self.messages['camera'] = '无法枚举名称，可按编号打开：' + str(exc)

    def status(self, sensor, message):
        with self.lock:
            self.messages[sensor] = message
            try:
                self.recorder.emit('event', {'kind': 'sensor_status', 'sensor': sensor, 'message': message})
            except Exception as exc:
                self.note = '记录写入失败，请停止记录：' + str(exc)

    def enumerate_eda_ports(self):
        try:
            self.eda_ports = list_ports()
            self.eda_ports_error = None
        except Exception as exc:
            self.eda_ports = []
            self.eda_ports_error = '无法枚举串口，请检查 pyserial 安装：' + str(exc)

    def on_hr(self, sample, clock):
        self.trace.emit('heart_rate', sample, clock)
        with self.lock:
            self.last_hr, self.last_hr_clock = sample, clock
            self.messages['heart'] = '已接收到真实心率通知'

    def on_camera(self, sample, clock):
        self.trace.emit('camera', sample, clock)

    def snapshot(self):
        with self.lock:
            now = time.monotonic_ns()
            cam_alive = bool(self.camera and self.camera.is_alive())
            hr_alive = bool(self.heart and self.heart.is_alive())
            latest = None
            if self.camera:
                with self.camera.lock:
                    latest = self.camera.latest
            camera_sample = latest[1] if latest else None
            camera_age = (now-latest[2]['host_monotonic_ns'])/1e9 if latest else None
            hr_age = (now-self.last_hr_clock['host_monotonic_ns'])/1e9 if self.last_hr_clock else None
            eda_state = self.eda.snapshot(include_rows=False)
            with self.recorder.lock:
                recording = self.recorder.active
                counts = dict(self.recorder.counts) if hasattr(self.recorder, 'counts') else {}
                elapsed = (now-self.recorder.origin)/1e9 if recording else None
            return {'messages': dict(self.messages), 'cameras': self.cameras,
                    'devices': [info for _, info in self.devices], 'scanning': self.scanning,
                    'camera_alive': cam_alive, 'heart_alive': hr_alive,
                    'camera_sample': camera_sample, 'camera_age_s': camera_age,
                    'camera_fresh': bool(cam_alive and camera_age is not None and camera_age < 2),
                    'heart_sample': self.last_hr, 'heart_age_s': hr_age,
                    'heart_fresh': bool(hr_alive and hr_age is not None and hr_age < 5),
                    'eda': eda_state, 'eda_ports': self.eda_ports, 'eda_ports_error': self.eda_ports_error,
                    'recording': recording, 'counts': counts, 'elapsed_s': elapsed,
                    'artwork_running': self.artwork.active,
                    'path': str(self.recorder.path) if self.recorder.path else None, 'note': self.note}

    def frame(self):
        worker = self.camera
        if not worker:
            return None
        with worker.lock:
            latest = worker.latest
        if not latest:
            return None
        frame, sample, _ = latest
        frame = frame.copy()
        for side, eye in sample['eyes'].items():
            color = (0, 210, 255) if side == 'image_left' else (255, 190, 70)
            if eye['roi']:
                x, y, w, h = eye['roi']
                cv2.rectangle(frame, (x, y), (x+w, y+h), color, 2)
                cv2.putText(frame, 'IMG-L' if side == 'image_left' else 'IMG-R', (x, max(18, y-5)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
            if eye['candidate_center_px']:
                center = tuple(round(v) for v in eye['candidate_center_px'])
                a, b, angle = eye['candidate_ellipse_px']
                cv2.ellipse(frame, center, (max(1, round(a/2)), max(1, round(b/2))), angle, 0, 360, (70, 255, 70), 1)
        ok, data = cv2.imencode('.jpg', frame)
        return data.tobytes() if ok else None

    def action(self, command, data):
        with self.lock:
            if command == 'eda_scan':
                self.enumerate_eda_ports()
                return
            if command == 'eda_connect':
                if self.recorder.active:
                    raise ValueError('请先结束创作或记录，再连接或更换皮电串口')
                self.enumerate_eda_ports()
                port = data.get('port')
                if port not in [item['port'] for item in self.eda_ports]:
                    raise ValueError('未找到所选串口，请连接 Arduino 后刷新串口')
                try:
                    self.eda.connect(port)
                except Exception as exc:
                    raise ValueError('皮电连接失败，请关闭 IDE 串口监视器或独立绘图窗口：' + str(exc)) from exc
                return
            if command == 'eda_stop':
                self.eda.disconnect()
                return
            if self.artwork.active and command in ('roi', 'camera_start', 'record_start', 'record_stop'):
                raise ValueError('创作期间固定眼区与记录设置；如需调整，请先取消创作')
            if command == 'artwork_start':
                state = self.snapshot()
                self.artwork.start(ROOT / 'recordings', self.record_settings(state))
                self.note = '60 秒创作已开始，系统将自动结束并保存记录'
            elif command == 'artwork_cancel':
                self.artwork.cancel()
                self.note = '已取消创作，原始记录已保留'
            elif command == 'camera_start':
                if self.recorder.active:
                    raise ValueError('请先停止记录，再更换摄像头设置')
                if self.camera and self.camera.is_alive():
                    raise ValueError('摄像头已打开，请先关闭')
                index, rate = int(data.get('index', 1)), float(data.get('rate', 10))
                if index < 0 or not 1 <= rate <= 60:
                    raise ValueError('摄像头编号须为非负整数，采样率为 1–60 Hz')
                self.trace.emit('event', {'kind': 'camera_reset'})
                self.camera = CameraWorker(index, cv2.CAP_DSHOW, rate, self.recorder, self.status, bool(data.get('save_frames')), self.on_camera)
                self.messages['camera'] = '正在打开摄像头…'
                self.camera.start()
            elif command == 'camera_stop':
                if self.camera:
                    self.camera.stop_event.set()
                    self.messages['camera'] = '正在关闭摄像头…'
            elif command == 'roi':
                if not self.camera or not self.camera.is_alive():
                    raise ValueError('请先打开摄像头')
                roi = data.get('roi')
                side = data.get('side')
                if side not in ('image_left', 'image_right', 'both'):
                    raise ValueError('请选择画面左/右眼区')
                if side == 'both' and roi is not None:
                    raise ValueError('两侧恢复自动时 ROI 必须为空')
                if roi is not None:
                    if not isinstance(roi, list) or len(roi) != 4:
                        raise ValueError('ROI 需要 x,y,width,height')
                    roi = [int(v) for v in roi]
                    if min(roi[:2]) < 0 or min(roi[2:]) < 20:
                        raise ValueError('请至少框选 20×20 像素的单只眼睛')
                self.camera.set_roi(roi, side)
                self.trace.emit('event', {'kind': 'camera_roi_changed', 'side': side})
            elif command == 'scan':
                if self.scanning or (self.heart and self.heart.is_alive()):
                    raise ValueError('正在扫描或连接中，请先断开手环')
                self.scanning = True
                self.messages['heart'] = '正在扫描，约 8 秒…'
                threading.Thread(target=self._scan, daemon=True).start()
            elif command == 'heart_connect':
                if self.heart and self.heart.is_alive():
                    raise ValueError('手环已连接或正在连接')
                address = str(data.get('address', ''))
                pair = next((pair for pair in self.devices if pair[1]['address'] == address), None)
                if not pair:
                    raise ValueError('请先扫描并选择你的手环')
                self.selected_device = pair[1]
                self.last_hr = self.last_hr_clock = None
                self.trace.emit('event', {'kind': 'heart_reset'})
                self.heart = HeartWorker(pair[0], self.recorder, self.status, self.on_hr)
                self.heart.start()
            elif command == 'heart_stop':
                if self.heart:
                    self.heart.stop_event.set()
            elif command == 'record_start':
                state = self.snapshot()
                if not state['camera_fresh'] and not state['heart_fresh'] and not state['eda']['fresh']:
                    raise ValueError('尚无实时数据，请先接入摄像头、心率或皮电')
                self.recorder.start(ROOT / 'recordings', self.record_settings(state))
                self.note = '记录中。可以添加 baseline、task_start 等阶段标记。'
            elif command == 'record_stop':
                self.recorder.stop()
                self.note = '已停止并保存'
            elif command == 'marker':
                if not self.recorder.active:
                    raise ValueError('请先开始记录')
                label = str(data.get('label', '')).strip()[:200]
                if not label:
                    raise ValueError('标记不能为空')
                self.recorder.emit('marker', {'label': label})
                self.trace.emit('marker', {'label': label})
                self.note = '已添加标记：' + label
            else:
                raise ValueError('未知操作')

    def record_settings(self, state):
        return {'camera': self.camera.camera_info if state['camera_fresh'] else None,
                'camera_target_hz': self.camera.rate if state['camera_fresh'] else None,
                'camera_rois': dict(self.camera.rois) if state['camera_fresh'] else None,
                'eye_coordinate_system': 'unmirrored_image_left_right',
                'save_sampled_frames': self.camera.save_frames if state['camera_fresh'] else False,
                'ble_device': self.selected_device,
                'ble_services': getattr(self.heart, 'service_info', None),
                'eda': {'port': state['eda']['port'], 'baudrate': 115200, 'target_hz': 20,
                        'board': 'UNO', 'pin': 'A0', 'unit': 'ADC', 'calibrated': False,
                        'protocol': 'GSR,1,seq,millis,adc', 'stream_id': state['eda']['stream_id']},
                'active_sensors': {'camera': state['camera_fresh'], 'heart': state['heart_fresh'],
                                   'eda': state['eda']['fresh']}}

    def _scan(self):
        try:
            devices = asyncio.run(scan_devices())
            with self.lock:
                self.devices = sorted(devices, key=lambda p: (not p[1]['advertises_hr'], -p[1]['rssi']))
                self.messages['heart'] = f'发现 {len(devices)} 个设备。请选择 Xiaomi Smart Band 10。'
        except Exception as exc:
            self.status('heart', '扫描失败：' + str(exc))
        finally:
            with self.lock:
                self.scanning = False

    def close(self):
        self.eda.close()
        self.artwork.close()
        for worker in (self.camera, self.heart):
            if worker:
                worker.stop_event.set()
        for worker in (self.camera, self.heart):
            if worker and worker.is_alive():
                worker.join(timeout=5)
        self.recorder.stop()


def main():
    controller = Controller()
    controller.enumerate_cameras()
    controller.enumerate_eda_ports()
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, code, body, mime='application/json; charset=utf-8'):
            self.send_response(code)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def valid_host(self):
            return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, b'{}')
            path = urlsplit(self.path).path
            if path == '/':
                body = (ROOT / 'web' / 'index.html').read_text(encoding='utf-8').replace('__API_TOKEN__', token)
                return self.send(200, body.encode('utf-8'), 'text/html; charset=utf-8')
            if path in ('/feedback.js', '/weave.js', '/artwork.js', '/eda.js'):
                return self.send(200, (ROOT / 'web' / path[1:]).read_bytes(), 'text/javascript; charset=utf-8')
            if self.headers.get('X-Session-Token') != token:
                return self.send(403, b'{}')
            if path == '/api/state':
                return self.send(200, json.dumps(controller.snapshot(), ensure_ascii=False, allow_nan=False).encode('utf-8'))
            if path == '/api/artwork':
                return self.send(200, json.dumps(controller.artwork.snapshot(include_preview=True), ensure_ascii=False, allow_nan=False).encode('utf-8'))
            if path == '/api/trace':
                try:
                    after = max(0, int(parse_qs(urlsplit(self.path).query).get('after', ['0'])[0]))
                except ValueError:
                    return self.send(400, b'{"error":"Invalid cursor"}')
                return self.send(200, json.dumps(controller.trace.snapshot(after), ensure_ascii=False, allow_nan=False).encode('utf-8'))
            if path == '/api/frame':
                frame = controller.frame()
                return self.send(200 if frame else 204, frame or b'', 'image/jpeg')
            return self.send(404, b'{}')

        def do_POST(self):
            expected = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
            if not self.valid_host() or self.headers.get('X-Session-Token') != token or self.headers.get('Origin') not in expected:
                return self.send(403, b'{}')
            try:
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size <= 16384:
                    raise ValueError('无效请求长度')
                data = json.loads(self.rfile.read(size))
                controller.action(urlsplit(self.path).path.removeprefix('/api/'), data)
                return self.send(200, b'{"ok":true}')
            except Exception as exc:
                return self.send(400, json.dumps({'error': str(exc)}, ensure_ascii=False).encode('utf-8'))

    server = ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
    print('Acquisition UI: http://127.0.0.1:8765  (Ctrl+C to stop)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        controller.close()


if __name__ == '__main__':
    main()
