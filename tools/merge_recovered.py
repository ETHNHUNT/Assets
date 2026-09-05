"""Fold prompts an audit flagged as uncaptured back into the dataset.

`audit_barren.py` names the pages that hold prompt text found nowhere in the dataset.
Once an extractor gap is fixed, a re-run of the crawl pipeline picks those prompts up —
but into a *fresh* dataset built from a later crawl, not into the committed corpus.
Re-baselining the corpus on that crawl would churn every record id and figure for
reasons unrelated to the fix, so this merges across instead: it takes the records the
fresh run produced **for the pages the audit flagged**, and adds the ones whose prompt
text the committed corpus does not already hold.

    python3 tools/audit_barren.py --out barren_audit.json     # before the fix
    # ...fix the extractor, re-crawl or re-run master.py + clean.py -> dataset.json
    python3 tools/merge_recovered.py --fresh dataset.json --audit data/barren_audit.json

Scope is deliberately narrow. Only pages the audit listed as `uncaptured` are eligible,
so a fresh crawl's unrelated drift — pages added or changed since the corpus was built —
cannot ride in with the fix.
"""
import argparse, json, os, re, sys, unicodedata, collections

sys.path.insert(0, "tools")
sys.path.insert(0, ".")


def norm_key(t):
    t = unicodedata.normalize("NFKC", t or "")
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return re.sub(r'[^a-z0-9 ]+', '', t)[:400]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", default="dataset.json",
                    help="dataset.json from the re-run pipeline (with the fix applied)")
    ap.add_argument("--audit", default="data/barren_audit.json",
                    help="the audit that flagged the gap, from before the fix")
    ap.add_argument("--dataset", default="data/higgsfield_prompt_dataset.json",
                    help="the committed corpus to merge into")
    ap.add_argument("--out", default="dataset.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    ds = json.load(open(a.dataset))
    fresh = json.load(open(a.fresh))
    audit = json.load(open(a.audit))

    flagged = {p["url"] for p in audit["pages"] if p["bucket"] == "uncaptured"}
    if not flagged:
        print(f"{a.audit} flags no uncaptured pages — nothing to recover")
        return
    seen = {norm_key(r["prompt_text"]) for r in ds if r.get("prompt_text")}

    added, skipped = [], 0
    for r in fresh:
        if r.get("source_url") not in flagged or not r.get("prompt_text"):
            continue
        k = norm_key(r["prompt_text"])
        if k in seen:
            skipped += 1
            continue
        seen.add(k)
        added.append(r)

    print(f"corpus:   {a.dataset} ({len(ds)} records)")
    print(f"fresh:    {a.fresh} ({len(fresh)} records)")
    print(f"flagged:  {len(flagged)} page(s) the audit called uncaptured")
    print(f"added:    {len(added)}")
    print(f"skipped:  {skipped} already in the corpus")
    for url, n in collections.Counter(r["source_url"] for r in added).most_common():
        print(f"    {n:4d}  {url}")

    if a.dry_run:
        return
    json.dump(ds + added, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"\n{len(ds) + len(added)} records -> {a.out}")


if __name__ == "__main__":
    main()
