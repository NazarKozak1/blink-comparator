"""Time windows over frame dates: epochs, UTC days, custom ranges. The only place that defines epochs:
the frontend takes them from /api/windows in both modes."""
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Sequence

import numpy as np

from .config import EPOCH_GAP_DAYS, EPOCH_MAX_DAYS

WINDOW_KINDS = ("epoch", "day")


@dataclass(frozen=True)
class Window:
    start: datetime      # inclusive
    end: datetime        # inclusive
    n_frames: int
    label: str

    def to_json(self) -> dict:
        return {"start": self.start.isoformat(), "end": self.end.isoformat(),
                "n_frames": self.n_frames, "label": self.label}


def _span_label(a: datetime, b: datetime) -> str:
    return f"{a:%Y-%m-%d}" if a.date() == b.date() else f"{a:%Y-%m-%d} – {b:%Y-%m-%d}"


def epochs(times: Sequence[datetime]) -> list[Window]:
    """Sorted times -> epochs: a new one starts after a gap > EPOCH_GAP_DAYS or when the current one
    would get longer than EPOCH_MAX_DAYS. Bounds are the first and last frame times."""
    gap, longest = timedelta(days=EPOCH_GAP_DAYS), timedelta(days=EPOCH_MAX_DAYS)
    out, start = [], 0
    for i in range(1, len(times) + 1):
        if i == len(times) or times[i] - times[i - 1] > gap or times[i] - times[start] > longest:
            out.append(Window(times[start], times[i - 1], i - start, _span_label(times[start], times[i - 1])))
            start = i
    return out


def spread_over_epochs(times: Sequence[datetime], limit: int) -> list[int]:
    """Indices of at most `limit` sorted times, shared equally between epochs (an epoch with fewer frames
    gives its unused share to the others) and evenly spaced inside each epoch, so no epoch is dropped
    unless there are more epochs than `limit`."""
    if len(times) <= limit:
        return list(range(len(times)))
    groups, start = [], 0
    for w in epochs(times):
        groups.append(range(start, start + w.n_frames))
        start += w.n_frames
    quota, left = {}, limit
    by_size = sorted(range(len(groups)), key=lambda g: len(groups[g]))
    for i, g in enumerate(by_size):             # smallest first: their unused share goes to the rest
        quota[g] = min(len(groups[g]), left // (len(groups) - i))
        left -= quota[g]
    out = []
    for g, idx in enumerate(groups):
        if quota[g]:
            out += [idx[int(k)] for k in np.linspace(0, len(idx) - 1, quota[g]).round()]
    return out


def days(times: Sequence[datetime]) -> list[Window]:
    """Sorted times -> UTC calendar days that have frames."""
    counts: dict = {}
    for t in times:
        d = t.astimezone(timezone.utc).date()
        counts[d] = counts.get(d, 0) + 1
    return [Window(datetime.combine(d, time.min, timezone.utc), datetime.combine(d, time.max, timezone.utc),
                   n, f"{d:%Y-%m-%d}") for d, n in counts.items()]


def split(times: Sequence[datetime], kind: str) -> list[Window]:
    if kind not in WINDOW_KINDS:
        raise ValueError(f"unknown window {kind!r}, expected one of {WINDOW_KINDS}")
    return epochs(times) if kind == "epoch" else days(times)


def as_utc(t: datetime) -> datetime:
    """Naive datetimes from the query string are taken as UTC."""
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
