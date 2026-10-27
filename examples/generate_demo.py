"""Regenerate a deterministic, fully synthetic artwork; no hardware required."""
import json
import math
from pathlib import Path


def make_artwork():
    # Window medians only: deliberately includes unilateral and full data loss.
    values = [
        (20, 24, 72), (21, 23, 76), (23, 22, 82), (25, 25, 90),
        (24, None, 86), (22, 28, None), (18, 30, 68), (16, 27, 60),
        (None, 23, 74), (None, None, None), (19, 21, 80), (22, 25, 76),
    ]
    references = dict(left=20, right=24, heart=72)
    bands = []
    for index, row in enumerate(values):
        sample = dict(zip(('left', 'right', 'heart'), row))
        amplitude = {}
        for side in ('left', 'right'):
            value = sample[side]
            delta = max(-.3, min(.3, value / references[side] - 1)) if value is not None else None
            amplitude[side] = None if delta is None else .08 + (delta + .3) / .6 * .16
        delta = max(-20, min(20, sample['heart'] - references['heart'])) if sample['heart'] is not None else None
        bands.append(dict(
            index=index, start_s=index*5, end_s=(index+1)*5,
            seed=f'demo-synthetic-001:{index}', values=sample,
            counts={key: (0 if value is None else 5 if key == 'heart' else 100) for key, value in sample.items()},
            amplitude=amplitude, threads=22 if delta is None else math.floor(16+(delta+20)/40*24+.5),
            base_threads=22, aggregation='median over the 5-second window',
            empty=all(value is None for value in row)))
    return dict(
        schema_version=2, renderer='woven-v1', id='demo-synthetic-001',
        synthetic=True, description='Entirely synthetic demo; values and counts are illustrative, not measurements.',
        status='completed', created_at='2026-10-27T12:00:00+08:00',
        duration_s=60, interval_s=5, band_count=12, elapsed_s=65,
        preparation_s=5, display_duration_s=65, phase='completed',
        references=references, bands=bands, late_samples=0, error=None,
        canvas=dict(width=2400, height=3200, qr_space=[1920, 2760, 320, 320]),
        downloadable=True)


if __name__ == '__main__':
    target = Path(__file__).with_name('artwork.synthetic.json')
    target.write_text(json.dumps(make_artwork(), ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    print(target.name)
