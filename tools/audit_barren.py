"""Classify the crawled pages that produced no record.

Section 9 of the README says of the barren URLs: "Whether those pages are genuinely
empty or the extractors missed them cannot be settled from this repository", because
`pages/` was never committed. Re-crawl (`python3 tools/crawl.py data/known4.txt`) and
this settles it, one page at a time.

Each barren page lands in one of three buckets:

  no_payload            the SSR payload the extractors read is not in the HTML at all
                        — a client-rendered shell, so there is nothing to have missed
  payload_no_prompt     the payload is there and carries no prompt-bearing field
                        — the page genuinely holds no prompt
  prompt_field_present  the payload does carry a prompt-bearing field, and nothing was
                        extracted — a real extractor gap, listed per URL so it can be
                        chased

    python3 tools/audit_barren.py                    # -> barren_audit.json + a summary
    python3 tools/audit_barren.py --dataset dataset.json --limit-examples 5
"""
import argparse, collections, glob, json, os, re, sys

sys.path.insert(0, "tools")
sys.path.insert(0, ".")
from recreate import srcurl
from extract import get_payload

# Fields the extractors key on. If none appears in a payload, no extractor could have
# produced a prompt from it however it was written.
# Only fields that carry prompt text itself. `categoryId` and `jobSetType` mark a card
# of some kind and appear on pages with no prompt anywhere, so counting them would
# report page furniture as a missed extraction.
PROMPT_FIELDS = [r'prompt:"', r'"prompt":', r'promptText:"', r'prompt_text:"',
                 r'"prompt_text":']


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


def classify(html):
    payload = get_payload(html)
    if not payload:
        return "no_payload", 0
    hits = sum(len(re.findall(f, payload)) for f in PROMPT_FIELDS)
    return ("prompt_field_present" if hits else "payload_no_prompt"), hits


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
    produced = {r["source_url"] for r in json.load(open(ds_path))}
    files = sorted(glob.glob(os.path.join(a.pages, "*.html")))
    if not files:
        sys.exit(f"no pages in {a.pages}/ — run: python3 tools/crawl.py data/known4.txt")

    print(f"dataset: {ds_path} ({len(produced)} source urls)")
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
            counts["produced_a_record"] += 1
            by_shape[shape(url)]["produced"] += 1
            continue
        bucket, hits = classify(html)
        counts[bucket] += 1
        by_shape[shape(url)][bucket] += 1
        rows.append({"url": url, "file": f, "bucket": bucket,
                     "prompt_field_hits": hits, "bytes": len(html)})
        if i % 500 == 0:
            print(f"  {i}/{len(files)} ...", flush=True)

    json.dump({"dataset": ds_path, "counts": dict(counts), "pages": rows},
              open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    total = sum(counts.values())
    print("\nOverall")
    for k, v in counts.most_common():
        print(f"  {v:6d}  {100*v/total:5.1f}%  {k}")

    print("\nBy URL shape (barren pages only)")
    hdr = f"  {'shape':44s} {'produced':>8s} {'no_payload':>11s} {'no_prompt':>10s} {'MISSED':>7s}"
    print(hdr); print("  " + "-" * (len(hdr) - 2))
    for sh, c in sorted(by_shape.items(), key=lambda kv: -sum(v for k, v in kv[1].items() if k != "produced")):
        barren = sum(v for k, v in c.items() if k != "produced")
        if not barren:
            continue
        print(f"  {sh[:44]:44s} {c['produced']:8d} {c['no_payload']:11d} "
              f"{c['payload_no_prompt']:10d} {c['prompt_field_present']:7d}")

    missed = [r for r in rows if r["bucket"] == "prompt_field_present"]
    print(f"\n{len(missed)} page(s) carry a prompt-bearing field but produced nothing")
    for r in sorted(missed, key=lambda r: -r["prompt_field_hits"])[:a.limit_examples]:
        print(f"  {r['prompt_field_hits']:5d} hits  {r['url']}")
    print(f"\nfull detail -> {a.out}")


if __name__ == "__main__":
    main()
