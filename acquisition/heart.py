import asyncio
import threading
import time

from .core import stamp

HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb"
HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb"


def parse_measurement(packet):
    """Bluetooth SIG Heart Rate Measurement, little endian; RR in 1/1024 s."""
    raw = bytes(packet)
    if len(raw) < 2:
        raise ValueError("Truncated flags/heart rate")
    flags = raw[0]
    pos = 1

    def take(n):
        nonlocal pos
        if pos + n > len(raw):
            raise ValueError("Truncated heart rate packet")
        v = int.from_bytes(raw[pos:pos+n], "little")
        pos += n
        return v

    bpm = take(2 if flags & 1 else 1)
    contact = bool(flags & 2) if flags & 4 else None
    energy = take(2) if flags & 8 else None
    rr_units = []
    if flags & 16:
        if pos == len(raw) or (len(raw) - pos) % 2:
            raise ValueError("Missing or incomplete RR intervals")
        while pos < len(raw):
            rr_units.append(take(2))
    if pos != len(raw):
        raise ValueError("Unexpected trailing bytes")
    quality = "contact_lost" if contact is False else ("zero_bpm" if bpm == 0 else "received_unvalidated")
    return {"bpm": bpm, "contact_detected": contact,
            "energy_expended_kj": energy, "rr_present": bool(rr_units),
            "rr_1024s": rr_units, "rr_ms": [v * 1000 / 1024 for v in rr_units],
            "raw_hex": raw.hex(), "flags": flags, "quality": quality}


async def scan_devices(seconds=8):
    from bleak import BleakScanner
    discovered = await BleakScanner.discover(timeout=seconds, return_adv=True)
    return [(dev, {"address": dev.address, "name": adv.local_name or dev.name or "未命名设备",
                   "rssi": adv.rssi, "advertised_services": adv.service_uuids,
                   "advertises_hr": HR_SERVICE in [s.lower() for s in adv.service_uuids]})
            for dev, adv in discovered.values()]


class HeartWorker(threading.Thread):
    def __init__(self, device, recorder, status, on_sample):
        super().__init__(daemon=True)
        self.device, self.recorder = device, recorder
        self.status, self.on_sample = status, on_sample
        self.stop_event = threading.Event()

    def run(self):
        try:
            asyncio.run(self.collect())
        except Exception as exc:
            self.status("heart", "蓝牙错误：" + str(exc))
        else:
            self.status("heart", "已断开；可重新扫描/连接")

    async def collect(self):
        from bleak import BleakClient
        self.status("heart", "正在连接…")
        async with BleakClient(self.device, timeout=20) as client:
            services = [{"uuid": s.uuid, "characteristics":
                         [{"uuid": c.uuid, "properties": c.properties} for c in s.characteristics]}
                        for s in client.services]
            self.service_info = services
            self.recorder.emit("event", {"kind": "ble_services", "device_address": self.device.address, "services": services})
            if not client.services.get_characteristic(HR_MEASUREMENT):
                raise RuntimeError("未找到 0x2A37。请开启手环心率广播；也可能该模式未暴露标准心率服务。")

            last_received = time.monotonic()
            warned = False
            def notification(_characteristic, payload):
                nonlocal last_received, warned
                clock = stamp()
                last_received = time.monotonic()
                warned = False
                try:
                    sample = parse_measurement(payload)
                    sample["device_address"] = self.device.address
                    self.recorder.emit("heart_rate", sample, clock)
                    self.on_sample(sample, clock)
                except Exception as exc:
                    self.recorder.emit("event", {"kind": "hr_packet_error",
                        "raw_hex": bytes(payload).hex(), "error": str(exc)}, clock)
                    self.status("heart", "心率报文/存储错误：" + str(exc))

            await client.start_notify(HR_MEASUREMENT, notification)
            self.status("heart", "已订阅 0x2A37，等待真实心率数据…")
            while not self.stop_event.is_set() and client.is_connected:
                if time.monotonic() - last_received > 10 and not warned:
                    warned = True
                    self.status("heart", "已连接，但超过 10 秒未收到心率。请检查佩戴、广播开关和其他连接。")
                await asyncio.sleep(0.2)
            if client.is_connected:
                await client.stop_notify(HR_MEASUREMENT)
