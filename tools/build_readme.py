import json, collections, statistics, os, glob, sys
sys.path.insert(0, '.')

d = json.load(open("dataset.json"))
man = json.load(open("assets/manifest.json"))

# Read the real width rather than restating it — this was hard-coded, and wrong.
import csv as _csv
try:
    with open("data/higgsfield_prompts_full.csv", encoding="utf-8-sig") as _f:
        NCOLS = len(next(_csv.reader(_f)))
except FileNotFoundError:
    NCOLS = "?"
P = [r for r in d if r["record_type"] == "Prompt"]
E = [r for r in d if r["record_type"] != "Prompt"]
wc = [r["word_count"] for r in P if r["word_count"]]
thumbs = glob.glob("assets/thumbs/*.webp")
tsize = sum(os.path.getsize(f) for f in thumbs) / 1048576
withasset = [r for r in d if r.get("full_res_url")]
pages = len(glob.glob("pages/*.html"))
known = len([l for l in open("known4.txt") if l.strip()])

def tbl(counter, head, top=None, total=None):
    rows = counter.most_common(top)
    out = [f"| {head} | Records |", "|---|---|"]
    for k, v in rows:
        out.append(f"| {k or '(unspecified)'} | {v} |")
    return "\n".join(out)

tool = collections.Counter(r["tool_type"] for r in d)
model = collections.Counter(r["model_or_effect"] for r in d if r["model_or_effect"])
style = collections.Counter(x for r in d if r["generation_style"] for x in r["generation_style"].split("; "))
subj = collections.Counter(x for r in d if r["visual_subject"] for x in r["visual_subject"].split("; "))
src = collections.Counter(r["extraction_source"] for r in d)
pair = collections.Counter(r.get("media_pairing") for r in d if r.get("media_pairing"))
buckets = collections.Counter()
for r in P:
    w = r["word_count"] or 0
    buckets["1–25" if w < 26 else "26–75" if w < 76 else "76–200" if w < 201
            else "201–500" if w < 501 else "500+"] += 1
order = ["1–25", "26–75", "76–200", "201–500", "500+"]

README = f"""# Higgsfield.ai Prompt & Preset Dataset

A systematic crawl of the public surface of **higgsfield.ai**, extracting every discoverable prompt
and pairing each one with the image or video it generated. Delivered as a narrative report, an
Excel/CSV dataset, a browsable HTML gallery, and a print-ready PDF.

| | |
|---|---|
| **Pages crawled** | {pages:,} (0 fetch errors) |
| **URLs mapped** | {known:,} unique public URLs |
| **Records extracted** | **{len(d):,}** |
| — literal prompts | {len(P):,} |
| — presets / motion effects | {len(E):,} |
| **Records with a paired asset** | {len(withasset):,} ({100*len(withasset)/len(d):.1f}%) |
| **Assets catalogued** | {len(man):,} |
| **Thumbnails committed** | {len(thumbs):,} WebP ({tsize:.0f} MB) |
| **Prompt text captured** | ~{sum(r['char_count'] or 0 for r in P)/1000:.0f}K characters |
| **Prompt length** | {min(wc)}–{max(wc):,} words (median {int(statistics.median(wc))}) |
| **Crawl date** | 2026-09-04 |

---

## 1. What's here

Every record carries the full prompt text, a description of what it creates, the associated model or
motion effect, the source page URL — and **the asset it produced**. Open
[`assets/gallery.html`](assets/gallery.html) to browse prompts beside their results, or filter the
spreadsheet by model, style, or subject.

Thumbnails (512px WebP) are committed so the gallery and PDF work straight from a clone. The
full-resolution originals — roughly 8 GB of PNG and MP4 — are **not** in the repo; fetch them with:

```bash
python3 tools/download_assets.py                 # everything
python3 tools/download_assets.py --images-only   # stills only
python3 tools/download_assets.py --tool "Viral Preset"
```

---

## 2. How the site was mapped

`robots.txt` advertises eleven sitemaps, which enumerate 1,138 URLs. Three link-discovery passes over
the fetched HTML — following every internal `href` and diffing against what was already known — grew
that to **{pages:,} fetched pages**, including ~3,600 per-example sub-pages
(`/motion/<id>/<exampleId>`, `/viral-presets/examples/<slug>/<exampleId>`) that carry the individual
creator samples. The final discovery pass returned **zero** new pages, so the reachable public surface
is exhausted.

All 37 `Disallow` rules in `robots.txt` are parsed and enforced in code (`tools/crawl.py`), including
`/me/`, `/library/`, `/share/`, `/flow/`, `/soul/`, `/mixed-media-community/`, `/viral-presets/use/`
and the four non-English locale trees. Six concurrent workers, 150 ms delay, exponential backoff.
Nothing behind authentication was touched.

---

## 3. How prompts and assets were extracted

Higgsfield is a **TanStack Start** app. Each page inlines a server-rendered router payload — a
`$R[n]=…` object graph — that holds the real generation records behind every gallery tile. That
payload, not the rendered DOM, is the high-fidelity source. Seven extractors run over every page,
and an eighth source reaches what no page renders:

| Extractor | Reads | Records |
|---|---|---|
| `flat_prompts.py` | flat `prompt:"…"` records, incl. academy lesson `video_cues` with `recreate_url`, shot timestamps and lesson media | {src.get('flat_payload',0):,} |
| `catalog.py` | motion / viral / mixed-media preset pages: name, description, model, preview video + creator examples | {src.get('catalog_page',0):,} |
| `prose.py` | long `<p>`/`<pre>`/`<blockquote>` blocks in blog and academy articles, classifier-gated | {src.get('article_body',0):,} |
| `jobs.py` | nested `prompt:{{prompt:"…"}}` job records with `jobSetType`, preset, quality, aspect ratio, duration and the job's own `media:` block | {src.get('job_payload',0):,} |
| `recreate.py` | `?recreate=<prompt>&model=<model>` hrefs behind "Recreate" buttons | {src.get('recreate_link',0):,} |
| `figures.py` | `<figcaption>` / `aria-label` on demo figures, plus platform/tier badges | {src.get('figure_caption',0):,} |
| `pbank.py` | the Academy Prompt Bank's `{{title, prompt, categoryId, media}}` records, across every `?page=` | {src.get('prompt_bank',0):,} |
| `api_feeds.py` | the community feeds' public JSON gateway — the pages of each feed that SSR never renders, and Seedance 2.5's prompt text | {src.get('api_feed',0):,} |

### Pairing each prompt to its asset

The `media_pairing` column records **how** each asset was matched, so weaker inferences can be
filtered out:

{tbl(pair, 'Pairing method')}

- **exact** / **preset-preview** — the asset came from the record's own `media:{{rawUrl, source,
  thumbnail, width, height}}` block or the preset's `<video>` preview. Unambiguous.
- **payload-proximity** / **proximity** — nearest media to the prompt inside the payload or the DOM.
  Right in the large majority of spot-checks, but inferred.
- **lesson** — the academy lesson video the prompt's shot appears in (with a timestamp).
- **figure** — the `<figure>` element the caption belongs to.

A shared filter (`tools/assetfilter.py`) rejects site furniture — profile avatars and banners,
country flags, logos, placeholder thumbnails — so decorative images don't get pass off as samples.

### Separating prompts from prose

Article bodies mix genuine prompts with marketing copy and how-to advice. A two-stage classifier
(`tools/prose.py`) resolves it: `looks_like_prompt()` requires length, word density, and either a
structural marker (`Format & Style:`, `Camera:`, `HEX VALUES:`) or ≥3 cinematographic terms;
`classify()` then weighs scene-opening grammar against second-person instructional markers.
For figure captions a page-frequency rule does the heavy lifting — a caption appearing on more than
three distinct pages is boilerplate, not a prompt.

Every record is graded **High / Medium / Low** confidence.
{sum(1 for r in d if r['confidence']=='High'):,} of {len(d):,} ({100*sum(1 for r in d if r['confidence']=='High')/len(d):.0f}%) are High.

---

## 4. What the corpus looks like

### By tool type

{tbl(tool, 'Tool type')}

### By model / motion engine

{tbl(model, 'Model', 16)}

{len([r for r in d if not r['model_or_effect']]):,} records carry no attributable model — mostly
model-agnostic blog and academy pages. Where the URL or a `recreate_url` names one it is used;
otherwise the field is left empty rather than guessed.

### By generation style (multi-label)

{tbl(style, 'Style', 12)}

### By visual subject (multi-label)

{tbl(subj, 'Subject', 10)}

### By prompt length

| Words | Prompts |
|---|---|
""" + "\n".join(f"| {k} | {buckets[k]} |" for k in order if buckets[k]) + f"""

The bimodality is deliberate — Higgsfield's own Sora 2 guide teaches "two formulas": short
high-signal prompts that let the model direct, and high-control prompts specifying every shot. The
longest record is a {max(wc):,}-word Seedance scene breakdown using `@character` reference tokens
across a full multi-shot sequence.

---

## 5. Observed prompt conventions

Patterns that recur across the high-fidelity records:

- **Shot-first grammar.** Prompts open by naming the shot, not the subject: *"A low-angle full-body
  shot captures…"*, *"Head-tracking flight shot of a peregrine falcon."*
- **Labelled blocks for long prompts** — `Format & Style:`, `Camera:`, `Lens:`, `Main Subject(s):`,
  `Wardrobe and Props`, `Lighting & Palette`, `Actions & Camera Beats (0–12 s)`, `Dialogue (full)`,
  `Sound & Foley`, `Montage Plan`.
- **Timecoded beats.** `• 0–4 s — …`, `[0–2s] – CUT 1 / OPEN.`
- **Palette pinning via hex.** Soul image prompts append a literal `HEX VALUES: ["#1c3633", …]`
  array — typically 15 colours — to lock the grade.
- **Bracketed slots.** Prompt Bank camera moves are templates: *"…starting on [composition A] and
  sweeping across [the environment]…"* — the move stays separate from the scene so it survives a
  frame swap.
- **Negative constraints.** *"no sideways travel, no dolly, no truck, no arc, no slide, no zoom,
  no tilt."*
- **Reference tokens.** `@truck1`, `@woman`, `@fantasy-dragon`, `<<<video_1>>>`, `<<<image_1>>>`.

---

## 6. Deliverables

| File | Format | Contents |
|---|---|---|
| `assets/gallery.html` | HTML | **Visual index** — every prompt beside what it generated, with search and filters by tool, model and pairing method |
| `data/higgsfield_prompt_dataset.xlsx` | Excel | 4 sheets — All Records, Prompts, Presets and Effects, Summary |
| `data/higgsfield_prompts_full.csv` | CSV | All {len(d):,} records, {NCOLS} columns, UTF-8 BOM + fully quoted |
| `data/higgsfield_prompts_only.csv` | CSV | The {len(P):,} literal prompts |
| `data/higgsfield_presets_effects.csv` | CSV | The {len(E):,} presets / motion effects |
| `data/higgsfield_summary.csv` | CSV | Cross-tabs by tool, model, style, subject, section, source, confidence |
| `data/higgsfield_prompt_dataset.pdf` | PDF | Formatted catalogue with **thumbnails printed beside each prompt** |
| `data/higgsfield_prompt_dataset.json` | JSON | Structured records for programmatic use |
| `assets/manifest.csv` / `.json` | CSV/JSON | Every asset: record, role, type, full-res URL, poster, thumbnail path |
| `assets/thumbs/*.webp` | WebP | {len(thumbs):,} thumbnails ({tsize:.0f} MB) |

---

## 7. Reproducing

```bash
cd tools
python3 crawl.py all_urls.txt      # fetch corpus        -> pages/
python3 discover.py                # link discovery
python3 master.py                  # 7 extractors        -> raw_rows.jsonl
python3 clean.py                   # dedupe + categorise -> dataset.json
python3 assets.py --width 512 --max-extra 4   # manifest + thumbnails
python3 build_gallery.py && python3 build_csv.py && python3 build_xlsx.py && python3 build_pdf.py
python3 verify.py                  # end-to-end checks
```

Crawl and extraction use only the standard library; `openpyxl`, `reportlab` and `Pillow` are needed
for the Excel, PDF and thumbnail-validation steps.

---

## 8. Known limitations

Stated plainly rather than papered over:

1. **The headless browser cannot reach this site from the build sandbox.** Chromium and Playwright
   are installed and correctly configured, but every navigation to higgsfield.ai fails with
   `ERR_CONNECTION_RESET` — the sandbox's egress proxy closes the browser's tunnels mid-exchange
   (`ws_closed_mid_exchange`) while plain `curl` on the same URL succeeds. Verified repeatedly with
   proxy args, `--ignore-certificate-errors`, and HTTP/2 and QUIC disabled. Mining the SSR payload is
   the workaround, and it recovers strictly more structured data than scraping a rendered DOM would.
2. **Client-side paginated tails are unreachable.** The TanStack server-function endpoint
   (`TSS_SERVER_FN_BASE = "/_serverFn/"`, SHA-256 ids) returns **404** to direct GET and POST calls.
   So the Academy Prompt Bank yields 24 of its 46 camera movements, and community feeds yield only
   the server-rendered slice ({len([r for r in d if r['site_section']=='soul-community'])} of a
   reported 148 for `soul-community`). `?category=` and `?section=` query variants do not change the
   SSR slice.
3. **Seedance 2.5's community feed ships no prompt text in SSR** — only `jobId` and media, with
   prompts fetched per item client-side.
4. **Proximity-paired assets are inferences.** {pair.get('payload-proximity',0)+pair.get('proximity',0):,}
   records were matched by nearest-media rather than an explicit link. Spot-checks were overwhelmingly
   correct, but filter on `media_pairing` if you need only exact pairs.
5. **Mixed-media presets have boilerplate descriptions.** The site serves a generic string for them;
   it is nulled out rather than presented as a real description.
6. **{len(d)-len(withasset):,} records have no asset** — chiefly article prompts with no nearby image.

---

## 9. Provenance

Retrieved from publicly accessible pages on higgsfield.ai on 2026-09-04, honouring `robots.txt`.
Prompt text, preset names, effect descriptions and generated media are Higgsfield's and their
creators'; this is a structured index of public material assembled for research and analysis.
Community prompts and their samples were authored by the site's users and appear on public community
pages. Thumbnails are reduced-resolution copies included for identification; full-resolution
originals are deliberately not redistributed here.
"""
# README.md is hand-maintained. It carries material this script cannot generate --
# the column reference, the join guide, the corrected build steps, the limitations --
# and overwriting it silently reverted all of that, along with four figures that had
# been corrected against the data. So write a digest instead and let a human merge.
OUT = "data/README_stats.md"
BANNER = (
    "<!-- Generated by tools/build_readme.py. This is a DIGEST, not the README.\n"
    "     README.md is hand-maintained: copy across whichever figures below have\n"
    "     changed, rather than replacing the file. -->\n\n"
)
os.makedirs("data", exist_ok=True)
open(OUT, "w", encoding="utf-8").write(BANNER + README)
print(f"{OUT} written ({len(README)} chars)")
print("README.md was NOT touched — merge any changed figures into it by hand.")
