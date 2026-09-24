import re

import pytest


@pytest.mark.parametrize("path", ["/", "/connect"])
def test_page_has_theme_toggle_and_dark_palette(client, path):
    html = client.get(path).text
    assert 'id="themeToggle"' in html
    assert ':root[data-theme="dark"]' in html
    # theme is applied by a <head> script before the stylesheet, so there's no light flash
    head = html.split("</head>")[0]
    assert re.search(r"<script>[^<]*minty-theme[^<]*</script>\s*<style>", head)
