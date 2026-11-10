"""All SQL of the index pipeline. Connection runs in autocommit: every function is its own transaction."""
from pathlib import Path

import psycopg

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

FRAME_COLUMNS = (
    "path", "etag", "release", "week", "processing", "is_retry",
    "detector", "obsid", "date_obs", "mjd_avg", "ra_center", "dec_center",
)
COLUMN_TYPES = {
    "path": "text", "etag": "text", "release": "text", "week": "text", "processing": "text",
    "is_retry": "bool", "detector": "int2", "obsid": "text", "date_obs": "timestamptz",
    "mjd_avg": "float8", "ra_center": "float8", "dec_center": "float8",
}

MARK_SEEN_SQL = """
UPDATE spherex_frames f
   SET last_seen_run = %(run_id)s, status = 'present'
  FROM unnest(%(paths)s::text[], %(etags)s::text[]) AS s(path, etag)
 WHERE f.path = s.path AND f.etag = s.etag
RETURNING f.path
"""

_cols = ", ".join(FRAME_COLUMNS)
_arrays = ", ".join(f"%({c})s::{COLUMN_TYPES[c]}[]" for c in FRAME_COLUMNS)
_updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in FRAME_COLUMNS if c != "path")
# xmax = 0 only for freshly inserted rows: distinguishes new files from changed ones
UPSERT_SQL = f"""
INSERT INTO spherex_frames ({_cols}, status, first_seen_run, last_seen_run)
SELECT {_cols}, 'present', %(run_id)s, %(run_id)s
  FROM unnest({_arrays}) AS t({_cols})
ON CONFLICT (path) DO UPDATE
   SET {_updates}, status = 'present', last_seen_run = EXCLUDED.last_seen_run
RETURNING (xmax = 0) AS inserted
"""

SWEEP_SQL = """
UPDATE spherex_frames
   SET status = 'deprecated'
 WHERE status = 'present'
   AND last_seen_run < %(run_id)s
   AND release = ANY(%(releases)s)
   AND detector = ANY(%(detectors)s)
"""


def connect(dsn: str) -> psycopg.Connection:
    return psycopg.connect(dsn, autocommit=True)


def ensure_schema(conn: psycopg.Connection) -> None:
    conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))


def start_run(conn: psycopg.Connection, scope: str) -> int:
    row = conn.execute(
        "INSERT INTO ingest_runs (status, scope) VALUES ('running', %s) RETURNING run_id",
        (scope,),
    ).fetchone()
    return row[0]


def mark_seen(conn: psycopg.Connection, run_id: int, page: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Marks unchanged known files as seen; returns files that are new or changed."""
    seen = {
        r[0] for r in conn.execute(MARK_SEEN_SQL, {
            "run_id": run_id,
            "paths": [p for p, _ in page],
            "etags": [e for _, e in page],
        })
    }
    return [(p, e) for p, e in page if p not in seen]


def upsert_frames(conn: psycopg.Connection, run_id: int, rows: list[dict]) -> tuple[int, int]:
    """Returns (inserted, updated)."""
    if not rows:
        return 0, 0
    params = {c: [r[c] for r in rows] for c in FRAME_COLUMNS}
    params["run_id"] = run_id
    flags = [r[0] for r in conn.execute(UPSERT_SQL, params)]
    inserted = sum(flags)
    return inserted, len(flags) - inserted


def sweep(conn: psycopg.Connection, run_id: int, releases, detectors) -> int:
    """Deprecates files of this scope not seen by the run. Call only after a complete listing."""
    cur = conn.execute(SWEEP_SQL, {
        "run_id": run_id,
        "releases": list(releases),
        "detectors": list(detectors),
    })
    return cur.rowcount


def finish_run(conn: psycopg.Connection, run_id: int, status: str, stats) -> None:
    conn.execute(
        """
        UPDATE ingest_runs
           SET status = %(status)s, finished_at = now(),
               n_listed = %(listed)s, n_new = %(new)s, n_changed = %(changed)s,
               n_deprecated = %(deprecated)s, n_errors = %(errors)s, last_error = %(last_error)s
         WHERE run_id = %(run_id)s
        """,
        {"status": status, "run_id": run_id, **vars(stats)},
    )


def analyze(conn: psycopg.Connection) -> None:
    """Refreshes planner statistics after a large load."""
    conn.execute("ANALYZE spherex_frames")
