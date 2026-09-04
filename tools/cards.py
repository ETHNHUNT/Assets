import re, html
TAG = re.compile(r'<[^>]+>')

def _t(s):
    s = re.sub(r'<br\s*/?>', '\n', s)
    return re.sub(r'[ \t]+', ' ', html.unescape(TAG.sub('', s))).strip()

CARD = re.compile(
    r'<h3[^>]*>(?P<name>[^<]{1,120})</h3>\s*'
    r'(?:<span[^>]*>(?P<cat>[^<]{1,60})</span>\s*)?'
    r'.{0,400}?'
    r'<p[^>]*\btabindex="0"[^>]*>(?P<prompt>.{40,6000}?)</p>',
    re.S)

def extract_cards(h, url):
    out = []
    for m in CARD.finditer(h):
        p = _t(m.group('prompt'))
        if len(p) < 40:
            continue
        out.append({
            "name": _t(m.group('name')),
            "category": _t(m.group('cat') or '') or None,
            "prompt": p,
            "source_url": url,
        })
    return out
