import re, sys
sys.path.insert(0, '.')
from assetfilter import is_content_asset
from extract import get_payload, js_strings

def read_string_at(p, k):
    """If p[k]=='\"', return (value, end_index_after_closing_quote)."""
    if k >= len(p) or p[k] != '"':
        return None, k
    j = k + 1; buf = []
    while j < len(p):
        d = p[j]
        if d == '\\':
            nxt = p[j+1] if j+1 < len(p) else ''
            if nxt == 'u':
                try:
                    buf.append(chr(int(p[j+2:j+6], 16))); j += 6; continue
                except Exception:
                    buf.append(nxt); j += 2; continue
            if nxt == 'x':
                try:
                    buf.append(chr(int(p[j+2:j+4], 16))); j += 4; continue
                except Exception:
                    buf.append(nxt); j += 2; continue
            buf.append({'n':'\n','t':'\t','r':'\r','"':'"','\\':'\\','/':'/','b':'\b','f':'\f'}.get(nxt, nxt))
            j += 2; continue
        if d == '"':
            return "".join(buf), j + 1
        buf.append(d); j += 1
    return "".join(buf), j

def scalar_after(p, field, start, end, back=False):
    """Find `field:` within [start,end) and return its string/number value."""
    rx = re.compile(r'(?<![A-Za-z0-9_$])' + re.escape(field) + r'\s*:\s*')
    seg = p[start:end]
    ms = list(rx.finditer(seg))
    if not ms:
        return None
    m = ms[-1] if back else ms[0]
    k = start + m.end()
    if k < len(p) and p[k] == '"':
        v, _ = read_string_at(p, k)
        return v
    m2 = re.match(r'(-?\d+(?:\.\d+)?|null|!0|!1|void 0|true|false)', p[k:k+24])
    if m2:
        t = m2.group(1)
        return {'null': None, 'void 0': None, '!0': True, '!1': False}.get(t, t)
    # field:$R[n]={ ...  -> nested, return marker
    if p[k:k+2] == '$R':
        return '<obj>'
    return None

def nested_name(p, field, start, end):
    """For `field:$R[n]={id:"..",name:"..."}` return the name."""
    rx = re.compile(r'(?<![A-Za-z0-9_$])' + re.escape(field) + r'\s*:\s*\$R\[\d+\]=\{')
    m = rx.search(p, start, end)
    if not m:
        return None
    return scalar_after(p, 'name', m.end(), min(m.end() + 400, len(p)))

PROMPT_RX = re.compile(r'(?<![A-Za-z0-9_$])prompt\s*:\s*(?:\$R\[\d+\]=)?\{\s*prompt\s*:\s*"')

def extract_jobs(htmltext, url):
    p = get_payload(htmltext)
    if not p:
        return []
    out = []
    for m in PROMPT_RX.finditer(p):
        qpos = p.index('"', m.end() - 1)
        text, endq = read_string_at(p, qpos)
        if not text or not text.strip():
            continue
        back = p[max(0, m.start() - 6000):m.start()]
        boff = max(0, m.start() - 6000)
        fwd_end = min(len(p), endq + 4000)
        rec = {
            "prompt": text.strip(),
            "source_url": url,
            "job_set_type": scalar_after(p, 'jobSetType', boff, m.start(), back=True),
            "asset_layer": scalar_after(p, 'assetTypeLayer', boff, m.start(), back=True),
            "preset_name": nested_name(p, 'presetMeta', boff, m.start()),
            "quality": scalar_after(p, 'quality', endq, fwd_end),
            "seed": scalar_after(p, 'seed', endq, fwd_end),
            "aspect_ratio": scalar_after(p, 'aspectRatio', endq, fwd_end),
            "duration": scalar_after(p, 'duration', endq, fwd_end),
            "username": scalar_after(p, 'username', endq, fwd_end),
            "enhanced": scalar_after(p, 'enhance', endq, min(endq + 200, len(p))),
        }
        mb = extract_media_block(p, endq, fwd_end)
        rec.update(mb)
        rec["media_url"] = mb.get("full_res_url")
        rec["extra_assets"] = [pair for pair in extract_extra_assets(p, endq, fwd_end)
                               if pair[0] != mb.get("full_res_url")]
        out.append(rec)
    return out


# ---------- exact media pairing ----------
def _str(seg, name):
    m = re.search(r'(?<![A-Za-z0-9_$])' + re.escape(name) + r'\s*:\s*"([^"]*)"', seg)
    return m.group(1) if m else None

def _num(seg, name):
    m = re.search(r'(?<![A-Za-z0-9_$])' + re.escape(name) + r'\s*:\s*(\d+)', seg)
    return int(m.group(1)) if m else None

MEDIA_RX = re.compile(r'(?<![A-Za-z0-9_$])media\s*:\s*(?:\$R\[\d+\]=)?\{')

def extract_media_block(p, start, end):
    """Parse the job's own media:{assetType,rawUrl,media:{source,thumbnail,w,h},meta:{aspectRatio}}."""
    m = MEDIA_RX.search(p, start, end)
    if not m:
        return {}
    seg = p[m.start():min(m.start() + 1600, len(p))]
    inner = ''
    im = MEDIA_RX.search(seg, 5)
    if im:
        inner = seg[im.start():im.start() + 700]
    raw = _str(seg, 'rawUrl')
    src = _str(inner, 'source') or _str(seg, 'source')
    thumb = _str(inner, 'thumbnail') or _str(seg, 'thumbnail') or _str(seg, 'posterUrl')
    atype = _str(seg, 'assetType')
    if not atype:
        probe = raw or src or ''
        atype = 'video' if probe.lower().endswith(('.mp4', '.webm', '.mov')) else 'image'
    return {
        "asset_type": atype,
        "full_res_url": raw or src,
        "media_source": src,
        "poster_url": thumb,
        "width": _num(inner, 'width') or _num(seg, 'width'),
        "height": _num(inner, 'height') or _num(seg, 'height'),
        "aspect_ratio_meta": _str(seg, 'aspectRatio'),
    }

VIDEOS_RX = re.compile(r'(?<![A-Za-z0-9_$])videos\s*:\s*(?:\$R\[\d+\]=)?\{')

_ASSET_RX = re.compile(r'(?<![A-Za-z0-9_$])(?:url|source|rawUrl)\s*:\s*"'
                       r'(https://[^"]+\.(?:mp4|webm|mov|png|jpg|jpeg|webp))"')
_POSTER_RX = re.compile(r'(?<![A-Za-z0-9_$])(?:thumbnail|posterUrl|poster_url|video_poster)\s*:\s*"'
                        r'(https://[^"]+)"')
_PLACEHOLDER_RX = re.compile(r'(?<![A-Za-z0-9_$])placeholder\s*:\s*"(data:image/[^"]{40,})"')

def extract_extra_assets(p, start, end, limit=8):
    """Additional sample assets near a record, each paired with its poster.

    The payload states the pairing explicitly -- e.g. a motion preview is
    ``preview:{source:".../kling_motion/A.mp4", thumbnail:".../kling_motion/B.webp",
    placeholder:"data:image/webp;base64,..."}`` -- and the thumbnail's id is unrelated
    to the video's, so it can only be read, never derived. Returns ``[url, poster]``
    pairs (poster may be None), which JSON-serialise as two-element lists.
    """
    seg = p[start:end]
    hits = list(_ASSET_RX.finditer(seg))
    out, seen = [], set()
    for i, m in enumerate(hits):
        u = m.group(1)
        if u in seen or not is_content_asset(u):
            continue
        seen.add(u)
        nxt = hits[i + 1].start() if i + 1 < len(hits) else min(m.end() + 400, len(seg))
        window = seg[m.end():max(m.end(), nxt)]
        pm = _POSTER_RX.search(window)
        poster = pm.group(1) if pm and is_content_asset(pm.group(1)) else None
        if poster is None:
            back = seg[max(0, m.start() - 300):m.start()]
            pm2 = _POSTER_RX.search(back)
            if pm2 and is_content_asset(pm2.group(1)):
                poster = pm2.group(1)
        if poster is None:
            ph = _PLACEHOLDER_RX.search(window)
            if ph:
                poster = ph.group(1)          # inline LQIP, usable with no network
        out.append([u, poster])
        if len(out) >= limit:
            break
    return out
