import importlib.util
import io
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import Mock,patch
from PIL import Image

spec=importlib.util.spec_from_file_location('mirror_sharing',Path(__file__).resolve().parents[1]/'mirror/sharing.py')
sharing=importlib.util.module_from_spec(spec);spec.loader.exec_module(sharing)


def png():
    output=io.BytesIO();Image.new('RGB',(100,80),'#bb9988').save(output,format='PNG');return output.getvalue()


class ShareTests(unittest.TestCase):
    def test_http_errors_never_display_untrusted_html(self):
        for status,message in [(412,'412'),(429,'60 张')]:
            opener=Mock();opener.open.side_effect=urllib.error.HTTPError(sharing.UPLOAD_URL,status,'Rejected',{},io.BytesIO(b'<script>bad</script>'))
            with patch.object(sharing.urllib.request,'build_opener',return_value=opener):
                with self.assertRaisesRegex(ValueError,message) as caught:sharing.upload_png(png())
                self.assertNotIn('<script>',str(caught.exception))
    def test_only_valid_small_png_reencoded_and_cached(self):
        upload=Mock(return_value='https://i.imgs.ovh/synthetic.png');clock=[100]
        shares=sharing.ArtworkShares(upload=upload,clock=lambda:clock[0])
        first=shares.share(png());second=shares.share(png())
        self.assertEqual(first,second);upload.assert_called_once()
        self.assertIsNone(first['expires_at']);self.assertEqual(first['provider'],'ImgLoc');self.assertEqual(first['cached_until'],3700)
        with Image.open(io.BytesIO(upload.call_args.args[0])) as image:self.assertEqual(image.size,(100,80))
        clock[0]=3800;shares.share(png());self.assertEqual(upload.call_count,2)

    def test_bad_oversize_or_wrong_format_never_reaches_network(self):
        upload=Mock();shares=sharing.ArtworkShares(upload=upload)
        for data in [b'not png',b'\x89PNG\r\n\x1a\ncorrupt',b'\x89PNG\r\n\x1a\n'+b'a'*sharing.MAX_BYTES]:
            with self.assertRaises(ValueError):shares.share(data)
        output=io.BytesIO();Image.new('RGB',(1601,1)).save(output,format='PNG')
        with self.assertRaises(ValueError):shares.share(output.getvalue())
        upload.assert_not_called()

    def test_failure_is_retryable_and_does_not_cache(self):
        upload=Mock(side_effect=[TimeoutError(), 'https://i.imgs.ovh/synthetic.png'])
        shares=sharing.ArtworkShares(upload=upload)
        with self.assertRaises(TimeoutError):shares.share(png())
        self.assertEqual(shares.cache,{})
        self.assertIn('url',shares.share(png()))

    def test_provider_form_and_response_validation(self):
        from unittest.mock import MagicMock
        opener=MagicMock();response=opener.open.return_value.__enter__.return_value
        response.read.return_value=b'{"ok":true,"url":"https://i.imgs.ovh/2026/11/21/test.png"}'
        with patch.object(sharing.urllib.request,'build_opener',return_value=opener):
            self.assertEqual(sharing.upload_png(png()),'https://i.imgs.ovh/2026/11/21/test.png')
            request=opener.open.call_args.args[0]
            self.assertEqual(request.full_url,'https://imgloc.com/upload.php');self.assertIn(b'name="image"',request.data)
            response.read.return_value=b'{"ok":true,"url":"https://evil.example/test.png"}'
            with self.assertRaises(ValueError):sharing.upload_png(png())
