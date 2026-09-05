"""Fold an api_feeds.py harvest into the dataset.

The harvest holds prompts the SSR crawl could not see: the tails of the community
feeds, Seedance 2.5's prompt text, and the pages of the Academy prompt bank past the
first. This merges them in as ordinary records — same schema, same classifiers
(`classify.py`, which the crawl pipeline uses), same `record_id` derivation — so
everything downstream (`assets.py`, the `build_*` scripts, `verify.py`) treats them
like any other record.

    python3 tools/api_feeds.py --out api_feeds.json
    python3 tools/merge_api_feeds.py --harvest api_feeds.json --out dataset.json

A prompt already in the dataset is skipped, matched on the same normalised text the
crawl pipeline dedupes with, so re-running is safe and the SSR slice each feed already
contributed is not duplicated.
"""
import argparse, json, math, os, re, sys, unicodedata

sys.path.insert(0, "tools")
sys.path.insert(0, ".")
from classify import norm_model, styles_of, subjects_of, tool_type as classify_tool_type


def norm_key(t):
    """The dedupe key clean.py uses, so a match here means a match there."""
    t = unicodedata.normalize("NFKC", t or "")
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return re.sub(r'[^a-z0-9 ]+', '', t)[:400]


def aspect(w, h):
    """`16:9` for a size that reduces to a clean ratio; nothing for anything else.

    Derived, not guessed — but only where the reduction is a ratio a human would
    recognise, so an odd size stays empty rather than reading as `853:480`.
    """
    if not w or not h:
        return None
    g = math.gcd(int(w), int(h))
    a, b = int(w) // g, int(h) // g
    return f"{a}:{b}" if max(a, b) <= 32 else None


def section_of(url):
    p = (url or "").replace("https://higgsfield.ai", "").strip("/")
    return p.split("/")[0].split("?")[0] if p else "home"


def feed_record(it):
    prompt = (it.get("prompt") or "").strip()
    model, kind = norm_model(it.get("job_set_type"))
    url = it.get("media_url")
    src = it.get("source_url")
    rec = {
        "record_type": "Prompt",
        "name": None,
        "prompt_text": prompt,
        "description": None,
        "model_or_effect": model,
        "generation_style": "; ".join(styles_of(prompt)) or None,
        "visual_subject": "; ".join(subjects_of(prompt)) or None,
        "category": None,
        "preset_name": None,
        "aspect_ratio": aspect(it.get("width"), it.get("height")),
        "duration_sec": None,
        "quality": it.get("quality"),
        "badges": None,
        "word_count": len(prompt.split()) if prompt else None,
        "char_count": len(prompt) if prompt else None,
        "asset_count": 1 if url else 0,
        "asset_type": it.get("asset_type"),
        "thumb_path": None,
        "full_res_url": url,
        "poster_url": it.get("poster_url"),
        # Empty: the asset came from the record's own payload, with no inference.
        "media_pairing": "",
        "recreate_model": None,
        "lesson_title": None,
        "timestamp_in_lesson": None,
        "confidence": "High",
        "site_section": section_of(src),
        "extraction_source": "api_feed",
        "media_url": url,
        "source_url": src,
        "extra_assets": [],
        "width": it.get("width"),
        "height": it.get("height"),
    }
    rec["tool_type"] = classify_tool_type({**rec, "asset_layer": kind})
    return rec


def bank_record(it):
    prompt = (it.get("prompt") or "").strip()
    # The bank's own page, not the ?page=N variant it was read from: the query is
    # paging, not identity, and record_id is built from the source URL.
    src = re.sub(r'\?.*$', '', it.get("source_url") or "")
    url = it.get("media_url")
    rec = {
        "record_type": "Prompt",
        "name": it.get("name"),
        "prompt_text": prompt,
        "description": None,
        "model_or_effect": None,
        "generation_style": "; ".join(styles_of(prompt)) or None,
        "visual_subject": "; ".join(subjects_of(prompt)) or None,
        "category": it.get("category"),
        "preset_name": None,
        "aspect_ratio": None,
        "duration_sec": None,
        "quality": None,
        "badges": None,
        "word_count": len(prompt.split()) if prompt else None,
        "char_count": len(prompt) if prompt else None,
        "asset_count": 1 if url else 0,
        "asset_type": "video" if (url or "").lower().endswith((".mp4", ".webm", ".mov")) else "image" if url else None,
        "thumb_path": None,
        "full_res_url": url,
        "poster_url": None,
        "media_pairing": "",
        "recreate_model": None,
        "lesson_title": None,
        "timestamp_in_lesson": None,
        "confidence": "High",
        "site_section": section_of(src),
        "extraction_source": "prompt_bank",
        "media_url": url,
        "source_url": src,
        "extra_assets": [],
        "width": None,
        "height": None,
    }
    rec["tool_type"] = classify_tool_type(rec)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--harvest", default="api_feeds.json")
    ap.add_argument("--dataset", default=None,
                    help="default: dataset.json if present, else the committed copy")
    ap.add_argument("--out", default="dataset.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    ds_path = a.dataset or ("dataset.json" if os.path.exists("dataset.json")
                            else "data/higgsfield_prompt_dataset.json")
    ds = json.load(open(ds_path))
    harvest = json.load(open(a.harvest))
    seen = {norm_key(r["prompt_text"]) for r in ds if r.get("prompt_text")}

    added, skipped = [], 0
    for f in harvest.get("feeds", []):
        for it in f["items"]:
            if not (it.get("prompt") or "").strip():
                continue
            k = norm_key(it["prompt"])
            if k in seen:
                skipped += 1
                continue
            seen.add(k)
            added.append(feed_record(it))
    bank = 0
    for it in harvest.get("prompt_bank", []):
        k = norm_key(it.get("prompt"))
        if not k or k in seen:
            skipped += 1
            continue
        seen.add(k)
        added.append(bank_record(it))
        bank += 1

    print(f"dataset:  {ds_path} ({len(ds)} records)")
    print(f"harvest:  {a.harvest}")
    print(f"added:    {len(added)} ({len(added) - bank} feed, {bank} prompt bank)")
    print(f"skipped:  {skipped} already present")
    import collections
    for k, v in collections.Counter(r["tool_type"] for r in added).most_common():
        print(f"    {v:4d}  {k}")
    print(f"    {sum(1 for r in added if r['full_res_url']):4d}  carry an asset")

    if a.dry_run:
        return
    json.dump(ds + added, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"\n{len(ds) + len(added)} records -> {a.out}")


if __name__ == "__main__":
    main()
