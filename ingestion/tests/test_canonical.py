import pytest

from ig_ingest.canonical import InputError, Target, parse_target


@pytest.mark.parametrize("raw,expected", [
    ("nasa", Target("profile", "nasa")),
    ("@Some.Bistro", Target("profile", "some.bistro")),
    ("instagram.com/some_bistro", Target("profile", "some_bistro")),
    ("https://www.instagram.com/nasa/?hl=en", Target("profile", "nasa")),
    ("https://www.instagram.com/nasa/reels/", Target("profile", "nasa")),
    ("https://www.instagram.com/p/DfahZrMjAqq/", Target("post", "DfahZrMjAqq")),
    ("https://instagram.com/reel/DfahZrMjAqq?igsh=abc", Target("post", "DfahZrMjAqq")),
    ("www.instagram.com/reels/C_xYz-12345/", Target("post", "C_xYz-12345")),
    ("https://www.instagram.com/tv/C_xYz12345/#x", Target("post", "C_xYz12345")),
    ("http://instagr.am/p/C_xYz12345/", Target("post", "C_xYz12345")),
    ("https://www.instagram.com/nasa/p/DfahZrMjAqq/", Target("post", "DfahZrMjAqq")),
])
def test_accepts(raw, expected):
    assert parse_target(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "https://example.com/nasa", "https://www.instagram.com/stories/nasa/123/",
    "https://www.instagram.com/explore/tags/food/", "https://www.instagram.com/p/", "bad handle!",
    ".dot", "a..b", "explore", "instagram.com",
])
def test_rejects(raw):
    with pytest.raises(InputError):
        parse_target(raw)


def test_canonical_post_url_is_p_form():
    assert parse_target("https://www.instagram.com/reel/DfahZrMjAqq/").url == "https://www.instagram.com/p/DfahZrMjAqq/"
