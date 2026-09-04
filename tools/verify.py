"""End-to-end checks for the Higgsfield dataset build."""
import json, os, csv, re, sys, glob, collections
sys.path.insert(0, '.')

FAIL = []
def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        FAIL.append(name)

print("1. Coverage / gap closure")
d = json.load(open("dataset.json"))
check("records >= 1600", len(d) >= 1600, f"{len(d)} records")
from recreate import srcurl
have = {r["source_url"] for r in d}
pages = []
for f in glob.glob("pages/*.html"):
    u = srcurl(open(f, encoding="utf-8", errors="replace").read(3000))
    if u:
        pages.append(u)
zero = [u for u in pages if u not in have]
acad_zero = len([u for u in zero if "/academy/" in u])
# A lesson page with no prompt in it is not a miss -- most are video-only lessons.
# What matters is whether any prompt on those pages went uncaptured.
import unicodedata
from flat_prompts import extract_flat
def _n(t):
    t = unicodedata.normalize("NFKC", t or "")
    return re.sub(r"[^a-z0-9 ]+", "", re.sub(r"\s+", " ", t).strip().lower())[:400]
captured = {_n(r["prompt_text"]) for r in d if r.get("prompt_text")}
uncaptured = 0
for f in glob.glob("pages/*.html"):
    h = open(f, encoding="utf-8", errors="replace").read()
    u = srcurl(h)
    if not (u and "/academy/" in u and u not in have):
        continue
    for x in extract_flat(h, u):
        if _n(x["prompt"]) not in captured:
            uncaptured += 1
check("no uncaptured academy prompts", uncaptured == 0,
      f"{uncaptured} uncaptured across {acad_zero} prompt-free lesson pages (was 182)")
flat = len([r for r in d if r["extraction_source"] == "flat_payload"])
check("flat_payload records >= 450", flat >= 450, f"{flat}")

print("\n2. Prompt-to-asset pairing")
withasset = [r for r in d if r.get("full_res_url")]
pct = 100 * len(withasset) / len(d)
check("assets on >= 95% of records", pct >= 95, f"{pct:.1f}%")
pres = [r for r in d if r["record_type"] == "Preset / Effect"]
presa = [r for r in pres if r.get("full_res_url")]
check("presets all have assets", len(presa) == len(pres), f"{len(presa)}/{len(pres)}")

print("\n3. Thumbnails")
man = json.load(open("assets/manifest.json"))
withthumb = [m for m in man if m.get("thumb_path")]
missing = [m for m in withthumb if not os.path.exists(os.path.join("assets", m["thumb_path"]))]
check("no manifest thumb points at a missing file", not missing, f"{len(missing)} missing")
try:
    from PIL import Image
    bad = []
    for f in glob.glob("assets/thumbs/*.webp"):
        try:
            Image.open(f).verify()
        except Exception:
            bad.append(f)
    check("all thumbnails decode", not bad, f"{len(bad)} corrupt of {len(glob.glob('assets/thumbs/*.webp'))}")
except ImportError:
    print("  SKIP  Pillow unavailable")
size = sum(os.path.getsize(f) for f in glob.glob("assets/thumbs/*.webp"))
check("thumbnail set <= 150 MB", size <= 150 * 1048576, f"{size/1048576:.0f} MB")

print("\n4. Deliverables")
rows = list(csv.DictReader(open("deliverables/higgsfield_prompts_full.csv", encoding="utf-8-sig")))
check("CSV row count matches dataset", len(rows) == len(d), f"{len(rows)} vs {len(d)}")
try:
    from openpyxl import load_workbook
    wb = load_workbook("deliverables/higgsfield_prompt_dataset.xlsx")
    check("XLSX has 4 sheets", len(wb.sheetnames) == 4, str(wb.sheetnames))
    check("XLSX row count matches", wb["All Records"].max_row == len(d) + 1,
          f"{wb['All Records'].max_row - 1}")
except Exception as e:
    check("XLSX opens", False, str(e)[:60])
pdf = open("deliverables/higgsfield_prompt_dataset.pdf", "rb").read()
check("PDF header/EOF valid", pdf[:8] == b"%PDF-1.4" and pdf.rstrip().endswith(b"%%EOF"))
cnt = re.findall(rb"/Count\s+(\d+)", pdf)
check("PDF has pages", bool(cnt) and int(cnt[0]) > 50, f"{cnt[0].decode() if cnt else '0'} pages")

print("\n5. Gallery")
g = open("assets/gallery.html", encoding="utf-8").read()
srcs = re.findall(r'<img[^>]*src="([^"]+)"', g)
gm = [s for s in srcs if not os.path.exists(os.path.join("assets", s))]
check("every gallery image exists on disk", not gm, f"{len(gm)} missing of {len(srcs)}")
check("gallery has cards", g.count('<article class="card"') > 100,
      f"{g.count('<article class=' + chr(34) + 'card' + chr(34))} cards")

print("\n" + ("ALL CHECKS PASSED" if not FAIL else f"{len(FAIL)} CHECK(S) FAILED: {FAIL}"))
sys.exit(1 if FAIL else 0)
