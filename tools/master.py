import sys, os, re, glob, json, html
sys.path.insert(0, '.')
from jobs import extract_jobs
from figures import extract_figures
from prose import extract_prose
from recreate import extract_recreate, srcurl
from pbank import extract_prompt_bank
from flat_prompts import extract_flat
from proximity import build_index, nearest, find_text_pos
from catalog import extract_catalog, meta, title, clean_title

GENERIC_DESC = [
    "generate unique ai videos and images with creative presets built for creators on higgsfield",
    "preview ai motion presets and explore dynamic animations to bring your video projects to life",
    "explore ai video presets",
]

def is_generic(d):
    if not d: return True
    dl = d.lower()
    return any(g in dl for g in GENERIC_DESC)

def section_of(url):
    p = url.replace("https://higgsfield.ai", "").strip("/")
    if not p: return "home"
    seg = p.split("/")[0].split("?")[0]
    if seg.startswith("@"): return "creator-profile"
    return seg

import collections as _cc
JUNK_CAP = re.compile(r'^(sample by id of|interface with options|screenshot|a screenshot|'
                      r'ui screenshot|the image shows where)', re.I)
OUT = open("raw_rows.jsonl", "w", encoding="utf-8")
_stats = _cc.Counter()
_seen_cap = set()

class _Rows:
    def append(self, r):
        src = r.get("extraction_source")
        if src == "figure_caption":
            t = (r.get("prompt") or "").strip()
            if JUNK_CAP.match(t) or len(t.split()) < 8:
                return
            k = re.sub(r'\W+', '', t.lower())[:160]
            if k in _seen_cap:      # same caption already captured elsewhere
                return
            _seen_cap.add(k)
        if src == "catalog_page":
            r["extra_assets"] = (r.get("extra_assets") or [])[:8]
        OUT.write(json.dumps(r, ensure_ascii=False) + "\n")
        _stats[src] += 1
        _stats["_" + r.get("record_type", "?")] += 1

rows = _Rows()
files = sorted(glob.glob("pages/*.html")) + sorted(glob.glob("probe/*.html"))
seen_files = set()
for f in files:
    h = open(f, encoding="utf-8", errors="replace").read()
    url = srcurl(h)
    if not url:
        continue
    if url in seen_files:
        continue
    seen_files.add(url)
    sec = section_of(url)
    midx = build_index(h)

    for j in extract_jobs(h, url):
        rows.append({**j, "record_type": "prompt", "extraction_source": "job_payload",
                     "model_or_effect": j.get("job_set_type"), "site_section": sec})
    for fl in extract_flat(h, url):
        rows.append({**fl, "record_type": "prompt", "extraction_source": "flat_payload",
                     "model_or_effect": fl.get("recreate_model"), "site_section": sec})
    for r in extract_recreate(h, url):
        pos = find_text_pos(h, r["prompt"])
        near = nearest(midx, pos) if pos >= 0 else None
        rows.append({"prompt": r["prompt"], "source_url": url, "record_type": "prompt",
                     "extraction_source": "recreate_link", "model_or_effect": r.get("model"),
                     "preset_name": r.get("preset"), "target_path": r.get("target_path"),
                     "site_section": sec, "media_url": near, "full_res_url": near,
                     "media_pairing": "proximity" if near else None})
    for fg in extract_figures(h, url):
        rows.append({"prompt": fg["prompt"], "source_url": url, "record_type": "prompt",
                     "extraction_source": "figure_caption", "media_url": fg.get("media_url"), "full_res_url": fg.get("media_url"),
                     "media_pairing": "figure",
                     "badges": fg.get("badges"), "site_section": sec})
    for pb in extract_prompt_bank(h, url):
        rows.append({"prompt": pb["prompt"], "source_url": url, "record_type": "prompt",
                     "extraction_source": "prompt_bank", "name": pb.get("name"),
                     "model_or_effect": pb.get("name"), "category": pb.get("category"),
                     "section": pb.get("section"), "media_url": pb.get("media_url"),
                     "site_section": sec})
    for pr in extract_prose(h, url):
        if pr["kind"] != "prompt":
            continue
        pos = find_text_pos(h, pr["prompt"])
        near = nearest(midx, pos) if pos >= 0 else None
        rows.append({"prompt": pr["prompt"], "source_url": url, "record_type": "prompt",
                     "extraction_source": "article_body", "site_section": sec,
                     "media_url": near, "full_res_url": near,
                     "media_pairing": "proximity" if near else None})

    if sec in ("motion", "viral-presets", "mixed-media-presets"):
        c = extract_catalog(h, url)
        if c.get("name"):
            rows.append({"name": c["name"], "prompt": None,
                         "description": None if is_generic(c.get("description")) else c.get("description"),
                         "model_or_effect": c.get("model"), "source_url": url,
                         "record_type": "preset_effect", "extraction_source": "catalog_page",
                         "site_section": sec,
                         "full_res_url": c.get("full_res_url"), "poster_url": c.get("poster_url"),
                         "asset_type": c.get("asset_type"), "extra_assets": c.get("extra_assets"),
                         "media_pairing": "preset-preview" if c.get("full_res_url") else None,
                         "media_url": c.get("full_res_url")})

OUT.close()
total = sum(v for k, v in _stats.items() if not k.startswith("_"))
print("raw rows:", total, flush=True)
print("by source:", {k: v for k, v in _stats.items() if not k.startswith("_")}, flush=True)
print("by type:", {k[1:]: v for k, v in _stats.items() if k.startswith("_")}, flush=True)
