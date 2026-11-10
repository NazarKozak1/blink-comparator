import io

import numpy as np
from PIL import Image

from src.web.image_processing import diff_png, significance


def test_significance_is_calibrated_to_unit_scatter():
    rng = np.random.default_rng(1)
    a, b = rng.normal(0, 2, (80, 80)), rng.normal(0.5, 2, (80, 80))   # sigma from VARIANCE says 1, real is 2
    s, offset, scale = significance(a, b, np.ones_like(a), np.ones_like(b))
    assert abs(np.median(s)) < 0.05
    assert abs(1.4826 * np.median(np.abs(s)) - 1) < 0.05
    assert abs(scale - 2) < 0.15 and abs(offset - 0.5 / np.sqrt(2)) < 0.2


def test_new_source_is_white_and_vanished_is_black():
    rng = np.random.default_rng(2)
    a, b = rng.normal(0, 1, (60, 60)), rng.normal(0, 1, (60, 60))
    a[10, 10] += 30          # was there, gone in B
    b[40, 40] += 30          # appeared in B
    s, _, _ = significance(a, b, np.ones_like(a), np.ones_like(b))
    assert s[40, 40] > 5 and s[10, 10] < -5
    png = Image.open(io.BytesIO(diff_png(s, np.ones_like(s, bool), size=60, marks=False).png)).convert("L")
    img = np.asarray(png)[::-1]                      # row 0 of the array is south
    assert img[40, 40] == 255 and img[10, 10] == 0
    assert 100 < np.median(img) < 155                # unchanged sky is grey


def test_nan_pixels_stay_grey():
    s = np.zeros((20, 20))
    s[5, 5] = np.nan
    img = np.asarray(Image.open(io.BytesIO(diff_png(s, np.ones_like(s, bool), size=20, marks=False).png)).convert("L"))
    assert img[::-1][5, 5] == 127 or img[::-1][5, 5] == 128
