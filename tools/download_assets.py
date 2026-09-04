#!/usr/bin/env python3
"""Download the full-resolution Higgsfield assets referenced by assets/manifest.csv.

The repository ships 512px WebP thumbnails so the gallery and PDF are browsable
offline. The originals (images up to ~5 MB, videos ~8 MB) are not committed --
run this to pull them locally.

    python3 download_assets.py                     # everything (~8 GB)
    python3 download_assets.py --images-only       # skip video
    python3 download_assets.py --tool "Viral Preset"
    python3 download_assets.py --model "Kling 3.0" --out ./originals
    python3 download_assets.py --limit 5           # smoke test

Resumable: files already present with a matching byte count are skipped.
"""
import os, csv, sys, time, argparse, threading, queue
import urllib.request, urllib.error
from urllib.parse import urlparse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

def head_size(url, timeout=30):
    try:
        rq = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
        with urllib.request.urlopen(rq, timeout=timeout) as r:
            return int(r.headers.get("Content-Length") or 0)
    except Exception:
        return 0

def download(url, path, timeout=300):
    rq = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(rq, timeout=timeout) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    return os.path.getsize(path)

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default=os.path.join(os.path.dirname(__file__) or ".",
                                                       "..", "assets", "manifest.csv"))
    ap.add_argument("--out", default="originals")
    ap.add_argument("--images-only", action="store_true")
    ap.add_argument("--videos-only", action="store_true")
    ap.add_argument("--tool", help="substring match on tool_type")
    ap.add_argument("--model", help="substring match on model_or_effect")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()

    if not os.path.exists(a.manifest):
        sys.exit(f"manifest not found: {a.manifest}")
    rows = [r for r in csv.DictReader(open(a.manifest, encoding="utf-8-sig"))
            if r.get("full_res_url")]
    if a.images_only:
        rows = [r for r in rows if r["asset_type"] == "image"]
    if a.videos_only:
        rows = [r for r in rows if r["asset_type"] == "video"]
    if a.tool:
        rows = [r for r in rows if a.tool.lower() in (r.get("tool_type") or "").lower()]
    if a.model:
        rows = [r for r in rows if a.model.lower() in (r.get("model_or_effect") or "").lower()]
    seen, uniq = set(), []
    for r in rows:
        if r["full_res_url"] not in seen:
            seen.add(r["full_res_url"]); uniq.append(r)
    if a.limit:
        uniq = uniq[:a.limit]
    os.makedirs(a.out, exist_ok=True)
    print(f"{len(uniq)} assets -> {a.out}/")

    q = queue.Queue()
    for r in uniq:
        q.put(r)
    stat = {"ok": 0, "skip": 0, "fail": 0, "bytes": 0}
    lock = threading.Lock()

    def worker():
        while True:
            try:
                r = q.get_nowait()
            except queue.Empty:
                return
            url = r["full_res_url"]
            name = f"{r['record_id']}__{r['asset_index']}_" + os.path.basename(urlparse(url).path)
            path = os.path.join(a.out, name)
            try:
                if os.path.exists(path):
                    want = head_size(url)
                    if want and os.path.getsize(path) == want:
                        with lock:
                            stat["skip"] += 1
                        continue
                n = download(url, path)
                with lock:
                    stat["ok"] += 1; stat["bytes"] += n
            except Exception as e:
                with lock:
                    stat["fail"] += 1
                print(f"  FAIL {url[:80]} {type(e).__name__}", file=sys.stderr)
            time.sleep(0.1)

    ts = [threading.Thread(target=worker, daemon=True) for _ in range(a.threads)]
    for t in ts:
        t.start()
    while any(t.is_alive() for t in ts):
        time.sleep(5)
        with lock:
            d = stat["ok"] + stat["skip"] + stat["fail"]
            print(f"  {d}/{len(uniq)} ok={stat['ok']} skip={stat['skip']} "
                  f"fail={stat['fail']} {stat['bytes']/1048576:.0f}MB", flush=True)
    for t in ts:
        t.join()
    print(f"DONE ok={stat['ok']} skipped={stat['skip']} failed={stat['fail']} "
          f"({stat['bytes']/1048576:.0f} MB)")

if __name__ == "__main__":
    main()
