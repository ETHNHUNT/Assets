import re, html, glob, os
from urllib.parse import urlparse, parse_qs, unquote_plus

def srcurl(h):
    m = re.match(r'<!--SRCURL:(.*?)-->', h)
    return m.group(1) if m else None

def extract_recreate(h, url):
    out = []
    for m in re.finditer(r'href="([^"]*[?&]recreate=[^"]*)"', h):
        raw = html.unescape(m.group(1))
        u = raw if raw.startswith('http') else 'https://higgsfield.ai' + raw
        q = parse_qs(urlparse(u).query)
        p = (q.get('recreate') or [''])[0].strip()
        if len(p) < 15:
            continue
        out.append({
            "prompt": p,
            "model": (q.get('model') or [None])[0],
            "preset": (q.get('preset') or q.get('style') or [None])[0],
            "motion": (q.get('motion') or [None])[0],
            "target_path": urlparse(u).path,
            "source_url": url,
        })
    return out
