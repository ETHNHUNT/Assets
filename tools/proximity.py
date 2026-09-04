"""Pair a prompt with the nearest media element in the rendered DOM.

Weaker than the exact `media:` block pairing, so records resolved this way are
tagged media_pairing="proximity" and can be filtered out downstream.
"""
import re, html, sys
sys.path.insert(0, '.')
from assetfilter import is_content_asset

MEDIA_RX = re.compile(
    r'<(?:video|img|source)\b[^>]*?\ssrc="([^"]+)"[^>]*>|<video\b[^>]*?\sposter="([^"]+)"[^>]*>',
    re.I)
SKIP = ('icon', 'logo', 'favicon', '.svg', 'country-flags', 'avatar',
        'clerk', 'googletagmanager', 'thumbnail/default', 'data:')

def _clean(u):
    u = html.unescape(u)
    if any(s in u.lower() for s in SKIP):
        return None
    if u.startswith('/'):
        u = 'https://higgsfield.ai' + u
    if not is_content_asset(u):
        return None
    return u

def build_index(h):
    """[(position, url)] of every usable media element, in document order."""
    out = []
    for m in MEDIA_RX.finditer(h):
        u = _clean(m.group(1) or m.group(2) or '')
        if u:
            out.append((m.start(), u))
    return out

def nearest(index, pos, max_dist=14000):
    """Closest media to pos, preferring one that follows the text."""
    best, bestd = None, None
    for p, u in index:
        d = (p - pos) if p >= pos else int((pos - p) * 1.6)  # bias toward following media
        if d > max_dist:
            continue
        if bestd is None or d < bestd:
            best, bestd = u, d
    return best

def find_text_pos(h, text):
    """Locate a prompt's rendered text in the HTML."""
    probe = html.escape(text[:60]).replace('&#x27;', "'")
    i = h.find(probe)
    if i < 0:
        i = h.find(text[:60])
    if i < 0:
        words = [w for w in text.split()[:8] if len(w) > 4]
        if words:
            i = h.find(words[0])
    return i
