import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('mirror_serve', Path(__file__).resolve().parents[1]/'mirror'/'serve.py')
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class BridgeTests(unittest.TestCase):
    def test_initial_skip_cursor_duplicates_and_new_stream(self):
        b = serve.Bridge()
        trace = {'stream_id':'a','cursor':30,'now_s':5,'rows':[{'seq':30,'source':'camera'}]}
        def read(path, auth=True):
            if path == '/': return "const token='private-upstream'"
            if path == '/api/state': return {'camera_alive':True,'secret':'omit'}
            return trace
        b.read = read
        first = b.snapshot()
        self.assertEqual(first['trace']['rows'], [])
        self.assertNotIn('secret', first['state'])
        self.assertEqual(b.snapshot(29, 'a')['trace']['rows'], trace['rows'])
        self.assertTrue(b.snapshot(29, 'other')['reset'])
        self.assertEqual(b.snapshot(29, 'other')['trace']['rows'], [])

    def test_403_refreshes_original_token_then_retries(self):
        b = serve.Bridge(); b.token = 'old'; tokens = []
        def read(path, auth=True):
            if path == '/': return "const token='new'"
            tokens.append(b.token)
            if b.token == 'old': raise urllib.error.HTTPError('',403,'',{},None)
            if path == '/api/state': return {}
            return {'stream_id':'new','cursor':1,'now_s':0,'rows':[]}
        b.read = read
        self.assertTrue(b.snapshot(20, 'old')['reset'])
        self.assertEqual(b.token, 'new'); self.assertEqual(tokens[0], 'old')

    def test_http_host_token_origin_and_allowlisted_device_commands(self):
        bridge = serve.Bridge()
        with patch.object(bridge, 'snapshot', return_value={'connected':True}) as snapshot:
            server = ThreadingHTTPServer(('127.0.0.1',0), serve.make_handler(bridge,'local-token'))
            thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            base = 'http://127.0.0.1:'+str(server.server_port)
            def request(path, headers=None, data=None):
                try:
                    with opener.open(urllib.request.Request(base+path,headers=headers or {},data=data)) as response:
                        return response.status,response.read()
                except urllib.error.HTTPError as exc:
                    status, body = exc.code, exc.read()
                    exc.close()
                    return status, body
            try:
                status,html=request('/');self.assertEqual(status,200);self.assertIn(b'local-token',html)
                status,background=request('/background');self.assertEqual(status,200);self.assertIn(b'background-tracing.js',background);self.assertIn(b'local-token',background)
                self.assertNotIn(b'background-tracing.js',html)
                self.assertEqual(request('/background/')[0],200)
                self.assertEqual(request('/api/sensors')[0],403)
                self.assertEqual(request('/api/sensors',{'X-Mirror-Token':'local-token','Origin':'http://evil.test'})[0],403)
                self.assertEqual(request('/api/sensors',{'X-Mirror-Token':'local-token','Host':'evil.test'})[0],403)
                self.assertEqual(request('/api/sensors',{'X-Mirror-Token':'local-token'})[0],200)
                self.assertEqual(request('/api/sensors?after=-1',{'X-Mirror-Token':'local-token'})[0],400)
                self.assertEqual(request('/serve.py')[0],404)
                self.assertEqual(request('/api/record_start',data=b'{}')[0],403)
                headers={'X-Mirror-Token':'local-token','Origin':base,'Content-Type':'application/json'}
                self.assertEqual(request('/api/device/unknown',headers,data=b'{}')[0],404)
                self.assertEqual(request('/api/device/scan',{'X-Mirror-Token':'local-token'},data=b'{}')[0],403)
                self.assertEqual(request('/api/device/scan',headers,data=b'[]')[0],400)
                with patch.object(bridge,'action',return_value={'ok':True}) as action:
                    self.assertEqual(request('/api/device/expression_start',headers,data=b'{"rate":5}')[0],200)
                    action.assert_called_once_with('expression_start',{'rate':5})
                with patch.object(bridge,'frame',return_value=b'jpeg'):
                    self.assertEqual(request('/api/device-frame',headers)[1],b'jpeg')
                self.assertEqual(snapshot.call_count,1)
            finally: server.shutdown();server.server_close();thread.join()

    def test_integrated_controller_reuse_and_owned_cleanup(self):
        from unittest.mock import Mock
        controller=Mock()
        controller.snapshot.return_value={'cameras':[{'index':0,'name':'test'}]}
        controller.trace.snapshot.return_value={'stream_id':'local','now_s':0,'cursor':4,'rows':[]}
        local=serve.LocalBridge(controller)
        self.assertEqual(local.snapshot()['mode'],'integrated')
        self.assertEqual(local.snapshot()['state']['cameras'][0]['index'],0)
        local.action('camera_start',{'index':0})
        controller.action.assert_called_once_with('camera_start',{'index':0})
        with self.assertRaises(ValueError):local.action('artwork_start',{})
        local.close();controller.close.assert_called_once()

    def test_selection_reuses_running_collector_or_constructs_local_controller(self):
        from unittest.mock import Mock
        import sys
        # Avoid importing device dependencies: inject a harmless stand-in server module.
        module=Mock();controller=module.Controller.return_value
        with patch.object(serve.Bridge,'snapshot',return_value={'connected':True}):
            self.assertIsInstance(serve.select_bridge(),serve.Bridge)
        with patch.object(serve.Bridge,'snapshot',side_effect=OSError('not running')),patch.dict(sys.modules,{'server':module}):
            local=serve.select_bridge()
            self.assertIsInstance(local,serve.LocalBridge)
            controller.enumerate_cameras.assert_called_once();controller.enumerate_eda_ports.assert_called_once()

    def test_shared_device_action_uses_original_origin_and_never_retries_writes(self):
        from unittest.mock import Mock, MagicMock
        bridge=serve.Bridge()
        bridge.acquire_token=Mock(side_effect=lambda:setattr(bridge,'token','upstream-token'))
        response=Mock();response.read.return_value=b'{"ok":true}'
        bridge.opener=MagicMock();bridge.opener.open.return_value.__enter__.return_value=response
        self.assertEqual(bridge.action('camera_start',{'index':0}),{'ok':True})
        request=bridge.opener.open.call_args.args[0]
        self.assertEqual(request.full_url,serve.UPSTREAM+'/api/camera_start')
        self.assertEqual(request.headers['Origin'],serve.UPSTREAM)
        self.assertEqual(request.headers['X-session-token'],'upstream-token')
        bridge.opener.open.side_effect=TimeoutError('lost reply')
        with self.assertRaises(TimeoutError):bridge.action('scan',{})
        self.assertEqual(bridge.opener.open.call_count,2,'POST must not be retried after transport failure')
        with self.assertRaises(ValueError):bridge.action('artwork_start',{})
