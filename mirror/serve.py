"""Unified loopback UI: reuse the collector or run its Controller in-process."""
import json
from pathlib import Path
import re
import secrets
import threading
import sys
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
UPSTREAM = 'http://127.0.0.1:8765'
STATIC = {p.name for p in ROOT.iterdir() if p.suffix in ('.js', '.css')}
COMMANDS = {'camera_start', 'camera_stop', 'roi', 'scan', 'heart_connect', 'heart_stop',
            'eda_scan', 'eda_connect', 'eda_stop', 'expression_start', 'expression_stop',
            'record_start', 'record_stop', 'marker'}
STATE_KEYS = ('camera_alive', 'camera_fresh', 'heart_alive', 'heart_fresh', 'eda', 'expression',
              'face_camera_alive','face_camera_info',
              'cameras', 'camera_sample', 'camera_metrics', 'devices', 'scanning', 'messages',
              'eda_ports', 'eda_ports_error', 'recording', 'artwork_running', 'counts', 'elapsed_s', 'note')


def packet(state, trace, after, stream_id, mode):
    reset = after is None or trace['stream_id'] != stream_id
    return {'connected': True, 'error': None, 'reset': reset, 'mode': mode,
            'state': {key: state.get(key) for key in STATE_KEYS},
            'trace': {**trace, 'rows': [] if reset else trace['rows']}}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'Redirects are disabled', headers, fp)


class Bridge:
    def __init__(self):
        self.token = None
        self.lock = threading.Lock()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def read(self, path, auth=True):
        request = urllib.request.Request(UPSTREAM + path, headers={'X-Session-Token': self.token or ''} if auth else {})
        with self.opener.open(request, timeout=2) as response:
            if response.url != UPSTREAM + path:
                raise ValueError('Unexpected collector redirect')
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError('Collector response too large')
            return json.loads(data) if auth else data.decode('utf-8')

    def acquire_token(self):
        match = re.search(r"const token='([^']+)'", self.read('/', False))
        if not match:
            raise ValueError('Collector session token unavailable')
        self.token = match[1]

    def snapshot(self, after=None, stream_id=None):
        with self.lock:
            for attempt in range(2):
                try:
                    if not self.token:
                        self.acquire_token()
                    state = self.read('/api/state')
                    trace = self.read('/api/trace?after=' + str(after or 0))
                    return packet(state, trace, after, stream_id, 'shared')
                except urllib.error.HTTPError as exc:
                    self.token = None
                    exc.close()
                    if exc.code == 403 and attempt == 0:
                        continue
                    raise
                except Exception:
                    self.token = None
                    raise

    def action(self, command, data):
        if command not in COMMANDS:
            raise ValueError('不支持此设备操作')
        with self.lock:
            # Do not retry POST after dispatch: a lost reply must not start a duplicate action.
            self.acquire_token()
            request = urllib.request.Request(UPSTREAM+'/api/'+command,
                data=json.dumps(data).encode(), headers={'X-Session-Token':self.token,
                'Origin':UPSTREAM,'Content-Type':'application/json'})
            try:
                with self.opener.open(request, timeout=5) as response:
                    return json.loads(response.read(65536))
            except urllib.error.HTTPError as exc:
                try:
                    error = json.loads(exc.read(65536)).get('error', '设备操作失败')
                finally:
                    exc.close()
                raise ValueError(error) from None

    def frame(self, source='eyes'):
        with self.lock:
            if not self.token:
                self.acquire_token()
            request = urllib.request.Request(UPSTREAM+'/api/frame?source='+source,headers={'X-Session-Token':self.token})
            try:
                with self.opener.open(request,timeout=2) as response:
                    return response.read(4*1024*1024) if response.status==200 else None
            except urllib.error.HTTPError as exc:
                if exc.code==403:self.token=None
                exc.close()
                raise

    def close(self):
        pass  # An existing collector is owned by its original process.


class LocalBridge:
    def __init__(self, controller):
        self.controller = controller

    def snapshot(self, after=None, stream_id=None):
        return packet(self.controller.snapshot(), self.controller.trace.snapshot(after or 0), after, stream_id, 'integrated')

    def action(self, command, data):
        if command not in COMMANDS:
            raise ValueError('不支持此设备操作')
        self.controller.action(command, data)
        return {'ok':True}

    def frame(self, source='eyes'):
        return self.controller.frame(source)

    def close(self):
        self.controller.close()


def select_bridge():
    remote = Bridge()
    try:
        remote.snapshot()
        print('Reusing existing collector on 8765.', flush=True)
        return remote
    except Exception:
        sys.path.insert(0, str(ROOT.parent))
        from server import Controller
        controller = Controller()
        controller.enumerate_cameras()
        controller.enumerate_eda_ports()
        print('Collector integrated in mirror service; no second startup needed.', flush=True)
        return LocalBridge(controller)
def make_handler(bridge, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, status, body, mime='application/json; charset=utf-8'):
            self.send_response(status)
            for name, value in {'Content-Type': mime, 'Content-Length': str(len(body)), 'Cache-Control': 'no-store',
                                'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY'}.items():
                self.send_header(name, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_GET(self):
            hosts = (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')
            if self.headers.get('Host') not in hosts:
                return self.send(403, b'{}')
            url = urlsplit(self.path)
            if url.path in ('/', '/background', '/background/'):
                page = 'index.html' if url.path=='/' else 'background.html'
                body = (ROOT / page).read_text(encoding='utf-8').replace('__MIRROR_TOKEN__', token)
                return self.send(200, body.encode(), 'text/html; charset=utf-8')
            if url.path[1:] in STATIC:
                path = ROOT / url.path[1:]
                return self.send(200, path.read_bytes(), 'text/css' if path.suffix == '.css' else 'text/javascript')
            if url.path == '/woven-renderer.js':
                return self.send(200,(ROOT.parent/'web'/'weave.js').read_bytes(),'text/javascript')
            if url.path not in ('/api/sensors', '/api/device-frame'):
                return self.send(404, b'{}')
            if self.headers.get('X-Mirror-Token') != token:
                return self.send(403, b'{}')
            origin = self.headers.get('Origin')
            if origin and origin not in ('http://' + h for h in hosts):
                return self.send(403, b'{}')
            if url.path == '/api/device-frame':
                try:
                    frame = bridge.frame(parse_qs(url.query).get('source',['eyes'])[0])
                    return self.send(200 if frame else 204, frame or b'', 'image/jpeg')
                except Exception:
                    return self.send(503, b'{}')
            try:
                query = parse_qs(url.query)
                after = int(query['after'][0]) if 'after' in query else None
                if after is not None and after < 0:
                    raise ValueError()
                stream_id = query.get('stream_id', [None])[0]
            except (ValueError, KeyError):
                return self.send(400, b'{"error":"Invalid cursor"}')
            try:
                result = bridge.snapshot(after, stream_id)
            except Exception:
                # Never expose upstream tokens, paths or transport internals.
                result = {'connected': False, 'error': '采集服务未连接；若复用了原服务，请重新启动原服务。描摹仍可继续。', 'state': None, 'trace': None}
            self.send(200, json.dumps(result, ensure_ascii=False, allow_nan=False).encode())

        def do_POST(self):
            self.connection.settimeout(5)
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=16384:raise ValueError()
                body=self.rfile.read(size)
            except (ValueError, OSError):
                self.close_connection=True
                return self.send(400,b'{"error":"Invalid request body"}')
            hosts = (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')
            if (self.headers.get('Host') not in hosts or self.headers.get('X-Mirror-Token') != token
                    or self.headers.get('Origin') not in ('http://' + h for h in hosts)):
                self.close_connection=True
                return self.send(403,b'{}')
            command = urlsplit(self.path).path.removeprefix('/api/device/')
            if not self.path.startswith('/api/device/') or command not in COMMANDS:
                self.close_connection=True
                return self.send(404,b'{}')
            try:
                if self.headers.get_content_type() != 'application/json':
                    raise ValueError('无效的请求长度或类型')
                data=json.loads(body)
                if not isinstance(data,dict):raise ValueError('操作参数必须是对象')
                result=bridge.action(command,data)
                self.send(200,json.dumps(result).encode())
            except ValueError as exc:
                self.send(400,json.dumps({'error':str(exc)},ensure_ascii=False).encode())
            except Exception:
                self.send(503,'{"error":"设备服务暂不可用，请刷新后检查设备状态"}'.encode())

    return Handler


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 8767), make_handler(None, secrets.token_urlsafe(32)))
    bridge = None
    try:
        bridge = select_bridge()
        server.RequestHandlerClass = make_handler(bridge,secrets.token_urlsafe(32))
        print('Cyber mirror: http://127.0.0.1:8767/', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if bridge:bridge.close()


if __name__ == '__main__':
    main()
