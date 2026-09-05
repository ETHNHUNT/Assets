"""Fold the prompts an extractor fix recovered into the committed corpus.

When an extractor gap is fixed, re-running the pipeline over the *same* crawl produces
a dataset holding prompts the previous run missed. Those belong in the corpus — but
re-baselining the corpus on the newer crawl would churn every record id and figure for
reasons unrelated to the fix, and would quietly fold in whatever the site changed in
the meantime.

So this merges the difference instead. Give it the pipeline's output from before the
fix and from after it, both built over the same pages/, and it adds to the corpus every
prompt the second run found and the first did not:

    # before: git stash the fix, run master.py + clean.py -> dataset_before.json
    # after:  apply the fix,     run master.py + clean.py -> dataset.json
    python3 tools/merge_recovered.py --before dataset_before.json --after dataset.json

Because both runs read identical inputs, the difference between them is the fix and
nothing else — no crawl drift can ride in behind it. Prompts the corpus already holds
are skipped, so re-running is safe.
"""
import argparse, collections, json, re, sys, unicodedata


def norm_key(t):
    """The dedupe key clean.py uses, so "already held" means what it means there."""
    t = unicodedata.normalize("NFKC", t or "")
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return re.sub(r'[^a-z0-9 ]+', '', t)[:400]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True, help="pipeline output without the fix")
    ap.add_argument("--after", default="dataset.json", help="pipeline output with the fix")
    ap.add_argument("--dataset", default="data/higgsfield_prompt_dataset.json",
                    help="the committed corpus to merge into")
    ap.add_argument("--out", default="dataset.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    ds = json.load(open(a.dataset))
    before = json.load(open(a.before))
    after = json.load(open(a.after))

    prior = {norm_key(r["prompt_text"]) for r in before if r.get("prompt_text")}
    held = {norm_key(r["prompt_text"]) for r in ds if r.get("prompt_text")}

    # A prompt the fixed run found, the unfixed run did not, and the corpus lacks.
    added, already, lost = [], 0, 0
    for r in after:
        t = r.get("prompt_text")
        if not t:
            continue
        k = norm_key(t)
        if k in prior:
            continue
        if k in held:
            already += 1
            continue
        held.add(k)
        added.append(r)

    # The fix must not cost anything: a prompt the old run had and the new one lacks is
    # a regression, and worth refusing to merge over.
    post = {norm_key(r["prompt_text"]) for r in after if r.get("prompt_text")}
    lost = [r for r in before if r.get("prompt_text") and norm_key(r["prompt_text"]) not in post]

    print(f"corpus:   {a.dataset} ({len(ds)} records)")
    print(f"before:   {a.before} ({len(before)} records)")
    print(f"after:    {a.after} ({len(after)} records)")
    print(f"recovered: {len(added)} prompt(s) new to the corpus"
          f"{f', {already} already held' if already else ''}")
    for url, n in collections.Counter(r["source_url"] for r in added).most_common():
        print(f"    {n:4d}  {url}")
    if lost:
        print(f"\nREFUSING TO MERGE: {len(lost)} prompt(s) present before the fix and absent "
              f"after it — that is a regression, not a recovery:")
        for r in lost[:5]:
            print(f"    {r['source_url']}  {' '.join((r['prompt_text'] or '').split())[:70]}")
        sys.exit(1)

    if a.dry_run:
        return
    json.dump(ds + added, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"\n{len(ds) + len(added)} records -> {a.out}")


if __name__ == "__main__":
    main()
