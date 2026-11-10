CREATE TABLE IF NOT EXISTS ingest_runs (
    run_id        bigserial PRIMARY KEY,
    status        text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    scope         text NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    n_listed      integer,
    n_new         integer,
    n_changed     integer,
    n_deprecated  integer,
    n_errors      integer,
    last_error    text
);

-- One row per FITS file in S3.
-- fillfactor leaves room for HOT updates: last_seen_run changes on every run and is not indexed.
CREATE TABLE IF NOT EXISTS spherex_frames (
    path            text PRIMARY KEY,
    etag            text NOT NULL,
    status          text NOT NULL CHECK (status IN ('present', 'deprecated')),
    first_seen_run  bigint NOT NULL REFERENCES ingest_runs (run_id),
    last_seen_run   bigint NOT NULL REFERENCES ingest_runs (run_id),

    release         text NOT NULL,
    week            text NOT NULL,
    processing      text NOT NULL,
    is_retry        boolean NOT NULL,

    detector        smallint NOT NULL,
    obsid           text,
    date_obs        timestamptz NOT NULL,
    mjd_avg         double precision NOT NULL,
    ra_center       double precision NOT NULL,
    dec_center      double precision NOT NULL
) WITH (fillfactor = 90);

-- Cone search: filter by detector and declination band, then exact distance.
CREATE INDEX IF NOT EXISTS frames_search
    ON spherex_frames (detector, dec_center)
    WHERE status = 'present';
