"""Temporary, anonymous artwork hosting. No photographs or sensor data on disk."""
import hashlib
import io
import json
import re
import secrets
import threading
import time
import urllib.request
import urllib.error

UPLOAD_URL = 'https://imgloc.com/upload.php'
MAX_BYTES = 8 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('图床返回了重定向，请稍后重试')


def clean_png(data):
    from PIL import Image
    if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data) > MAX_BYTES:
        raise ValueError('只接受不超过 8 MB 的作品 PNG')
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'PNG' or not (1 <= image.width <= 1600 and 1 <= image.height <= 1800):
                raise ValueError('作品尺寸须不超过 1600 × 1800（包含落款）')
            image.load()
            # Flatten and re-encode to remove arbitrary metadata/embedded extras.
            rgba=image.convert('RGBA')
            paper=Image.new('RGB',image.size,'white');paper.paste(rgba,mask=rgba.getchannel('A'))
            result=io.BytesIO();paper.save(result,format='PNG')
            return result.getvalue()
    except ValueError:
        raise
    except Exception:
        raise ValueError('作品 PNG 无法读取') from None


def upload_png(png):
    boundary='mirror-'+secrets.token_hex(16)
    chunks=[]
    chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="artwork.png"\r\nContent-Type: image/png\r\n\r\n'.encode())
    chunks.extend([png,f'\r\n--{boundary}--\r\n'.encode()])
    request=urllib.request.Request(UPLOAD_URL,data=b''.join(chunks),headers={'Content-Type':'multipart/form-data; boundary='+boundary,'User-Agent':'CyberMirror/1.0'})
    # Respect the operator's proxy environment, no user-controlled URLs or redirects.
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=45) as response:
            result=json.loads(response.read(16384).decode('utf-8'))
    except urllib.error.HTTPError as exc:
        status=exc.code
        exc.close()
        if status==429:raise ValueError('ImgLoc 当前 IP 上传频率已达上限（每小时最多 60 张），请先本地保存或稍后重试') from None
        raise ValueError('ImgLoc 返回错误（'+str(status)+'），请稍后重试或先本地下载') from None
    url=result.get('url','')
    if result.get('ok') is not True or not isinstance(url,str) or not re.fullmatch(r'https://i\.imgs\.ovh/[a-zA-Z0-9/_-]+\.png',url):
        raise ValueError('图床未返回有效图片链接，请重试或使用本地下载')
    return url


class ArtworkShares:
    def __init__(self, upload=None, clock=time.time):
        self.upload=upload or upload_png;self.clock=clock;self.cache={};self.lock=threading.Lock()

    def share(self, data):
        png=clean_png(data);key=hashlib.sha256(png).hexdigest()
        if not self.lock.acquire(blocking=False):
            raise ValueError('已有作品正在上传，请稍后重试')
        try:
            now=self.clock();self.cache={k:v for k,v in self.cache.items() if v['cached_until']>now+60}
            if key in self.cache:return self.cache[key]
            url=self.upload(png)
            result={'url':url,'provider':'ImgLoc','expires_at':None,'cached_until':self.clock()+3600,
                    'retention':'ImgLoc 默认保存约 1 年，持有链接者可查看；不保证永久可用，请及时保存'}
            self.cache[key]=result
            if len(self.cache)>32:del self.cache[next(iter(self.cache))]
            return result
        finally:self.lock.release()
