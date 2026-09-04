"""Single source of truth for 'is this a generated sample, or site chrome?'"""
import re

CHROME = re.compile(
    r'(/profile/(avatar|banner)|/country-flags/|/thumbnail/default|'
    r'(^|/)(avatar|banner|logo|icon|favicon|placeholder|sprite|og-image)[-_.]|'
    r'(^|/)(avatar|banner|logo|icon|favicon|placeholder|og-image)\.(png|jpg|jpeg|webp|svg)$|'
    r'/landing/static/|/static/ui/|/assets/ui/|clerk\.|googletagmanager|'
    r'(glow|gradient|blob|ellipse)[-_.]?\d*\.(png|webp|jpg)$)', re.I)

MEDIA_EXT = ('.mp4', '.webm', '.mov', '.m4v', '.png', '.jpg', '.jpeg', '.webp')

def is_content_asset(u):
    """True when the URL looks like a generated sample rather than page furniture."""
    if not u or not u.startswith('http'):
        return False
    if '.svg' in u.lower():
        return False
    if CHROME.search(u):
        return False
    low = u.lower().split('?')[0]
    return low.endswith(MEDIA_EXT)
