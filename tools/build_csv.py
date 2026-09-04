import json, csv, collections, os

d = json.load(open("dataset.json"))
OUT = "deliverables"
os.makedirs(OUT, exist_ok=True)

COLS = [
    ("record_type", "Record Type"), ("name", "Name"), ("prompt_text", "Prompt Text"),
    ("description", "Description"), ("model_or_effect", "Model / Motion Effect"),
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
print("CSV files written")
for fn in sorted(os.listdir(OUT)):
    print(" ", fn, os.path.getsize(os.path.join(OUT, fn)), "bytes")
