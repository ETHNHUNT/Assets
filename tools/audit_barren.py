"""Classify the crawled pages that produced no record.

Section 9 of the README says of the barren URLs: "Whether those pages are genuinely
empty or the extractors missed them cannot be settled from this repository", because
`pages/` was never committed. Re-crawl (`python3 tools/crawl.py data/known4.txt`) and
this settles it, one page at a time.

Each barren page lands in one of four buckets:

  no_payload            the SSR payload the extractors read is not in the HTML at all
                        — a client-rendered shell, so there is nothing to have missed
  payload_no_prompt     the payload is there and carries no prompt-bearing field
                        — the page genuinely holds no prompt
  captured_elsewhere    the page holds prompts, and every one of them is already in the
                        dataset under another URL — the pipeline dedupes across pages,
                        so a listing and its example pages yield one record between them
  uncaptured            the page holds prompt text that appears nowhere in the dataset
                        — the only barren bucket that is a real extractor gap

Pages that DID produce a record are checked for the same thing and reported separately as
`produced_but_incomplete`: contributing one prompt is no guarantee a page gave up all of
them, and auditing only the barren pages understates the gap.

Bucketing by "did this URL appear as a source_url" alone would call the third bucket a
miss, which is why it is checked against every prompt in the dataset, not just the ones
attributed to that page.

    python3 tools/audit_barren.py                    # -> barren_audit.json + a summary
    python3 tools/audit_barren.py --dataset dataset.json --limit-examples 5
"""
import argparse, collections, glob, json, os, re, sys

sys.path.insert(0, "tools")
sys.path.insert(0, ".")
import unicodedata

from recreate import srcurl
from extract import get_payload
from jobs import read_string_at


def norm_key(t):
    """The dedupe key clean.py uses, so "captured" here means captured there."""
    t = unicodedata.normalize("NFKC", t or "")
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return re.sub(r'[^a-z0-9 ]+', '', t)[:400]

# Fields the extractors key on. If none appears in a payload, no extractor could have
# produced a prompt from it however it was written.
# Only fields that carry prompt text itself. `categoryId` and `jobSetType` mark a card
# of some kind and appear on pages with no prompt anywhere, so counting them would
# report page furniture as a missed extraction.
PROMPT_FIELDS = [r'(?<![A-Za-z_])prompt:"', r'(?<![A-Za-z_])"prompt":',
                 r'(?<![A-Za-z_])promptText:"', r'(?<![A-Za-z_])prompt_text:"',
                 r'(?<![A-Za-z_])"prompt_text":']


def shape(url):
    """Collapse a URL to the family the README's barren table counts in."""
    p = url.replace("https://higgsfield.ai", "")
    p = re.sub(r'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '/<uuid>', p)
    p = re.sub(r'\?.*$', '', p)
    segs = [s for s in p.split('/') if s]
    if not segs:
        return '/'
    head = segs[0]
    if head.startswith('@'):
        head = '@<creator>'
    return '/' + '/'.join([head] + ['<seg>' if s != '<uuid>' else s for s in segs[1:]])


MIN_PROMPT_CHARS = 30       # what the extractors themselves treat as a prompt


def payload_prompts(payload):
    """Every prompt string in a payload, read with the pipeline's own string reader."""
    out = []
    # (?<![A-Za-z_]) so negative_prompt and enhance_prompt do not read as prompts:
    # a negative prompt is a list of things to avoid, and the pipeline excludes both.
    for m in re.finditer(r'(?<![A-Za-z_])prompt(?:_text)?"?\s*:\s*(?=")', payload):
        text, _ = read_string_at(payload, m.end())
        if text and len(text.strip()) >= MIN_PROMPT_CHARS:
            out.append(text.strip())
    return out


def classify(html, captured):
    payload = get_payload(html)
    if not payload:
        return "no_payload", 0, []
    hits = sum(len(re.findall(f, payload)) for f in PROMPT_FIELDS)
    if not hits:
        return "payload_no_prompt", 0, []
    prompts = payload_prompts(payload)
    missing = [t for t in prompts if norm_key(t) not in captured]
    if not prompts:
        # A prompt-bearing key with nothing readable behind it — an empty string or a
        # shape the reader does not handle. Not a captured prompt, not a missed one.
        return "payload_no_prompt", hits, []
    return ("uncaptured" if missing else "captured_elsewhere"), hits, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=None,
                    help="default: dataset.json if present, else the committed copy")
    ap.add_argument("--pages", default="pages")
    ap.add_argument("--out", default="barren_audit.json")
    ap.add_argument("--limit-examples", type=int, default=8)
    a = ap.parse_args()

    ds_path = a.dataset or ("dataset.json" if os.path.exists("dataset.json")
                            else "data/higgsfield_prompt_dataset.json")
    dataset = json.load(open(ds_path))
    produced = {r["source_url"] for r in dataset}
    captured = {norm_key(r["prompt_text"]) for r in dataset if r.get("prompt_text")}
    files = sorted(glob.glob(os.path.join(a.pages, "*.html")))
    if not files:
        sys.exit(f"no pages in {a.pages}/ — run: python3 tools/crawl.py data/known4.txt")

    print(f"dataset: {ds_path} ({len(produced)} source urls, {len(captured)} distinct prompts)")
    print(f"pages:   {len(files)}\n")

    rows, counts = [], collections.Counter()
    by_shape = collections.defaultdict(collections.Counter)
    for i, f in enumerate(files, 1):
        html = open(f, encoding="utf-8", errors="replace").read()
        url = srcurl(html)
        if not url:
            counts["unreadable"] += 1
            continue
        if url in produced:
            # A page that yielded a record can still be hiding others: the first version
            # of this audit skipped these entirely and so reported the extractor gap as
            # 22 prompts when it was 28. Check them too, and count separately — a page
            # that contributed is not "barren" however many prompts it also withheld.
            counts["produced_a_record"] += 1
            by_shape[shape(url)]["produced"] += 1
            _, _, missing = classify(html, captured)
            if missing:
                counts["produced_but_incomplete"] += 1
                rows.append({"url": url, "file": f, "bucket": "produced_but_incomplete",
                             "prompt_field_hits": 0, "bytes": len(html),
                             "uncaptured_count": len(missing),
                             "uncaptured_examples": [t[:300] for t in missing[:3]]})
            continue
        bucket, hits, missing = classify(html, captured)
        counts[bucket] += 1
        by_shape[shape(url)][bucket] += 1
        rows.append({"url": url, "file": f, "bucket": bucket,
                     "prompt_field_hits": hits, "bytes": len(html),
                     "uncaptured_count": len(missing),
                     "uncaptured_examples": [t[:300] for t in missing[:3]]})
        if i % 500 == 0:
            print(f"  {i}/{len(files)} ...", flush=True)

    json.dump({"dataset": ds_path, "counts": dict(counts), "pages": rows},
              open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    total = sum(counts.values())
    print("\nOverall")
    for k, v in counts.most_common():
        print(f"  {v:6d}  {100*v/total:5.1f}%  {k}")

    print("\nBy URL shape (barren pages only, largest first)")
    hdr = (f"  {'shape':40s} {'made':>5s} {'noPayl':>6s} {'noPrompt':>8s} "
           f"{'elsewhere':>9s} {'UNCAPT':>6s}")
    print(hdr); print("  " + "-" * (len(hdr) - 2))
    ranked = sorted(by_shape.items(),
                    key=lambda kv: -sum(v for k, v in kv[1].items() if k != "produced"))
    for sh, c in ranked[:25]:
        if not sum(v for k, v in c.items() if k != "produced"):
            continue
        print(f"  {sh[:40]:40s} {c['produced']:5d} {c['no_payload']:6d} "
              f"{c['payload_no_prompt']:8d} {c['captured_elsewhere']:9d} {c['uncaptured']:6d}")

    missed = [r for r in rows if r["bucket"] in ("uncaptured", "produced_but_incomplete")]
    lost = sum(r["uncaptured_count"] for r in missed)
    print(f"\n{len(missed)} page(s) hold prompt text found nowhere in the dataset "
          f"({lost} prompt(s) in total)")
    for r in sorted(missed, key=lambda r: -r["uncaptured_count"])[:a.limit_examples]:
        print(f"  {r['uncaptured_count']:4d} uncaptured  {r['url']}")
        for t in r["uncaptured_examples"][:1]:
            print(f"        {re.sub(chr(92) + 's+', ' ', t)[:110]}")
    print(f"\nfull detail -> {a.out}")


if __name__ == "__main__":
    main()
