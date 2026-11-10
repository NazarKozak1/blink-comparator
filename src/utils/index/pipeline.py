"""
Incremental index of SPHEREx frames: S3 listing -> FITS headers -> Postgres.

From the project root:
    python -m src.utils.index.pipeline --last-weeks 2      # quick test, no sweep
    python -m src.utils.index.pipeline                      # qr3, detector 6
    python -m src.utils.index.pipeline --release qr3 qr2 --detectors 1 2 3 4 5 6
"""
import argparse
import dataclasses
import logging
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass

from . import db_scripts as db
from .config import IndexConfig
from .header_parser import HeaderError, parse_header
from .s3_source import fetch_header, iter_pages, make_client, parse_key

log = logging.getLogger("spherex.index")


@dataclass
class RunStats:
    listed: int = 0
    new: int = 0
    changed: int = 0
    deprecated: int = 0
    errors: int = 0
    last_error: str | None = None


def build_row(s3, cfg: IndexConfig, key: str, etag: str) -> dict:
    header = parse_header(fetch_header(s3, cfg, key))
    path_info = parse_key(key)
    if header["detector"] != path_info["detector"]:
        raise HeaderError(f"DETECTOR={header['detector']} but folder is {path_info['detector']}")
    return {**path_info, **header, "path": key, "etag": etag}


def run(cfg: IndexConfig) -> RunStats:
    s3 = make_client(cfg)
    conn = db.connect(cfg.dsn)
    db.ensure_schema(conn)
    run_id = db.start_run(conn, cfg.scope)
    stats = RunStats()
    buffer: list[dict] = []
    pending: set[Future] = set()
    pool = ThreadPoolExecutor(max_workers=cfg.workers)
    t0 = time.time()
    log.info("run %d started: %s", run_id, cfg.scope)

    def flush() -> None:
        inserted, updated = db.upsert_frames(conn, run_id, buffer)
        stats.new += inserted
        stats.changed += updated
        buffer.clear()

    def collect(done: set[Future]) -> None:
        for fut in done:
            try:
                buffer.append(fut.result())
            except Exception as e:  # one bad file must not stop the run; it is retried next run
                stats.errors += 1
                stats.last_error = f"{type(e).__name__}: {e}"
        if len(buffer) >= cfg.write_batch:
            flush()

    try:
        for page in iter_pages(s3, cfg):
            stats.listed += len(page)
            for key, etag in db.mark_seen(conn, run_id, page):
                pending.add(pool.submit(build_row, s3, cfg, key, etag))
                if len(pending) >= cfg.in_flight:
                    done, pending = wait(pending, return_when=FIRST_COMPLETED)
                    collect(done)
            log.info("listed %d, new %d, changed %d, errors %d, %.0f s",
                     stats.listed, stats.new, stats.changed, stats.errors, time.time() - t0)

        done, pending = wait(pending)
        collect(done)
        flush()

        if cfg.is_full_scope:
            stats.deprecated = db.sweep(conn, run_id, cfg.releases, cfg.detectors)
        else:
            log.info("partial scope (--last-weeks): sweep skipped")
        db.analyze(conn)
        db.finish_run(conn, run_id, "success", stats)
        log.info("run %d success in %.0f s: %s", run_id, time.time() - t0, stats)
        return stats

    except BaseException as e:  # includes Ctrl+C: the run is marked failed, no sweep happens
        stats.last_error = f"{type(e).__name__}: {e}"
        db.finish_run(conn, run_id, "failed", stats)
        log.error("run %d failed: %s", run_id, stats.last_error)
        raise
    finally:
        pool.shutdown(cancel_futures=True)
        conn.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--release", nargs="+")
    ap.add_argument("--detectors", nargs="+", type=int)
    ap.add_argument("--last-weeks", type=int)
    ap.add_argument("--workers", type=int)
    ap.add_argument("--dsn")
    args = ap.parse_args()

    overrides = {
        "releases": tuple(args.release) if args.release else None,
        "detectors": tuple(args.detectors) if args.detectors else None,
        "last_weeks": args.last_weeks,
        "workers": args.workers,
        "dsn": args.dsn,
    }
    cfg = dataclasses.replace(IndexConfig(), **{k: v for k, v in overrides.items() if v is not None})

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(cfg)


if __name__ == "__main__":
    main()
