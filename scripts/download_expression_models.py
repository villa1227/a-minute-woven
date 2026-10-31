"""Explicit, hash-checked model installation. Never called on app startup."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    folder = ROOT / 'models' / 'expression'
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    for model in manifest['models']:
        target = folder / model['file']
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == model['sha256']:
            print('Verified:', model['file'])
            continue
        url = f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{manifest['revision']}/{model['path']}"
        print('Downloading:', model['file'], flush=True)
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(model['size'] + 1)
        if len(data) != model['size'] or hashlib.sha256(data).hexdigest() != model['sha256']:
            raise RuntimeError('Model size/hash mismatch: ' + model['file'])
        temporary = target.with_suffix('.onnx.tmp')
        temporary.write_bytes(data)
        temporary.replace(target)
    print('Expression models ready. Enable recognition in the device panel.')


if __name__ == '__main__':
    main()
