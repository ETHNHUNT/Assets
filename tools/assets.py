"""Build the asset manifest and fetch a WebP thumbnail for every paired asset.

Thumbnails come from Higgsfield's own image resizer (images.higgs.ai), which turns a
5 MB PNG into ~50 KB of WebP. The resizer 302s on .mp4, so videos are thumbed from
their poster; when a video has no poster we pull frame 1 with ffmpeg.
"""
import os, re, csv, json, sys, time, hashlib, threading, queue, subprocess, gzip, argparse
import urllib.request, urllib.error
from urllib.parse import quote, urlparse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
RESIZER = "https://images.higgs.ai/?default=1&output=webp&url={}&w={}&q={}"
def _ffmpeg_exe():
    """Playwright's bundled ffmpeg only demuxes webm/matroska and has no h264 decoder,
    so prefer imageio-ffmpeg's full static build when it is installed."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux"

FFMPEG = _ffmpeg_exe()
VIDEO_EXT = ('.mp4', '.webm', '.mov', '.m4v')

def is_video(u, declared=None):
    if declared == 'video':
        return True
    return bool(u) and urlparse(u).path.lower().endswith(VIDEO_EXT)

def record_id(r):
    basis = ((r.get("prompt_text") or "") + "|" + (r.get("name") or "") + "|"
             + (r.get("source_url") or ""))
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]

def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*",
                                               "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data

CMS_HOSTS = ("a.storyblok.com", "cdn.sanity.io", "images.ctfassets.net")

def cms_variant(src, width):
    """Higgsfield's resizer 403s on third-party CMS hosts, but they resize themselves."""
    host = urlparse(src).netloc
    if "storyblok" in host:
        if "/m/" in src:
            return re.sub(r'/m/\d+x\d+/', f'/m/{width}x0/', src)
        return src.rstrip('/') + f'/m/{width}x0/'
    if "sanity" in host and not src.lower().endswith((".mp4", ".webm", ".mov")):
        return src + ("&" if "?" in src else "?") + f"w={width}&fm=webp&q=80"
    return None

def to_webp(data, width):
    """Last-resort local downscale for hosts with no transform of their own."""
    from io import BytesIO
    from PIL import Image
    im = Image.open(BytesIO(data))
    im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
    if im.width > width:
        im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, "WEBP", quality=80, method=4)
    return buf.getvalue()

def thumb_via_resizer(src, width, q=80):
    if urlparse(src).netloc in CMS_HOSTS or any(c in urlparse(src).netloc for c in ("storyblok", "sanity")):
        alt = cms_variant(src, width)
        if alt:
            d = fetch(alt)
            return d if d[:4] == b'RIFF' else to_webp(d, width)
        return to_webp(fetch(src), width)
    return fetch(RESIZER.format(quote(src, safe=''), width, q))

def poster_candidates(video_url):
    """Higgsfield stores video posters on cdn.higgsfield.ai at the same path + _thumbnail.webp."""
    p = urlparse(video_url)
    base = re.sub(r'\.(mp4|webm|mov|m4v)$', '', p.path)
    out = []
    for host in ("cdn.higgsfield.ai", p.netloc, "static.higgsfield.ai"):
        out.append(f"https://{host}{base}_thumbnail.webp")
        out.append(f"https://{host}{base}.webp")
    seen, uniq = set(), []
    for u in out:
        if u not in seen:
            seen.add(u); uniq.append(u)
    return uniq

def thumb_via_ffmpeg(video_url, width):
    """Playwright's ffmpeg has no HTTPS support, so fetch to a temp file first."""
    import tempfile
    tmp = None
    try:
        data = fetch(video_url, timeout=180)
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(data); tmp = f.name
        out = subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", tmp,
             "-frames:v", "1", "-vf", f"scale={width}:-1", "-f", "webp", "pipe:1"],
            capture_output=True, timeout=180)
        return out.stdout if out.returncode == 0 and out.stdout else None
    except Exception:
        return None
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except OSError: pass

def build_rows(dataset, max_extra):
    rows = []
    for r in dataset:
        rid = record_id(r)
        seen = set()
        assets = []
        prim = r.get("full_res_url")
        if prim:
            assets.append((prim, r.get("poster_url"), "primary"))
            seen.add(prim)
        for item in (r.get("extra_assets") or [])[:max_extra]:
            if isinstance(item, (list, tuple)):
                u, po = (list(item) + [None])[:2]
            else:
                u, po = item, None
            if u and u not in seen:
                assets.append((u, po, "example"))
                seen.add(u)
        if not assets and r.get("poster_url"):
            assets.append((r["poster_url"], None, "primary"))
        for i, (u, poster, role) in enumerate(assets):
            rows.append({
                "record_id": rid, "asset_index": i, "role": role,
                "asset_type": "video" if is_video(u, r.get("asset_type") if i == 0 else None) else "image",
                "full_res_url": u, "poster_url": poster or "",
                "thumb_path": f"thumbs/{rid}__{i}.webp",
                "media_pairing": r.get("media_pairing") or "",
                "name": r.get("name") or "", "tool_type": r.get("tool_type") or "",
                "model_or_effect": r.get("model_or_effect") or "",
                "source_url": r.get("source_url") or "",
                "width": r.get("width") or "", "height": r.get("height") or "",
                "prompt_excerpt": re.sub(r'\s+', ' ', (r.get("prompt_text") or r.get("description") or ""))[:300],
            })
    return rows

def run(rows, outdir, width, threads=10, limit=None):
    tdir = os.path.join(outdir, "thumbs")
    os.makedirs(tdir, exist_ok=True)
    # A thumbnail's filename is derived from the record, not the asset URL, so when a
    # pairing fix repoints a record at a different asset the cached file would silently
    # persist and show the wrong picture. This index records which URL each thumbnail
    # was built from and forces a refetch when that changes.
    ipath = os.path.join(outdir, "thumbs.index.json")
    try:
        built = json.load(open(ipath))
    except Exception:
        built = {}
    stale = 0
    for r in rows:
        tp = r.get("thumb_path")
        if not tp:
            continue
        fp = os.path.join(outdir, tp)
        if os.path.exists(fp) and built.get(tp) != r["full_res_url"]:
            try:
                os.unlink(fp); stale += 1
            except OSError:
                pass
    if stale:
        print(f"  invalidated {stale} stale thumbnails (asset URL changed)", flush=True)
    work = rows[:limit] if limit else rows
    q = queue.Queue()
    for r in work:
        q.put(r)
    stat = {"ok": 0, "skip": 0, "fail": 0, "bytes": 0}
    lock = threading.Lock()

    def worker():
        while True:
            try:
                r = q.get_nowait()
            except queue.Empty:
                return
            fp = os.path.join(outdir, r["thumb_path"])
            if os.path.exists(fp) and os.path.getsize(fp) > 200:
                with lock:
                    stat["skip"] += 1; stat["bytes"] += os.path.getsize(fp)
                    built[r["thumb_path"]] = r["full_res_url"]
                continue
            data = None
            po = r.get("poster_url") or ""
            if po.startswith("data:image/") or (po.startswith("UklGR") and "://" not in po):
                try:
                    import base64
                    b64 = po.split(",", 1)[1] if po.startswith("data:") else po
                    data = to_webp(base64.b64decode(b64), width)
                except Exception:
                    data = None
            if data is None and r["asset_type"] == "video":
                srcs = ([r["poster_url"]] if (r["poster_url"] and "://" in r["poster_url"]) else []) \
                       + poster_candidates(r["full_res_url"])
            elif data is None:
                srcs = [r["full_res_url"]]
            else:
                srcs = []
            for src in srcs:
                try:
                    d = thumb_via_resizer(src, width)
                    if d and d[:4] == b'RIFF':
                        data = d
                        if not r["poster_url"]:
                            r["poster_url"] = src
                        break
                except Exception:
                    continue
            if not data and r["asset_type"] == "video":
                data = thumb_via_ffmpeg(r["full_res_url"], width)
            if data and len(data) > 200:
                with open(fp, "wb") as f:
                    f.write(data)
                with lock:
                    stat["ok"] += 1; stat["bytes"] += len(data)
                    built[r["thumb_path"]] = r["full_res_url"]
            else:
                with lock:
                    stat["fail"] += 1
                r["thumb_path"] = ""
            time.sleep(0.05)

    ts = [threading.Thread(target=worker, daemon=True) for _ in range(threads)]
    for t in ts:
        t.start()
    while any(t.is_alive() for t in ts):
        time.sleep(5)
        with lock:
            done = stat["ok"] + stat["skip"] + stat["fail"]
            print(f"  {done}/{len(work)} ok={stat['ok']} skip={stat['skip']} "
                  f"fail={stat['fail']} {stat['bytes']/1048576:.0f}MB", flush=True)
    for t in ts:
        t.join()
    json.dump(built, open(ipath, "w"))
    return stat

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--max-extra", type=int, default=6)
    ap.add_argument("--outdir", default="assets")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--estimate", action="store_true")
    a = ap.parse_args()
    ds = json.load(open("dataset.json"))
    rows = build_rows(ds, a.max_extra)
    print(f"records={len(ds)} assets={len(rows)}")
    if a.estimate:
        import random
        random.seed(0)
        s = random.sample(rows, min(25, len(rows)))
        st = run(s, a.outdir, a.width)
        n = st["ok"] + st["skip"]
        if n:
            avg = st["bytes"] / n
            print(f"avg thumb {avg/1024:.1f} KB -> projected {(avg*len(rows))/1048576:.0f} MB "
                  f"for {len(rows)} assets at w={a.width}")
        sys.exit(0)
    st = run(rows, a.outdir, a.width, limit=a.limit)
    os.makedirs(a.outdir, exist_ok=True)
    for r in rows:
        if r.get("thumb_path") and not os.path.exists(os.path.join(a.outdir, r["thumb_path"])):
            r["thumb_path"] = ""
    with open(os.path.join(a.outdir, "manifest.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), quoting=csv.QUOTE_ALL)
        w.writeheader()
        w.writerows(rows)
    json.dump(rows, open(os.path.join(a.outdir, "manifest.json"), "w"), ensure_ascii=False)

    # merge asset facts back into the dataset so the CSV/XLSX/PDF carry them
    by_rec = {}
    for r in rows:
        by_rec.setdefault(r["record_id"], []).append(r)
    for rec in ds:
        rid = record_id(rec)
        got = [x for x in by_rec.get(rid, [])
               if x.get("thumb_path") and os.path.exists(os.path.join(a.outdir, x["thumb_path"]))]
        rec["asset_count"] = len(got)
        rec["thumb_path"] = got[0]["thumb_path"] if got else None
        if got and not rec.get("asset_type"):
            rec["asset_type"] = got[0]["asset_type"]
        if got and not rec.get("poster_url"):
            rec["poster_url"] = got[0].get("poster_url") or None
    json.dump(ds, open("dataset.json", "w"), ensure_ascii=False, indent=1)
    withthumb = len([r for r in ds if r.get("thumb_path")])
    print(f"DONE {st}")
    print(f"dataset updated: {withthumb}/{len(ds)} records have a thumbnail "
          f"({100*withthumb/len(ds):.1f}%)")
