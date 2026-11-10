"""Warm the server caches for the presets right after start, in a background thread.

Exactly the requests the page makes when a preset is opened (bg=median, minmax, bare, normal contrast) are
computed, so their PNGs land in the same lru caches:
  pass 1, every preset: frame list (/api/frames) and the first picture of its view;
  pass 2, every preset: stacks of all visits, frames 1-3, Diff of the first and the last visit.
Only results are kept for long (PNG caches); raw cuts of large fields may be evicted later.
Disabled with SPHEREX_WARMUP=0."""
import threading
import time
import traceback

from .presets import PRESETS

STATUS = {"running": False, "done": 0, "total": 0, "current": "", "seconds": 0.0, "errors": []}
FRAMES_AHEAD = 3


def _jobs(web):
    """(label, callable) in warm-up order; built lazily because the first pass fills the frame lists."""
    def frame(p, f):
        return lambda: web.render(f["path"], p.q, float(p.size), 0.8, "", "mjy", False, None, None, "median", True, "normal")

    def stack(p, w):
        return lambda: web.render_stack(p.q, p.detector, float(p.size), True, w.start, w.end, 0, "minmax", True, False,
                                        0.0, None, None, "median", True, "normal")

    def diff(p, a, b):
        return lambda: web.render_diff(p.q, p.detector, float(p.size), True, (a.start, a.end), (b.start, b.end), 0,
                                       "minmax", "median", False, True, 5.0)

    def visits(p):
        frames = web.select_frames(p.q, p.detector, float(p.size), True)
        return frames, web.split([web.datetime.fromisoformat(f["date_obs"]) for f in frames], "epoch")

    first, second = [], []
    for p in PRESETS:
        first.append((f"{p.name}: frame list", lambda p=p: web.scan_frames(p.q, p.detector, float(p.size))))

        def first_picture(p=p):
            frames, wins = visits(p)
            if p.mode == "stacks" and wins:
                stack(p, wins[0])()
            elif frames:
                frame(p, frames[0])()
        first.append((f"{p.name}: first picture", first_picture))

        def rest(p=p):
            frames, wins = visits(p)
            for w in wins:
                stack(p, w)()
            for f in frames[:FRAMES_AHEAD + 1]:
                frame(p, f)()
            if len(wins) > 1:
                diff(p, wins[0], wins[-1])()
        second.append((f"{p.name}: visit stacks, frames, diff", rest))
    return first + second


def _run():
    from . import app as web          # late import: app imports this module
    t0 = time.time()
    jobs = _jobs(web)
    STATUS.update(running=True, done=0, total=len(jobs), errors=[])
    for label, job in jobs:
        STATUS["current"] = label
        try:
            job()
        except Exception as e:        # one failing preset must not stop the rest
            STATUS["errors"].append(f"{label}: {e}")
            traceback.print_exc()
        STATUS["done"] += 1
        STATUS["seconds"] = round(time.time() - t0, 1)
    STATUS.update(running=False, current="")
    print(f"warm-up of {len(PRESETS)} presets finished in {STATUS['seconds']} s, errors: {len(STATUS['errors'])}")


def start() -> threading.Thread:
    STATUS["running"] = True
    t = threading.Thread(target=_run, name="preset-warmup", daemon=True)
    t.start()
    return t
