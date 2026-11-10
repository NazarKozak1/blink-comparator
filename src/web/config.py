"""Constants of the SPHEREx data, the index database and the web app."""
import os

BUCKET = "nasa-irsa-spherex"
DSN = os.getenv("SPHEREX_DSN", "postgresql://spherex:spherex@localhost:5435/spherex")

PIXEL_ARCSEC = 6.15
HEAD_BYTES = 120_000                  # primary + IMAGE headers incl. SIP coefficients
WAVE_TAIL_BYTES = (32_768, 262_144)   # suffix reads for the last HDU (WCS-WAVE): normal, fallback
SEARCH_RADIUS_DEG = 2.5               # > half-diagonal of a 3.5 deg frame, exact check is done with WCS
FIT_MARGIN_PX = 1.0                   # cutout corners may stick out of the frame by this much
MAX_FRAMES = 200                      # index candidates checked per request, spread over epochs
EXT_HEADER_BYTES = 28_800             # first read of an extension header (FLAGS/VARIANCE ~11-15 KB)
BLOCK_CACHE_SIZE = 1024               # cached pixel blocks per layer, cropped to the cutout (~10-20 KB each)
S3_WORKERS = 32                       # parallel S3 reads

# Time windows: a new epoch starts after a gap > 30 days or when the epoch would exceed 30 days.
EPOCH_GAP_DAYS = 30
EPOCH_MAX_DAYS = 30

# Stacking and display
STACK_METHODS = ("minmax", "sigma", "mean")
MIN_VALID_ROBUST = 5                  # fewer valid values -> weighted mean instead of minmax/sigma
CONTRAST_PERCENTILES = (1.0, 99.5)
ASINH_SOFTENING = 0.1                 # asinh(x / a) on [0, 1]; smaller = stronger compression
# Contrast presets (scale=mjy and stacks): upper percentile of the automatic limits, asinh softening.
# faint: bright targets saturate, faint stars of the field show; bright: keeps structure in bright cores.
STRETCHES = {"faint": (98.0, 0.02), "normal": (CONTRAST_PERCENTILES[1], ASINH_SOFTENING), "bright": (99.95, 0.5)}

# Conventional spectral bands: each detector range split into 17 bins equal in log(lambda).
N_BANDS = 17
DETECTOR_RANGE_UM = {1: (0.75, 1.10), 2: (1.10, 1.62), 3: (1.62, 2.42),
                     4: (2.42, 3.82), 5: (3.82, 4.42), 6: (4.42, 5.00)}
