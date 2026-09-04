import re, html

TAG = re.compile(r'<[^>]+>')
WS = re.compile(r'\s+')

def txt(s):
    s = re.sub(r'<script.*?</script>', ' ', s, flags=re.S)
    s = re.sub(r'<style.*?</style>', ' ', s, flags=re.S)
    return WS.sub(' ', html.unescape(TAG.sub(' ', s))).strip()

BADGES = {
    'tiktok': 'TikTok', 'instagram reels': 'Instagram Reels', 'youtube shorts': 'YouTube Shorts',
    'standard': 'Standard', 'pro': 'Pro', 'visual boost': 'Visual Boost', 'sound boost': 'Sound Boost',
    'turbo': 'Turbo', 'quality': 'Quality', 'lite': 'Lite',
}

def find_blocks(h):
    """Yield (block_html,) for each <figure>...</figure>."""
    for m in re.finditer(r'<figure\b', h):
        depth = 0; i = m.start(); n = len(h)
        j = i
        while j < n:
            o = h.find('<figure', j + 1)
            c = h.find('</figure>', j + 1)
            if c == -1: break
            if o != -1 and o < c:
                depth += 1; j = o
            else:
                if depth == 0:
                    yield h[i:c + 9]; break
                depth -= 1; j = c
        else:
            continue

def extract_figures(h, url):
    out = []
    for blk in find_blocks(h):
        caps = re.findall(r'<figcaption[^>]*>(.*?)</figcaption>', blk, flags=re.S)
        cap = txt(caps[0]) if caps else ''
        if not cap:
            al = re.findall(r'aria-label="([^"]{25,})"', blk)
            cap = html.unescape(al[0]).strip() if al else ''
        if not cap or len(cap) < 25:
            continue
        media = None
        mm = re.search(r'<(?:video|source|img)[^>]*\ssrc="([^"]+)"', blk)
        if mm:
            media = html.unescape(mm.group(1))
        rest = txt(re.sub(r'<figcaption[^>]*>.*?</figcaption>', ' ', blk, flags=re.S))
        rest = rest.replace(cap, ' ')
        rest = rest.replace('Your browser does not support the video.', ' ')
        found = []
        low = rest.lower()
        for k, v in BADGES.items():
            if re.search(r'(?<![a-z])' + re.escape(k) + r'(?![a-z])', low):
                found.append(v)
        out.append({
            "prompt": cap,
            "source_url": url,
            "media_url": media,
            "badges": ", ".join(sorted(set(found))) or None,
        })
    return out
