import json, csv, collections, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assets import record_id

def stamp(r):
    """Attach the join key, idempotently — dataset.json may already carry one."""
    r = {k: v for k, v in r.items() if k != "record_id"}
    return {"record_id": record_id(r), **r}

d = json.load(open("dataset.json"))
OUT = "deliverables"
os.makedirs(OUT, exist_ok=True)

# The join key is the same SHA-1 used to name the thumbnails, so record_id joins
# these files to assets/manifest.csv and to assets/thumbs/<record_id>__<n>.webp.
d = [stamp(r) for r in d]

COLS = [
    ("record_id", "Record ID"), ("record_type", "Record Type"), ("name", "Name"),
    ("prompt_text", "Prompt Text"), ("description", "Description"), ("model_or_effect", "Model / Motion Effect"),
    ("tool_type", "Tool Type"), ("generation_style", "Generation Style"),
    ("visual_subject", "Visual Subject"), ("category", "Category"),
    ("preset_name", "Preset"), ("aspect_ratio", "Aspect Ratio"),
    ("duration_sec", "Duration (s)"), ("quality", "Quality"), ("badges", "Badges"),
    ("word_count", "Word Count"), ("char_count", "Char Count"),
    ("asset_count", "Asset Count"), ("asset_type", "Asset Type"),
    ("thumb_path", "Thumbnail (repo path)"), ("full_res_url", "Full-Res Asset URL"),
    ("poster_url", "Poster URL"), ("media_pairing", "Asset Pairing"),
    ("recreate_model", "Recreate Model"), ("lesson_title", "Lesson"),
    ("timestamp_in_lesson", "Lesson Timestamp (s)"),
    ("confidence", "Confidence"), ("site_section", "Site Section"),
    ("extraction_source", "Extraction Source"), ("media_url", "Sample Media URL"),
    ("source_url", "Source Page URL"),
]

def w(path, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        wr = csv.writer(f, quoting=csv.QUOTE_ALL)
        wr.writerow([h for _, h in COLS])
        for r in rows:
            wr.writerow([("" if r.get(k) is None else str(r.get(k))) for k, _ in COLS])

w(f"{OUT}/higgsfield_prompts_full.csv", d)
w(f"{OUT}/higgsfield_prompts_only.csv", [r for r in d if r["record_type"] == "Prompt"])
w(f"{OUT}/higgsfield_presets_effects.csv", [r for r in d if r["record_type"] == "Preset / Effect"])

# summary sheets
def counts(key, split=False):
    c = collections.Counter()
    for r in d:
        v = r.get(key)
        if not v: c["(unspecified)"] += 1; continue
        if split:
            for p in str(v).split("; "): c[p] += 1
        else:
            c[str(v)] += 1
    return c.most_common()

with open(f"{OUT}/higgsfield_summary.csv", "w", newline="", encoding="utf-8-sig") as f:
    wr = csv.writer(f, quoting=csv.QUOTE_ALL)
    for title, key, sp in [("BY TOOL TYPE", "tool_type", False),
                           ("BY MODEL / MOTION EFFECT", "model_or_effect", False),
                           ("BY GENERATION STYLE", "generation_style", True),
                           ("BY VISUAL SUBJECT", "visual_subject", True),
                           ("BY SITE SECTION", "site_section", False),
                           ("BY EXTRACTION SOURCE", "extraction_source", False),
                           ("BY CONFIDENCE", "confidence", False)]:
        wr.writerow([title, "Count"])
        for k, v in counts(key, sp):
            wr.writerow([k, v])
        wr.writerow([])
with open(f"{OUT}/higgsfield_prompt_dataset.json", "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=1)

print("CSV files written")
for fn in sorted(os.listdir(OUT)):
    print(" ", fn, os.path.getsize(os.path.join(OUT, fn)), "bytes")
