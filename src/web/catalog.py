"""Cone search in the Postgres frame index (table spherex_frames)."""
import psycopg

from .config import DSN, SEARCH_RADIUS_DEG

# Coarse match by frame center; whether the target is really inside is checked later with the WCS.
FIND_SQL = """
SELECT path, date_obs, obsid
  FROM spherex_frames
 WHERE status = 'present' AND detector = %(det)s
   AND dec_center BETWEEN %(dec)s - %(r)s AND %(dec)s + %(r)s
   AND degrees(acos(least(1.0,
         sin(radians(dec_center)) * sin(radians(%(dec)s)) +
         cos(radians(dec_center)) * cos(radians(%(dec)s)) * cos(radians(ra_center - %(ra)s))
       ))) < %(r)s
 ORDER BY mjd_avg
"""


def find_candidates(ra: float, dec: float, detector: int, radius: float = SEARCH_RADIUS_DEG) -> list[tuple]:
    """(path, date_obs, obsid) of frames whose center is within `radius` deg, oldest first."""
    with psycopg.connect(DSN) as conn:
        return conn.execute(FIND_SQL, {"ra": ra, "dec": dec, "det": detector, "r": radius}).fetchall()


# Random frame of a detector; TABLESAMPLE avoids a full scan of the 1.6 M rows.
RANDOM_SQL = """
SELECT ra_center, dec_center
  FROM spherex_frames TABLESAMPLE SYSTEM (0.05)
 WHERE status = 'present' AND detector = %(det)s
 LIMIT 1
"""


def random_center(detector: int, tries: int = 10) -> tuple[float, float] | None:
    """Centre of a random indexed frame: a sky point that surely has frames of this detector."""
    with psycopg.connect(DSN) as conn:
        for _ in range(tries):
            row = conn.execute(RANDOM_SQL, {"det": detector}).fetchone()
            if row:
                return float(row[0]), float(row[1])
    return None


# Frames of one detector in a time window (spectrum of one visit): the date filter keeps the candidate list
# short (~25-35 frames per detector), so no MAX_FRAMES cap is needed.
FIND_WINDOW_SQL = FIND_SQL.replace(" ORDER BY mjd_avg", "   AND date_obs BETWEEN %(t0)s AND %(t1)s\n ORDER BY mjd_avg")


def find_in_window(ra: float, dec: float, detector: int, t0, t1, radius: float = SEARCH_RADIUS_DEG) -> list[tuple]:
    """(path, date_obs, obsid) of frames whose center is within `radius` deg and taken between t0 and t1."""
    with psycopg.connect(DSN) as conn:
        return conn.execute(FIND_WINDOW_SQL, {"ra": ra, "dec": dec, "det": detector, "r": radius,
                                              "t0": t0, "t1": t1}).fetchall()
