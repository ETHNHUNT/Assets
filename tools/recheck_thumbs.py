"""Re-probe the assets that carry no thumbnail, and report whether they are recoverable.

`assets.py` leaves `thumb_path` empty when every route to a picture failed: the
Higgsfield resizer, each poster candidate, and — for a video — pulling frame 1 with
ffmpeg. That could mean a transient fetch failure at build time, or an asset the CDN
no longer serves. Only a re-probe tells them apart, so run this before concluding that
a rebuild would fill the gaps.

    python3 tools/recheck_thumbs.py            # probe every un-thumbed asset
    python3 tools/recheck_thumbs.py --posters  # also probe each poster candidate

Note on method: this CDN answers HEAD and Range requests with 403 even for assets it
serves happily over a plain GET, and it 403s the browser User-Agent that assets.py
sends. So a probe has to be a plain GET under curl's own UA, and the response is read
only far enough to settle the status. Exit status is 0 whatever it finds — a withdrawn
asset is a fact to report, not a build failure.
"""
import argparse, json, os, subprocess, sys
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def probe(url, timeout=30):
    """HTTP status for a plain GET, or 0 if the request never completed."""
    r = subprocess.run(
        ["curl", "-sS", "--max-time", str(timeout), "-o", os.devnull,
         "-w", "%{http_code}", url],
        capture_output=True, text=True)
    return int(r.stdout.strip() or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="assets/manifest.json")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--posters", action="store_true",
                    help="also probe each poster candidate, not just the asset itself")
    a = ap.parse_args()

    man = json.load(open(a.manifest))
    todo = [m for m in man if not m.get("thumb_path")]
    print(f"{len(todo)} of {len(man)} assets have no thumbnail\n")
    if not todo:
        return

    with cf.ThreadPoolExecutor(a.threads) as ex:
        codes = list(ex.map(lambda m: probe(m["full_res_url"]), todo))

    live = []
    for m, code in zip(todo, codes):
        print(f"  {code}  {m['role']:8s} {m['record_id']}  {m['full_res_url'].split('/')[-1]}")
        if code == 200:
            live.append(m)

    if a.posters:
        from assets import poster_candidates
        print("\nposter candidates for the un-thumbed videos:")
        for m in todo:
            cands = poster_candidates(m["full_res_url"])
            if not cands:
                continue
            print(f"  {m['record_id']}")
            with cf.ThreadPoolExecutor(a.threads) as ex:
                for c, code in zip(cands, ex.map(probe, cands)):
                    print(f"      {code}  {c}")

    print(f"\n{len(live)} of {len(todo)} un-thumbed assets are still served.")
    if live:
        print("Re-run `python3 tools/assets.py --width 512 --max-extra 4` to thumb them.")
    else:
        print("Every one is withdrawn at the origin — no rebuild can recover these.")


if __name__ == "__main__":
    main()
