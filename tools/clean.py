import json, re, sys, collections, unicodedata
sys.path.insert(0, '.')
from prose import looks_like_prompt, classify

def _iter_rows():
    with open("raw_rows.jsonl", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)

rows = list(_iter_rows())

# Model / tool-type / style / subject classification lives in classify.py so that
# merge_api_feeds.py can label new records exactly as the crawl pipeline does.
from classify import (MODEL_MAP, norm_model, URL_MODEL, model_from_url, tool_type,
                      STYLES, styles_of, SUBJECTS, subjects_of)

# ---------- normalise / dedupe ----------
def norm_key(t):
    t = unicodedata.normalize("NFKC", t or "")
    t = re.sub(r'\s+', ' ', t).strip().lower()
    t = re.sub(r'[^a-z0-9 ]+', '', t)
    return t[:400]

JUNK = re.compile(r'^(sample by id of|interface with options|screenshot|a screenshot|ui screenshot|'
                  r'the image shows where)', re.I)
UIISH = re.compile(r'(interface|toggle|dropdown|sidebar|click here|navigation bar)', re.I)

# page-frequency for boilerplate detection (figure captions)
pagecount = collections.defaultdict(set)
for r in rows:
    if r.get("prompt"):
        pagecount[norm_key(r["prompt"])].add(r.get("source_url"))

clean = []
for r in rows:
    if r["record_type"] == "preset_effect":
        clean.append(r); continue
    t = (r.get("prompt") or "").strip()
    if not t:
        continue
    k = norm_key(t)
    w = len(t.split())
    src = r["extraction_source"]
    if JUNK.search(t):
        continue
    if src == "figure_caption":
        if len(pagecount[k]) > 3 or w < 8:
            continue
        if (' — ' in t and w < 25) or (' - ' in t and w < 18):
            continue
        if UIISH.search(t) and w < 30:
            continue
    # structured sources label the field as a prompt, so trust short ones;
    # inferred sources still need enough text to be worth keeping
    if w < (4 if src in ("job_payload", "flat_payload", "prompt_bank", "recreate_link") else 6):
        continue
    # confidence
    if src in ("job_payload", "flat_payload", "recreate_link", "prompt_bank"):
        conf = "High"
    elif looks_like_prompt(t) and classify(t) == "prompt":
        conf = "High"
    elif w >= 20:
        conf = "Medium"
    else:
        conf = "Low"
    r["_conf"] = conf
    clean.append(r)

# dedupe: keep richest record per normalised prompt
best = {}
order = {"job_payload": 0, "flat_payload": 0, "prompt_bank": 1, "recreate_link": 2,
         "figure_caption": 3, "article_body": 4, "catalog_page": 5}
for r in clean:
    if r["record_type"] == "preset_effect":
        key = ("preset", (r.get("name") or "").lower(), r.get("model_or_effect"))
    else:
        key = ("prompt", norm_key(r["prompt"]))
    cur = best.get(key)
    if cur is None:
        best[key] = r; continue
    def score(x):
        return (-order.get(x["extraction_source"], 9),
                len([v for v in x.values() if v]),
                len(x.get("prompt") or ""))
    if score(r) > score(cur):
        # merge non-empty fields from cur
        for kk, vv in cur.items():
            if vv and not r.get(kk):
                r[kk] = vv
        best[key] = r
    else:
        for kk, vv in r.items():
            if vv and not cur.get(kk):
                cur[kk] = vv

final = []
for r in best.values():
    text = r.get("prompt") or ""
    model_raw = r.get("model_or_effect")
    model, kind = norm_model(model_raw)
    if not model:
        model = model_from_url(r.get("source_url"))
    basis = text if text else ((r.get("name") or "") + " " + (r.get("description") or ""))
    rec = {
        "record_type": "Prompt" if r["record_type"] == "prompt" else "Preset / Effect",
        "name": r.get("name"),
        "prompt_text": text or None,
        "description": r.get("description"),
        "model_or_effect": model,
        "tool_type": tool_type(r),
        "generation_style": "; ".join(styles_of(basis)) or None,
        "visual_subject": "; ".join(subjects_of(basis)) or None,
        "category": r.get("category"),
        "preset_name": r.get("preset_name"),
        "aspect_ratio": r.get("aspect_ratio"),
        "duration_sec": r.get("duration"),
        "quality": r.get("quality"),
        "badges": r.get("badges"),
        "media_url": r.get("media_url"),
        "full_res_url": (r.get("full_res_url") or r.get("media_url")
                          or r.get("poster_url")),
        "poster_url": r.get("poster_url"),
        "asset_type": r.get("asset_type"),
        "media_pairing": (r.get("media_pairing")
                          if (r.get("full_res_url") or r.get("media_url") or r.get("poster_url"))
                          else None),
        "extra_assets": r.get("extra_assets") or [],
        "width": r.get("width"),
        "height": r.get("height"),
        "recreate_model": r.get("recreate_model"),
        "lesson_title": r.get("lesson_title"),
        "timestamp_in_lesson": r.get("start_seconds"),
        "source_url": r.get("source_url"),
        "site_section": r.get("site_section"),
        "extraction_source": r.get("extraction_source"),
        "confidence": r.get("_conf") or "High",
        "word_count": len(text.split()) if text else None,
        "char_count": len(text) if text else None,
    }
    final.append(rec)

MARKETING = re.compile(
    r'(higgsfield\s+(blender|plugin|academy|supercomputer)|^learn how to|in action\.?\s*example|'
    r'lock your style once|^bring \w+, |^make videos for|subscribers and millions|'
    r'^explore |^discover |^turn your |^generate any |^create your |^predict how)', re.I)
final = [r for r in final
         if not (r["confidence"] == "Low" and r["prompt_text"]
                 and MARKETING.search(r["prompt_text"]))]

final.sort(key=lambda x: (x["record_type"], x["tool_type"], -(x["char_count"] or 0)))
json.dump(final, open("dataset.json", "w"), ensure_ascii=False, indent=1)
print("FINAL RECORDS:", len(final))
print("by record_type:", dict(collections.Counter(r["record_type"] for r in final)))
print("by tool_type:", dict(collections.Counter(r["tool_type"] for r in final)))
print("by confidence:", dict(collections.Counter(r["confidence"] for r in final)))
print("by model:", collections.Counter(r["model_or_effect"] for r in final).most_common(12))
