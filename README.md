# Star Platinum: blink-comparator for SPHEREx

Star Platinum is a web viewer that turns the public NASA SPHEREx all-sky survey into a modern blink comparator.
Enter a name or sky coordinates and you get every SPHEREx frame that covers that place, ordered by date and
infrared band. You can step through single frames, stack each visit, blink two epochs with identical contrast, or
subtract them. The aim is to see what moved or changed brightness. A click on a source measures its 0.75–5 µm
spectrum from all six detectors and compares it between visits. Known objects come from SIMBAD and Gaia DR3,
propagated to the date of the frame.

**Live:** <https://blink-comparator.de>

![Barnard's Star blinked between Aug 2025 and Aug 2026 in SPHEREx D6](assets/targets/barnard/blink.gif)
![Difference of the two epochs: white = appeared, black = vanished](assets/targets/barnard/diff.png)

## Challenge

NASA Space Apps Challenge 2026, **"Planet X and SPHEREx"**. The challenge asks for a tool that helps people search
SPHEREx data for new objects near the Solar System and check known ones: the motion of nearby stars and the
brightness changes of variable stars. Five known targets are given for validation.

<!-- TODO before submission: check the wording of the rows below against the official Objectives and Considerations
     on the challenge page (it could not be fetched when this README was written). -->

| Challenge requirement | How it is implemented | Status |
|---|---|---|
| Access SPHEREx images of any place on the sky | Search by name (autocomplete, alternative names) or coordinates. A Postgres index of ~1.6 million frame headers finds every frame that covers the place, and only the needed byte ranges are read from the public S3 bucket | Done |
| Compare epochs to reveal moving objects (blink comparison) | Frames / Stacks / Blink / Diff modes. Each visit is stacked on a common north-up grid; Blink uses identical contrast; Diff is a noise-normalised significance map (white = appeared, black = vanished) | Done |
| Reveal brightness changes of variable stars | Blink with the same contrast for both epochs. The Spectrum window compares two visits detector by detector, using unsaturated detectors only | Done (limited by saturation of very bright stars) |
| Validate on the known targets | [assets/targets/](assets/targets/SUMMARY.md): screenshots, GIFs, reproducible URLs and numbers for all five targets | Partly: 3 of 5 fully, R Dra qualitatively, WISE 0855 only detected (motion below one pixel) |
| Search for unknown nearby objects ("Planet X") | Diff mode shows any moving source as a black/white dipole; the Random patch button lets users scan the sky | Partly: visual search only. Automated moving-object detection and shift-and-add exist as offline scripts (`demo/`), not on the site |
| Use SPHEREx spectral information | 17 bands per detector to choose from. A click measures a spectrum from all six detectors with aperture photometry on raw pixels, FLAGS masks, an empirical aperture correction, and detection of emission/absorption features (Paα, PAH, ices) | Done |
| Identify known objects | SIMBAD and Gaia DR3 for the whole field, moved by proper motion to the date of the frame; "Objects near this point"; field analytics | Done |
| Usable by non-experts | Name search, tooltips (i) for every control, a guide character, a sky sphere for picking a field, a phone layout | Partly: the sky sphere is a simple picker, with no survey coverage map |
| Open, reproducible results | Every view is a URL (`q`, `det`, `fov`, `mode`, `ea`, `eb`, `tool`, …), so links reproduce exactly what was seen. The code and the frame index pipeline are in this repository | Done |

## Results on the challenge targets

Full table: [assets/targets/SUMMARY.md](assets/targets/SUMMARY.md). Each target has its own folder with screenshots,
a blink GIF and a README with URLs and numbers.

| Target | Looked for | Visible? | Key number |
|---|---|---|---|
| [Barnard's Star](assets/targets/barnard/) | proper motion | **Yes** | 10.3″ (1.67 px) in 0.99 yr in D6; Gaia DR3 predicts 10.29″ |
| [Epsilon Indi B](assets/targets/epsindi/) | proper motion | **Yes** (≈ 1 px) | 6.4″ in 1.41 yr; agrees with Gaia within 2.5σ |
| [WISE 0855−0714](assets/targets/wise0855/) | proper motion | **No** (detected only at the limit) | S/N ≈ 5 per epoch; expected shift 0.6 px; motion not constrained |
| [RW Aurigae](assets/targets/rwaur/) | brightness change | **Yes** | D5–D6 ×0.54 (−46%) in a year, D1–D2 brighter; controls 5% |
| [R Draconis](assets/targets/rdra/) | brightness change | **Partly** | Fading is visible; −44% from the PSF wings (core saturated in all detectors) |
| [Orion Nebula](assets/targets/orion/) (bonus) | spectral features | **Yes** | Paα 24σ, PAH 3.3 µm 29σ |

## Features

- **Search.** By name, with autocomplete for the challenge targets, or by any coordinate format. Fast movers such as
  Barnard's Star are stored at their 2025–2026 positions, not at J2000.
- **Four view modes.**
  - **Frames:** every photo in time order, as recorded or with the background removed.
  - **Stacks:** one deep image per visit (minmax / sigma-clip / mean, 1/VARIANCE weights).
  - **Blink:** two epochs with identical contrast.
  - **Diff:** an epoch difference normalised by the noise.
- **Detectors and bands.**
  - **Detectors:** six (D1–D6, 0.75–5.0 µm).
  - **Bands:** 17 wavelength bands per detector, with a histogram picker.
  - **Background:** the median of the photo or NASA's zodiacal-light model.
  - **Contrast:** Faint / Normal / Bright.
  - **Masks:** optional masks for bad pixels.
- **Timeline.** Every photo at its real date, grouped into visits, with zoom down to minutes, scrubbing and
  playback.
- **Spectrum tool.** Click a source or drag a circle to get a spectrum from all six detectors over one visit
  (±10 days).
  - **Ring background** (point sources): the circle snaps to the source, the sky comes from a ring, and an
    empirical aperture correction is applied.
  - **Sky-model background** (nebulae, galaxies): IMAGE − ZODI, no correction.
  - **Features:** found automatically with a significance test and checked against other visits.
  - **Compare with:** gives one summary line ("46% fainter (D5–D6)") plus a per-detector table. A fast star is
    followed along its proper motion from Gaia DR3, or from SIMBAD when Gaia has none (WISE 0855).
- **Catalogs.**
  - **Sources:** SIMBAD (Harvard mirror) and Gaia DR3 (ESA archive, async jobs), one background query per field.
  - **Proper motion:** positions are moved to the date of the frame.
  - **"Objects near this point":** types in plain language, magnitudes, distances.
  - **Analytics view:** object types and a sortable table.
- **Shareable state.** The whole view is in the URL: `?q=…&det=6&fov=4&mode=diff&ea=0&eb=3&same=1&tool=spectrum#explore`.
  Any link can be shared or embedded.
- **Responsive UI.** Floating windows (drag, minimise to a tab); a bottom sheet and touch controls on phones. The
  previous interface is still at `/legacy`.

## How it works

**Data**
- SPHEREx Level-2 calibrated images (`PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE`, ~71 MB per file) are
  read from the public AWS bucket `s3://nasa-irsa-spherex`. Access is anonymous.
- `src/utils/index` lists the bucket, reads only the FITS headers and stores one row per frame in Postgres
  (`spherex_frames`). The index holds **~1.6 million frames** (24 Apr 2025 – 5 Oct 2026, 6 detectors).
- A query is a cone search in this index followed by a precise WCS check.

**Processing**
- Only the byte ranges of the needed rows are downloaded, never whole files.
- Cutouts are resampled to a north-up TAN grid with 1 grid pixel = 1 SPHEREx pixel (6.15″).
- The background is removed (median or zodiacal model), and frames are stacked per visit with 1/VARIANCE weights.
- Diff images are divided by their noise, so grey = no change.
- Photometry runs on the raw frame pixels in the frame's own WCS:
  - fractional pixel coverage;
  - FLAGS bits masked (including the RICE-compressed FLAGS of processing version l2b-v27);
  - errors from VARIANCE and empty-aperture scatter, plus 3% systematics.

**Catalogs**
- SIMBAD and Gaia DR3 are queried once per field and cached in memory and on disk.
- Proper motions are applied to the frame date, with a wider search cone for fast stars.

```mermaid
flowchart LR
    S3[("s3://nasa-irsa-spherex<br/>SPHEREx L2 FITS")]
    IDX["src/utils/index<br/>header pipeline"]
    PG[("Postgres<br/>spherex_frames<br/>~1.6M frames")]
    API["FastAPI app<br/>src/web/app.py"]
    PROC["image_processing<br/>grid · background · stack · diff"]
    PHOT["photometry / spectrum<br/>apertures · FLAGS · features"]
    CAT["catalogs<br/>SIMBAD · Gaia DR3"]
    UI["Browser UI<br/>vanilla JS modules"]
    S3 -- "headers" --> IDX --> PG
    UI -- "/api/frames, /api/windows" --> API
    API -- "cone search" --> PG
    API -- "byte ranges" --> S3
    API --> PROC
    API --> PHOT
    API --> CAT
    API -- "PNG, JSON" --> UI
```

**Main endpoints**

| Endpoint | Purpose |
|---|---|
| `/api/frames`, `/api/windows` | frames and visits for a place |
| `/api/frame.png`, `/api/stack.png`, `/api/diff.png` | rendered images |
| `/api/point`, `/api/spectrum`, `/api/motion` | spectrum tool |
| `/api/catalog` | field objects |
| `/api/random`, `/api/warmup` | random field, cache warm-up |

More detail is in `ARCHITECTURE.md` (internal).

## Tech stack

- **Backend:** Python 3.12, FastAPI, Uvicorn, NumPy, Astropy, psycopg 3, PostgreSQL 16, boto3 / HTTP byte ranges.
- **Frontend:** plain HTML/CSS and ES-module JavaScript, with no build step.
- **Ops:** Docker, Docker Compose, Caddy (automatic HTTPS), GitHub Actions.

## Run locally

Requirements: Python 3.12, Docker (for Postgres), internet access to AWS S3.

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt          # Linux/macOS: .venv/bin/pip

# Postgres for the frame index (the app's default DSN points here)
docker run -d --name spherex-db -p 5435:5432 \
  -e POSTGRES_USER=spherex -e POSTGRES_PASSWORD=spherex -e POSTGRES_DB=spherex postgres:16

# Build the index from S3 headers (a quick test, then the full sweep)
.venv/Scripts/python -m src.utils.index.pipeline --last-weeks 2
.venv/Scripts/python -m src.utils.index.pipeline --release qr3 qr2 --detectors 1 2 3 4 5 6

# Start the app → http://127.0.0.1:8000/
.venv/Scripts/python -m uvicorn src.web.app:app --reload
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `SPHEREX_DSN` | `postgresql://spherex:spherex@localhost:5435/spherex` | Postgres connection string of the frame index |
| `DB_PASSWORD` | – | used by `deploy/docker-compose.yml` for the production database |

No API keys are needed: S3, SIMBAD and the Gaia archive are queried anonymously.

## Deployment

- `Dockerfile` builds the app image (Python 3.12 slim, one Uvicorn worker).
- `deploy/docker-compose.yml` runs three services:
  - `db`: Postgres 16;
  - `app`: the viewer;
  - `caddy`: a reverse proxy with automatic HTTPS for `blink-comparator.de` (see `deploy/Caddyfile`).
- GitHub Actions:
  - `.github/workflows/ci.yml` runs the tests on every push and pull request;
  - `.github/workflows/deploy.yml` deploys `main` over SSH after a successful CI run (`git pull`,
    `docker compose up -d --build`). Host, user and key are repository secrets.

## Tests

```bash
.venv/Scripts/python -m pytest tests
```

80 unit tests cover:
- FITS header parsing, stacking, epoch differences, time windows and visits;
- photometry and spectral features;
- catalog proper-motion propagation and merging;
- the motion lookup (Gaia → SIMBAD fallback, cache TTL);
- "objects near a point", name search and preset consistency.

## Limitations

- **Saturation.** Bright stars saturate the core. Barnard's Star in D1–D4; R Draconis in all six detectors. Fluxes
  there are too low, and the Spectrum window flags and skips such detectors.
- **Faint targets.** WISE 0855 reaches only S/N ≈ 5 per epoch in D6. With ~1.4 years of data its motion between
  well-covered epochs is below one pixel, so it is not measurable.
- **Pixel size and astrometry.** SPHEREx pixels are 6.15″, so close pairs blend (RW Aur A + B, Eps Indi Ba + Bb).
  Stack astrometry has a systematic floor of ~0.5–1″ (0.1–0.15 px).
- **Aperture photometry only.** There is no PSF fitting yet; blends and crowded fields are measured together.
- **Visual search only on the site.** Automated moving-object detection and shift-and-add of all frames along a
  trial motion exist as offline scripts in `demo/`.
- **Visits are defined per detector.** For fields near the ecliptic pole (R Dra) other detectors may be observed in
  different months, so some visit pairs cannot be compared per detector.
- **External services.**
  - The NASA/IPAC IRSA services are not reachable from the production server. Proper motions therefore come from
    the ESA Gaia archive (async jobs) and SIMBAD.
  - During Gaia archive maintenance only SIMBAD is used.
- **No independent check of fluxes.** Our photometry has not yet been compared with the IRSA SPHEREx
  Spectrophotometry Tool.

## Team

- **Henry**: team captain, scientific guidance
- **Nazar Kozak**: data engineering, backend, deployment
- **Vira Pisotska**: UI/UX design, BI analytics

## Data and credits

- **SPHEREx:** data from NASA/JPL-Caltech/IPAC, distributed through the NASA/IPAC Infrared Science Archive and the
  AWS Open Data registry (`nasa-irsa-spherex`).
- **Gaia:** data from the European Space Agency mission *Gaia* (<https://www.cosmos.esa.int/gaia>), processed by the
  Gaia Data Processing and Analysis Consortium (DPAC).
- **SIMBAD:** the SIMBAD database, operated at CDS, Strasbourg, France.
- **Proper motion of WISE 0855−0714:** Kirkpatrick et al. (2019), via SIMBAD.
- **Sky sphere:** `src/web/static/app/data/sky.json` is reduced from [d3-celestial](https://github.com/ofrohn/d3-celestial)
  (`data/stars.6.json`, `constellations.lines.json`, `constellations.json`), © 2015 Olaf Frohn, BSD-3-Clause (full text:
  `src/web/static/app/data/LICENSE-d3-celestial.txt`); we kept 10 constellations and rounded the coordinates (`scripts/build_sky_data.py` rebuilds the file). Stars:
  *XHIP: An Extended Hipparcos Compilation*, Anderson E., Francis C., 2012, Astronomy Letters 38, 331,
  [doi:10.1134/S1063773712050015](https://doi.org/10.1134/S1063773712050015), via CDS/VizieR (catalogue V/137D,
  2013yCat.5137....0A). Constellation lines after the IAU and *Sky & Telescope* constellation charts (Roger Sinnott, Rick Fienberg,
  Alan MacRobert), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as adapted by Olaf Frohn.
- **Software:** Astropy, NumPy, FastAPI, Uvicorn, psycopg, PostgreSQL, Caddy, Docker.

## Use of AI

TODO: to be written by the team before submission.

## License

TODO: license
