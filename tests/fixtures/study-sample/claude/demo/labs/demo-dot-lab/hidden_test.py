def test_simple():
    assert entry([1, 2], [3, 4]) == 11


def test_perpendicular():
    assert entry([1, 0], [0, 5]) == 0


def test_longer():
    assert entry([1, 2, 3], [4, 5, 6]) == 32
