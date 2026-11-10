import numpy as np
import pytest

from src.web.image_processing import combine, fill_nans


def _cube(values, shape=(2, 3)):
    """Each frame is a constant image with the given value."""
    return np.stack([np.full(shape, v, dtype=np.float32) for v in values])


def test_mean_is_weighted():
    out = combine(_cube([1.0, 3.0]), _cube([3.0, 1.0]), "mean")
    assert np.allclose(out, 1.5)


def test_minmax_drops_one_highest_and_one_lowest():
    out = combine(_cube([0.0, 10.0, 11.0, 12.0, 100.0]), method="minmax")
    assert np.allclose(out, 11.0)


def test_minmax_falls_back_to_weighted_mean_below_min_valid():
    values = [0.0, 10.0, 11.0, 100.0]
    out = combine(_cube(values), method="minmax")
    assert np.allclose(out, np.mean(values))


def test_sigma_rejects_outlier():
    values = [10.0, 10.2, 9.8, 10.1, 9.9, 10.0, 10.1, 9.9, 1000.0]
    out = combine(_cube(values), method="sigma")
    assert out[0, 0] == pytest.approx(10.0, abs=0.05)


def test_sigma_falls_back_below_min_valid():
    values = [10.0, 10.0, 10.0, 1000.0]
    out = combine(_cube(values), method="sigma")
    assert np.allclose(out, np.mean(values))


@pytest.mark.parametrize("method", ["minmax", "sigma", "mean"])
def test_nan_values_and_bad_weights_are_ignored(method):
    cube = _cube([5.0, 5.0, 5.0, 5.0, 5.0, 5.0])
    cube[0, 0, 0] = np.nan
    w = np.ones_like(cube)
    w[1, 0, 0] = np.nan
    w[2, 0, 0] = 0.0
    cube[3, 0, 0] = 1e6                      # weight 0 below makes it invisible
    w[3, 0, 0] = -1.0
    out = combine(cube, w, method)
    assert np.allclose(out, 5.0)


def test_pixel_without_valid_values_is_nan():
    cube = _cube([1.0, 2.0])
    cube[:, 0, 0] = np.nan
    out = combine(cube, method="mean")
    assert np.isnan(out[0, 0]) and np.allclose(out[1:, :], 1.5)


def test_minmax_with_equal_values_keeps_value():
    out = combine(_cube([7.0] * 6), method="minmax")
    assert np.allclose(out, 7.0)


def test_unknown_method_raises():
    with pytest.raises(ValueError):
        combine(_cube([1.0]), method="median")


def test_fill_nans_fills_large_hole_completely():
    img = np.ones((40, 40), np.float32)
    img[15:25, 15:25] = np.nan               # 10 px hole, like a saturated star core
    out = fill_nans(img)
    assert not np.isnan(out).any() and np.allclose(out, 1.0, atol=1e-5)


def test_fill_nans_respects_mask():
    img = np.ones((20, 20), np.float32)
    img[:, :5] = np.nan                      # not covered by any frame
    img[10, 10] = np.nan                     # hole inside the covered area
    covered = np.ones_like(img, bool)
    covered[:, :5] = False
    out = fill_nans(img, covered)
    assert np.isfinite(out[10, 10]) and np.isnan(out[:, :5]).all()
