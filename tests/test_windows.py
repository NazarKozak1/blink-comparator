from datetime import datetime, timedelta, timezone

from src.web.windows import days, epochs, spread_over_epochs

T0 = datetime(2025, 8, 15, 12, 0, tzinfo=timezone.utc)


def _times(day_offsets):
    return [T0 + timedelta(days=d) for d in day_offsets]


def test_gap_over_30_days_starts_new_epoch():
    w = epochs(_times([0, 1, 2, 40, 41]))
    assert [x.n_frames for x in w] == [3, 2]
    assert w[0].start == T0 and w[0].end == T0 + timedelta(days=2)


def test_gap_of_exactly_30_days_does_not_split():
    assert len(epochs(_times([0, 30]))) == 1


def test_epoch_longer_than_30_days_is_split():
    # gaps of 10 days never exceed the gap limit, but the epoch would span 40 days
    w = epochs(_times([0, 10, 20, 30, 40]))
    assert [x.n_frames for x in w] == [4, 1]


def test_barnard_like_layout_gives_four_epochs():
    # 15-27.08.2025, 19.03-10.04.2026, 4-5.05.2026, 16-20.08.2026 (as in the index for D3)
    base = datetime(2025, 8, 15, tzinfo=timezone.utc)
    times = [base + timedelta(days=d) for d in [0, 6, 12, 216, 228, 238, 262, 263, 366, 370]]
    assert len(epochs(times)) == 4


def test_days_group_by_utc_date():
    times = [datetime(2025, 9, 6, 23, 59, tzinfo=timezone.utc), datetime(2025, 9, 7, 0, 1, tzinfo=timezone.utc),
             datetime(2025, 9, 7, 5, 0, tzinfo=timezone.utc)]
    w = days(times)
    assert [x.n_frames for x in w] == [1, 2]
    assert w[1].start == datetime(2025, 9, 7, tzinfo=timezone.utc)
    assert all(w_.start <= t <= w_.end for w_, ts in zip(w, [times[:1], times[1:]]) for t in ts)


def test_empty_input():
    assert epochs([]) == [] and days([]) == []


def test_spread_keeps_everything_under_the_limit():
    assert spread_over_epochs(_times([0, 1, 50]), 10) == [0, 1, 2]


def test_spread_keeps_every_epoch_and_the_limit():
    # a small epoch (3 frames) between two big ones (300 frames each, 0.05 d apart)
    t = _times([k * 0.05 for k in range(300)] + [100, 101, 102] + [200 + k * 0.05 for k in range(300)])
    idx = spread_over_epochs(t, 200)
    assert len(idx) == 200 and idx == sorted(set(idx))
    per_epoch = [sum(a <= i < b for i in idx) for a, b in ((0, 300), (300, 303), (303, 603))]
    assert per_epoch == [98, 3, 99] or per_epoch == [99, 3, 98]
    assert idx[0] == 0 and idx[-1] == 602            # epoch edges are kept
