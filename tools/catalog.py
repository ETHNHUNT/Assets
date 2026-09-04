import re, html, sys, json
sys.path.insert(0, '.')
from extract import get_payload
from jobs import scalar_after, extract_extra_assets
from assetfilter import is_content_asset

def meta(h, name):
    m = re.search(r'<meta\s+(?:name|property)="' + re.escape(name) + r'"\s+content="([^"]*)"', h)
    if not m:
        m = re.search(r'<meta\s+content="([^"]*)"\s+(?:name|property)="' + re.escape(name) + r'"', h)
    return html.unescape(m.group(1)) if m else None

def title(h):
    m = re.search(r'<title>([^<]*)</title>', h)
    return html.unescape(m.group(1)).strip() if m else None

def jsonld(h):
    out = []
    for s in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', h, flags=re.S):
        try:
            out.append(json.loads(html.unescape(s.strip())))
        except Exception:
            pass
    return out

def clean_title(t):
    if not t:
        return None
    for sep in [' • ', ' — ', ' | ', ' - ']:
        if sep in t:
            t = t.split(sep)[0]
    return t.strip()

def extract_catalog(h, url):
    """Preset / motion catalog entry: name + description + model."""
    p = get_payload(h)
    name = None
    for ld in jsonld(h):
        if isinstance(ld, dict) and ld.get('@type') in ('WebPage', 'Product', 'CreativeWork') and ld.get('name'):
            name = ld['name']; break
    if not name:
        name = clean_title(title(h))
    desc = meta(h, 'description') or meta(h, 'og:description')
    model = None
    if p:
        for f in ('model', 'jobSetType', 'motionModel'):
            v = scalar_after(p, f, 0, len(p))
            if v and v != '<obj>':
                model = v; break
    # ---- media: prefer the DOM <video src poster>, then payload preview, then og:image ----
    def ok(u):
        return is_content_asset(u)

    primary, poster, extras = None, None, []
    vids = re.findall(r'<video[^>]*>', h)
    for tag in vids:
        sm = re.search(r'\ssrc="([^"]+)"', tag)
        pm = re.search(r'\sposter="([^"]+)"', tag)
        cand = html.unescape(sm.group(1)) if sm else None
        if ok(cand):
            primary = cand
            if pm and ok(html.unescape(pm.group(1))):
                poster = html.unescape(pm.group(1))
            break
    # every distinct sample on the page becomes an example asset
    for tag in vids:
        sm = re.search(r'\ssrc="([^"]+)"', tag)
        pm3 = re.search(r'\sposter="([^"]+)"', tag)
        if sm:
            u = html.unescape(sm.group(1))
            po = html.unescape(pm3.group(1)) if pm3 and ok(html.unescape(pm3.group(1))) else None
            if ok(u) and u != primary and u not in [e[0] for e in extras]:
                extras.append([u, po])

    if p:
        if not primary:
            pm2 = re.search(r'(?<![A-Za-z0-9_$])preview\s*:\s*(?:\$R\[\d+\]=)?\{', p)
            if pm2:
                seg = p[pm2.start():pm2.start() + 600]
                sm2 = re.search(r'source\s*:\s*"(https://[^"]+)"', seg)
                tm2 = re.search(r'thumbnail\s*:\s*"(https://[^"]+)"', seg)
                if sm2 and ok(sm2.group(1)):
                    primary = sm2.group(1)
                if tm2 and ok(tm2.group(1)) and not poster:
                    poster = tm2.group(1)
        if not primary:
            um = re.search(r'name:"[^"]*",url:"(https://[^"]+\.(?:mp4|webp|png|jpg))"', p)
            if um and ok(um.group(1)):
                primary = um.group(1)
        for u, po in extract_extra_assets(p, 0, len(p), limit=12):
            if ok(u) and u != primary and u not in [e[0] for e in extras]:
                extras.append([u, po])

    if not poster:
        cand = meta(h, 'og:image') or meta(h, 'twitter:image')
        poster = cand if ok(cand) else None
    if not primary and extras:
        first = extras.pop(0)
        primary, poster = first[0], (poster or first[1])
    if not primary and poster:
        primary = poster
    atype = 'video' if (primary or '').lower().endswith(('.mp4', '.webm', '.mov')) else 'image'
    return {
        "name": clean_title(name),
        "description": (desc or '').strip() or None,
        "model": model,
        "source_url": url,
        "full_res_url": primary,
        "poster_url": poster,
        "asset_type": atype if primary else None,
        "extra_assets": extras,
    }
