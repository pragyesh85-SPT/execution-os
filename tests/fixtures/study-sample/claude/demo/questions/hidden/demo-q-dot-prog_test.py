import math


def test_same_direction():
    assert abs(entry([1, 0], [2, 0]) - 1) < 1e-9


def test_perpendicular():
    assert abs(entry([1, 0], [0, 3])) < 1e-9


def test_45_degrees():
    assert abs(entry([1, 0], [1, 1]) - math.sqrt(0.5)) < 1e-9
