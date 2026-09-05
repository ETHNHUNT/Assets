import re, sys
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, '.')
from extract import get_payload
from jobs import read_string_at
from assetfilter import is_content_asset

# flat shape: `prompt:"..."` NOT immediately opening a prompt-vo object,
# i.e. not `prompt:$R[n]={prompt:"..."` and not `prompt:{prompt:"..."`
FLAT = re.compile(r'(?<![A-Za-z0-9_$])prompt\s*:\s*"')

def _obj_start(p, i):
    """Walk back to the '{' that opens the object containing index i."""
    depth = 0
    j = i
    while j > 0:
        c = p[j]
        if c == '}':
            depth += 1
        elif c == '{':
            if depth == 0:
                return j
            depth -= 1
        j -= 1
    return max(0, i - 2000)

def _field(seg, name):
    m = re.search(r'(?<![A-Za-z0-9_$])' + re.escape(name) + r'\s*:\s*"((?:[^"\\]|\\.)*)"', seg)
    if m:
        return m.group(1).replace('\\"', '"').replace('\\\\', '\\')
    m = re.search(r'(?<![A-Za-z0-9_$])' + re.escape(name) + r'\s*:\s*(-?\d+(?:\.\d+)?)', seg)
    return m.group(1) if m else None

def parse_recreate(u):
    """/generate/image/nano-banana-pro?aspect_ratio=16:9 -> (model, aspect, mode)"""
    if not u:
        return None, None, None
    pr = urlparse(u)
    seg = [s for s in pr.path.strip('/').split('/') if s]
    q = parse_qs(pr.query)
    aspect = (q.get('aspect_ratio') or q.get('aspectRatio') or [None])[0]
    mode = seg[1] if len(seg) > 1 else None
    model = seg[2] if len(seg) > 2 else (q.get('model') or [None])[0]
    return model, aspect, mode

def _page_lesson_media(p):
    """Lesson-level video/poster, used as fallback for cues that don't carry their own."""
    vm = re.search(r'(?<![A-Za-z0-9_$])video\s*:\s*"(https://[^"]+\.(?:mp4|webm|mov))"', p)
    pm = re.search(r'(?<![A-Za-z0-9_$])video_poster\s*:\s*"(https://[^"]+)"', p)
    tm = re.search(r'(?<![A-Za-z0-9_$])thumbnail\s*:\s*"(https://[^"]+)"', p)
    return (vm.group(1) if vm else None,
            (pm.group(1) if pm else (tm.group(1) if tm else None)))

MEDIA_URL = re.compile(r'"(https://[^"]+\.(?:mp4|webm|mov|webp|png|jpg|jpeg))"')
OUTPUT_RX = re.compile(r'(?<![A-Za-z0-9_$])output\s*:\s*(?:\$R\[\d+\]=)?\{')
_SRC_RX = re.compile(r'(?<![A-Za-z0-9_$])(?:source|url)\s*:\s*"(https://[^"]+)"')
_PH_RX = re.compile(r'(?<![A-Za-z0-9_$])placeholder\s*:\s*"([A-Za-z0-9+/=]{60,}|data:image/[^"]{40,})"')

def _nearest_payload_media(p, lo, hi, window=2500):
    """The sample's own result, as (media, poster).

    A motion sample page lays out ``preset:{preview:{...}}`` *before*
    ``sample:{prompt:"...", ..., output:{source:"...", placeholder:"<base64 webp>"}}``.
    The preset preview is a generic demo of the camera move, not this prompt's result,
    so media that follows the prompt is strongly preferred over anything before it.
    """
    a, b = max(0, lo - window), min(len(p), hi + window)
    om = OUTPUT_RX.search(p, hi, b)
    if om:
        seg = p[om.start():om.start() + 900]
        sm = _SRC_RX.search(seg)
        if sm and is_content_asset(sm.group(1)):
            # the inline LQIP can run to several KB, so search a wider slice for it;
            # it is only a fallback -- a real frame pulled by ffmpeg beats a blurred preview
            ph = _PH_RX.search(p[om.start():om.start() + 12000])
            poster = ph.group(1) if ph else None
            return sm.group(1), poster
    for m in MEDIA_URL.finditer(p, hi, b):          # anything after the prompt
        if is_content_asset(m.group(1)):
            return m.group(1), None
    for m in MEDIA_URL.finditer(p, a, lo):          # only then look backwards
        if is_content_asset(m.group(1)):
            return m.group(1), None
    return None, None

def extract_flat(h, url):
    p = get_payload(h)
    if not p:
        return []
    page_video, page_poster = _page_lesson_media(p)
    pm = re.search(r'(?<![A-Za-z0-9_$])model\s*:\s*"([A-Za-z0-9_.\-]+)"', p)
    page_model = pm.group(1) if pm else None
    out = []
    for m in FLAT.finditer(p):
        qs = m.end() - 1
        # Skip the nested value-object form `prompt:{prompt:"…"}`, which jobs.py owns.
        # The test used to be "does an object open immediately before this?", which also
        # threw away `params:{prompt:"…"}` — a different shape that no other extractor
        # reads, and the reason /soul's 20 sample prompts went uncaptured. Match the
        # enclosing key, not just the brace.
        before = p[max(0, m.start() - 40):m.start()]
        if re.search(r'(?<![A-Za-z0-9_$])prompt\s*:\s*(?:\$R\[\d+\]=)?\{\s*$', before):
            continue
        text, endq = read_string_at(p, qs)
        if not text or len(text.strip()) < 20:
            continue
        near_media, near_poster = _nearest_payload_media(p, m.start(), endq)
        s = _obj_start(p, m.start())
        seg = p[s:endq + 900]
        rec_url = _field(seg, 'recreate_url') or _field(seg, 'recreateUrl')
        model, aspect, mode = parse_recreate(rec_url)
        # lesson / page context sits in the enclosing record
        ctx = p[max(0, s - 4000):s]
        lesson = None
        lm = list(re.finditer(r'slug:"([^"]+)",title:"((?:[^"\\]|\\.)*)"', ctx))
        if lm:
            lesson = lm[-1].group(2).replace('\\"', '"')
        out.append({
            "prompt": text.strip(),
            "source_url": url,
            "name": _field(seg, 'title'),
            "cue_id": _field(seg, 'id'),
            "recreate_url": rec_url,
            "recreate_model": model or page_model,
            "aspect_ratio": aspect,
            "mode": mode,
            "start_seconds": _field(seg, 'start_seconds'),
            "end_seconds": _field(seg, 'end_seconds'),
            "lesson_title": lesson,
            "media_url": (_field(ctx, 'video') or _field(seg, 'video') or page_video
                          or near_media),
            "poster_url": (_field(ctx, 'video_poster') or _field(ctx, 'thumbnail')
                           or _field(seg, 'thumbnail') or near_poster or page_poster),
            "media_pairing": "lesson" if (page_video or _field(ctx, 'video')) else "payload-proximity",
        })
    return out
