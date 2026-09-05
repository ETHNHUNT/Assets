"""Harvest the prompts that server-rendered HTML does not carry.

Two gaps in the SSR crawl, both closed here:

* **Community feeds ship one page.** A landing like `/soul-community` renders its
  first 80 publications and leaves the rest to an infinite scroll. The scroll calls
  a public JSON gateway — `fnf-api-gw.higgsfield.ai/fnf` — which needs no
  authentication and pages by cursor, so the whole feed is reachable.
* **Seedance 2.5 renders no prompt text at all.** Its cards carry a job id and media
  only. The same gateway returns `params.prompt` for those ids.

The gateway host and path come from the site's own client bundle
(`https://assets.higgsfield.ai/tanstack/assets/*.js`); the base is built there as
`https://fnf-api-gw.higgsfield.ai/fnf` and the feed reader calls
`publications/community/approved` with `{filter, model, approved, size, cursor}`.

    python3 tools/api_feeds.py                     # every known feed -> api_feeds.json
    python3 tools/api_feeds.py --feed soul-community
    python3 tools/api_feeds.py --out somewhere.json

The model filter for a feed is not hard-coded: each landing page is fetched and the
`jobSetType` its own cards declare is used, so a renamed model does not silently
yield an empty harvest.
"""
import argparse, json, re, subprocess, sys, time, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
GATEWAY = "https://fnf-api-gw.higgsfield.ai/fnf"
FEED = GATEWAY + "/publications/community/approved"
SITE = "https://higgsfield.ai"

# The public community landings, as they appear in the sitemap.
FEEDS = ["soul-community", "soul-cinema-community", "seedance-2-5-community",
         "seedance-4k-community", "kling-30-community", "mixed-media-community",
         "gpt-image-2-community", "marketing-studio-community"]

PROMPT_BANK = "/academy/apps/prompt-bank"


def curl(url, headers=(), timeout=60, retries=3):
    args = ["curl", "-sS", "--max-time", str(timeout), "--compressed",
            "-H", f"User-Agent: {UA}"]
    for h in headers:
        args += ["-H", h]
    for attempt in range(retries):
        r = subprocess.run(args + [url], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout:
            return r.stdout
        time.sleep(1.5 * (attempt + 1))
    return ""


def api(path_and_query):
    """GET the JSON gateway. Returns None when the response is not JSON.

    The gateway answers 500 to page sizes it cannot assemble — the threshold varies by
    model, and for some it is below 50 — so callers step the size down rather than
    treating one 500 as an empty feed.
    """
    body = curl(f"{GATEWAY}/{path_and_query}",
                ["accept: application/json", f"Origin: {SITE}", f"Referer: {SITE}/"])
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


PAGE_SIZES = (100, 50, 25, 10)


def feed_page(model, cursor, size):
    """One page of a feed, stepping the page size down past the gateway's 500s.

    Returns (data, size_that_worked) so the caller can stay at the working size.
    """
    for s in [z for z in PAGE_SIZES if z <= size]:
        q = {"model": model, "approved": "true", "size": s}
        if cursor:
            q["cursor"] = cursor
        d = api("publications/community/approved?" + urllib.parse.urlencode(q))
        if d and "items" in d:
            return d, s
    return None, size


def feed_model(slug):
    """The job type a landing's own cards declare, or None if the page renders none."""
    types = re.findall(r'jobSetType:"([a-z0-9_]+)"', curl(f"{SITE}/{slug}"))
    return max(set(types), key=types.count) if types else None


def harvest_feed(slug, page_size=100, max_pages=40, max_items=2000):
    model = feed_model(slug)
    if not model:
        return {"feed": slug, "model": None, "items": [], "stopped": "no jobSetType in SSR"}
    seen, cursor, pages, declared, size = {}, None, 0, None, page_size
    stopped, more = "exhausted", False
    while True:
        if pages >= max_pages:
            stopped = f"max_pages ({max_pages})"
            break
        if len(seen) >= max_items:
            stopped = f"max_items ({max_items})"
            break
        d, size = feed_page(model, cursor, size)
        pages += 1
        if not d:
            # A 500 at every page size. Say so rather than reporting a short feed as
            # complete: the difference matters when reading the counts back.
            stopped = "gateway error"
            break
        declared = d.get("total", declared)
        for it in d["items"]:
            seen[it["id"]] = it
        cursor = d.get("cursor")
        more = bool(d.get("has_more"))
        if not more or not cursor:
            break
    return {"feed": slug, "model": model, "declared_total": declared,
            "pages_fetched": pages, "page_size": size, "stopped": stopped,
            "has_more_at_stop": more,
            "items": [normalise(i, slug) for i in seen.values()]}


# `results` is an object keyed by rendition — {"raw": {...}, "min": {...}, "hls": null,
# "h264": null} — not a list. `raw` is the full-resolution original; the others are
# transcodes of the same generation, so only the first non-null one is the asset.
RENDITIONS = ("raw", "min", "h264", "hls")


def media_of(it):
    """(url, poster_url, kind) for a publication's asset, or (None, None, None)."""
    res = it.get("results") or it.get("result") or {}
    if isinstance(res, list):                     # older shape, kept for safety
        res = {"raw": res[0]} if res else {}
    if not isinstance(res, dict):
        return None, None, None
    for key in RENDITIONS:
        r = res.get(key)
        if isinstance(r, dict) and r.get("url"):
            return r["url"], r.get("thumbnail_url"), r.get("type")
    return None, None, None


def normalise(it, slug):
    params = it.get("params") or {}
    url, poster, kind = media_of(it)
    return {
        "id": it.get("id"),
        "job_set_id": it.get("job_set_id"),
        "job_set_type": it.get("job_set_type"),
        "prompt": params.get("prompt"),
        "width": params.get("width"),
        "height": params.get("height"),
        "quality": params.get("quality"),
        "style": (params.get("style") or {}).get("name") if isinstance(params.get("style"), dict) else params.get("style"),
        "media_url": url,
        "poster_url": poster,
        "asset_type": kind,
        "published_at": it.get("published_at"),
        "source_url": f"{SITE}/{slug}",
    }


def harvest_prompt_bank(max_pages=12):
    """The bank renders one page of each category; ?page=N returns the rest.

    `?category=` and `?section=` do not move the slice, which is what made this look
    unreachable — but the loader reads `page`, and the pages are plain SSR HTML, so
    the existing extractor handles them unchanged.
    """
    sys.path.insert(0, "tools")
    sys.path.insert(0, ".")
    from pbank import extract_prompt_bank
    out, page = {}, 1
    while page <= max_pages:
        url = f"{SITE}{PROMPT_BANK}" + (f"?page={page}" if page > 1 else "")
        rows = extract_prompt_bank(curl(url), url)
        new = [r for r in rows if r["prompt"] not in out]
        for r in rows:
            out.setdefault(r["prompt"], r)
        print(f"  prompt-bank page {page}: {len(rows)} rows, {len(new)} new", flush=True)
        if not rows or not new:
            break
        page += 1
    return list(out.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--feed", action="append", help="limit to these feed slugs")
    ap.add_argument("--out", default="api_feeds.json")
    ap.add_argument("--skip-prompt-bank", action="store_true")
    ap.add_argument("--max-items", type=int, default=2000,
                    help="per-feed cap; some models expose a backlog far larger than "
                         "the landing page's own feed")
    a = ap.parse_args()

    result = {"gateway": GATEWAY, "feeds": [], "prompt_bank": []}
    for slug in (a.feed or FEEDS):
        print(f"{slug} ...", flush=True)
        f = harvest_feed(slug, max_items=a.max_items)
        withp = sum(1 for i in f["items"] if i["prompt"])
        print(f"  model={f['model']} items={len(f['items'])} with_prompt={withp} "
              f"declared={f.get('declared_total')} stopped={f['stopped']}"
              f"{' (more remain)' if f.get('has_more_at_stop') else ''}", flush=True)
        result["feeds"].append(f)

    if not a.skip_prompt_bank:
        print("academy prompt bank ...", flush=True)
        result["prompt_bank"] = harvest_prompt_bank()

    items = sum(len(f["items"]) for f in result["feeds"])
    prompts = sum(1 for f in result["feeds"] for i in f["items"] if i["prompt"])
    json.dump(result, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n{items} feed items ({prompts} with prompt text) + "
          f"{len(result['prompt_bank'])} prompt-bank entries -> {a.out}")


if __name__ == "__main__":
    main()
