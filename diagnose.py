"""Hardware checks without opening a GUI; python diagnose.py --help."""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / ".deps"))
from acquisition.heart import HR_MEASUREMENT, parse_measurement, scan_devices
from acquisition.core import stamp


async def bluetooth(args):
    devices = await scan_devices(args.seconds)
    result = {"scanned_utc": stamp()["host_utc"], "devices": [info for _, info in devices]}
    if args.address:
        match = next((d for d, info in devices if info["address"].lower() == args.address.lower()), None)
        if match is None:
            raise RuntimeError("Requested device was not seen in this scan")
        from bleak import BleakClient
        async with BleakClient(match, timeout=20) as client:
            result["connected_address"] = match.address
            result["services"] = [{"uuid": s.uuid, "characteristics": [{"uuid": c.uuid, "properties": c.properties} for c in s.characteristics]} for s in client.services]
            result["notifications"] = []
            if client.services.get_characteristic(HR_MEASUREMENT):
                def callback(_sender, payload):
                    item = stamp()
                    try:
                        item["data"] = parse_measurement(payload)
                    except ValueError as exc:
                        item.update(error=str(exc), raw_hex=bytes(payload).hex())
                    result["notifications"].append(item)
                await client.start_notify(HR_MEASUREMENT, callback)
                await asyncio.sleep(args.listen)
                if client.is_connected:
                    await client.stop_notify(HR_MEASUREMENT)
            else:
                result["error"] = "No standard Heart Rate Measurement (0x2A37) characteristic"
    return result


def camera(args):
    import cv2
    from acquisition.eye import PupilDetector
    detector = PupilDetector()
    backend = cv2.CAP_DSHOW if args.backend == "DSHOW" else cv2.CAP_MSMF
    results = []
    for index in args.indices:
        cap = cv2.VideoCapture(index, backend)
        info = {"index": index, "opened": cap.isOpened()}
        try:
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                start = time.monotonic()
                frames = 0
                samples = []
                for _ in range(20):
                    ok, frame = cap.read()
                    if ok:
                        frames += 1
                        samples.append(detector.measure(frame))
                info.update(frames_read=frames, elapsed_s=time.monotonic()-start,
                            width=cap.get(cv2.CAP_PROP_FRAME_WIDTH), height=cap.get(cv2.CAP_PROP_FRAME_HEIGHT),
                            reported_fps=cap.get(cv2.CAP_PROP_FPS), last_measurement=samples[-1] if samples else None)
        finally:
            cap.release()
        results.append(info)
    return {"checked_utc": stamp()["host_utc"], "cameras": results}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="kind", required=True)
    ble = sub.add_parser("ble")
    ble.add_argument("--seconds", type=float, default=8)
    ble.add_argument("--address")
    ble.add_argument("--listen", type=float, default=15)
    ble.add_argument("--output", default="diagnostics/ble_scan.json")
    cam = sub.add_parser("camera")
    cam.add_argument("--indices", nargs="+", type=int, default=[0, 1, 2])
    cam.add_argument("--backend", choices=["DSHOW", "MSMF"], default="DSHOW")
    cam.add_argument("--output", default="diagnostics/camera.json")
    args = parser.parse_args()
    result = asyncio.run(bluetooth(args)) if args.kind == "ble" else camera(args)
    path = ROOT / args.output
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
