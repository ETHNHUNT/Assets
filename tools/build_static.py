"""Static, crawlable HTML for the corpus the atlas renders in a canvas.

The atlas is one `<canvas>` and 79 words of markup. Everything a reader came for —
2,936 prompts, 3.1 MB of text — exists only after JavaScript runs and only as pixels,
which means a search engine sees nothing, a text browser sees nothing, and assistive
technology that never gets as far as running the scene sees nothing.

So this writes the same corpus as ordinary HTML: paginated, linked, and pointing back
into the atlas at the record it is showing. It is not a second interface to maintain —
it has no controls, no state and no script — it is the content, in the form the web
was built to carry.

Paginated at 250 rather than emitted whole because 2,936 records is about 4 MB of
markup, and a 4 MB page is impolite to a crawler and unusable on a phone. Twelve pages
of ~350 KB each are neither.

    python3 tools/build_static.py

Writes web/prompts/index.html and web/prompts/p<N>.html.
"""
import html
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECORDS = os.path.join(ROOT, "web", "data", "records.json")
OUT = os.path.join(ROOT, "web", "prompts")
PER_PAGE = 250

CSS = """
:root{color-scheme:dark;--bg:#07080c;--fg:#e8ecf6;--dim:#8b93a8;--line:#1c2030;--acc:#7c8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:820px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin:0 0 28px}
a{color:var(--acc)}
article{border-top:1px solid var(--line);padding:20px 0}
article h2{font-size:14px;font-weight:650;margin:0 0 6px}
.meta{color:var(--dim);font-size:12px;margin:0 0 10px}
.meta span+span:before{content:" · "}
pre{white-space:pre-wrap;word-wrap:break-word;margin:0;font:inherit}
nav{display:flex;gap:14px;flex-wrap:wrap;padding:24px 0;border-top:1px solid var(--line);
  margin-top:24px;font-size:13px}
"""


def esc(v):
    return html.escape(str(v or ""), quote=True)


def article(r):
    """One record, with everything a reader or a crawler would want from it."""
    meta = []
    if r.get("m"):
        meta.append(f"<span>{esc(r['m'])}</span>")
    if r.get("t"):
        meta.append(f"<span>{esc(r['t'])}</span>")
    if r.get("k"):
        meta.append(f"<span>{esc(r['k'])}</span>")
    if r.get("w"):
        meta.append(f"<span>{r['w']} words</span>")
    for s in (r.get("s") or [])[:3]:
        meta.append(f"<span>{esc(s)}</span>")
    body = esc(r.get("p")) or "<em>This preset publishes no prompt text.</em>"
    # id="…" so the anchor works here, and a link into the atlas at the same record
    return (
        f'<article id="{esc(r["id"])}">\n'
        f'  <h2>{esc(r.get("n") or r.get("t") or "Prompt")}</h2>\n'
        f'  <p class="meta">{"".join(meta)}</p>\n'
        f'  <pre>{body}</pre>\n'
        f'  <p class="meta"><a href="../index.html#{esc(r["id"])}">Open in the atlas</a>'
        + (f' · <a href="{esc(r["u"])}" rel="nofollow noopener">Source</a>' if r.get("u") else "")
        + "</p>\n</article>"
    )


def page(title, desc, body, links, canonical):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(canonical)}">
<style>{CSS}</style>
</head>
<body>
<main>
<h1>{esc(title)}</h1>
<p class="sub">{esc(desc)}</p>
{body}
<nav>{links}</nav>
</main>
</body>
</html>
"""


def main():
    data = json.load(open(RECORDS, encoding="utf-8"))
    recs = data["records"] if isinstance(data, dict) and "records" in data else data
    os.makedirs(OUT, exist_ok=True)

    pages = [recs[i:i + PER_PAGE] for i in range(0, len(recs), PER_PAGE)]
    n = len(pages)

    for k, chunk in enumerate(pages, 1):
        links = ['<a href="index.html">All pages</a>',
                 '<a href="../index.html">The atlas</a>']
        if k > 1:
            links.append(f'<a href="p{k - 1}.html">Previous</a>')
        if k < n:
            links.append(f'<a href="p{k + 1}.html">Next</a>')
        body = "\n".join(article(r) for r in chunk)
        out = page(f"Prompts, page {k} of {n}",
                   f"{len(chunk)} of {len(recs):,} generation prompts from the Higgsfield "
                   f"corpus, as plain text.",
                   body, " ".join(links), f"p{k}.html")
        with open(os.path.join(OUT, f"p{k}.html"), "w", encoding="utf-8") as f:
            f.write(out)

    idx_body = "<article>\n<h2>Pages</h2>\n<p class=\"meta\">" + " ".join(
        f'<span><a href="p{k}.html">{k}</a></span>' for k in range(1, n + 1)
    ) + "</p>\n</article>"
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(page("Higgsfield prompt corpus",
                     f"All {len(recs):,} prompts as plain text, across {n} pages. "
                     f"The same corpus the atlas renders.",
                     idx_body,
                     '<a href="../index.html">The atlas</a>', "index.html"))

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"wrote {n} pages + index for {len(recs):,} records "
          f"({total / 1e6:.1f} MB, ~{total / 1e3 / (n + 1):.0f} KB each)")


if __name__ == "__main__":
    main()
