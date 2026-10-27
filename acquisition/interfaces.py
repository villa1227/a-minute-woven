"""Public adapter boundary for new sensors; independent of HTTP and hardware."""
import json
import re
from typing import Protocol
from .core import stamp


class SensorAdapter(Protocol):
    """Adapters own their transport; stop must release it within timeout."""
    def start(self) -> None: ...
    def stop(self, timeout: float = 5) -> None: ...


class SamplePublisher:
    """Send one actual received sample to live traces and the active recording.

    Calls are synchronous. Do not hold a controller lock inside an adapter
    callback, and do not call back into the adapter from the recorder callback.
    New source names are stored in JSONL; built-in sources also have CSV views.
    """
    def __init__(self, recorder, trace):
        self.recorder = recorder
        self.trace = trace

    def publish(self, source, data, clock=None):
        if not isinstance(source, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', source):
            raise ValueError('source must be a lowercase sensor/event name')
        if not isinstance(data, dict):
            raise ValueError('data must be a JSON object')
        # Copy to avoid mutable transport buffers changing retained samples.
        data = json.loads(json.dumps(data, ensure_ascii=False, allow_nan=False))
        clock = dict(stamp() if clock is None else clock)
        ns = clock.get('host_monotonic_ns')
        if isinstance(ns, bool) or not isinstance(ns, int) or ns < 0 or not isinstance(clock.get('host_utc'), str):
            raise ValueError('clock requires host_monotonic_ns integer and host_utc string')
        clock = {key: clock[key] for key in ('host_monotonic_ns', 'host_utc')}
        # Live feedback exists even without a disk recording. A disk failure
        # is raised to the adapter so it can expose an explicit error state.
        self.trace.emit(source, data, clock)
        self.recorder.emit(source, data, clock)

    def event(self, kind, data=None, clock=None):
        if not isinstance(kind, str) or not kind:
            raise ValueError('event kind must be a nonempty string')
        self.publish('event', {**(data or {}), 'kind': kind}, clock)
