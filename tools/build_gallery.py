"""Self-contained visual index pairing every prompt with the asset it produced."""
import json, html, os, collections, re

ds = json.load(open("dataset.json"))
man = json.load(open("assets/manifest.json"))

by_rec = collections.defaultdict(list)
for m in man:
    if m.get("thumb_path"):
        by_rec[m["record_id"]].append(m)

import assets as A
cards = []
for r in ds:
    rid = A.record_id(r)
    shots = sorted(by_rec.get(rid, []), key=lambda x: x["asset_index"])
    if not shots:
        continue
    cards.append((r, rid, shots))

def esc(t, n=None):
    t = re.sub(r'\s+', ' ', str(t or "")).strip()
    if n and len(t) > n:
        t = t[:n].rsplit(" ", 1)[0] + " …"
    return html.escape(t)

tools = sorted({(c[0].get("tool_type") or "Other") for c in cards})
models = sorted({(c[0].get("model_or_effect") or "Unspecified") for c in cards})

out = []
W = out.append
W(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Higgsfield Prompt Gallery</title>
<style>
:root{{--bg:#0d0f14;--card:#161a22;--ink:#e8eaf0;--mut:#98a1b3;--line:#252b36;--acc:#7c8cff}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}
header{{position:sticky;top:0;z-index:9;background:rgba(13,15,20,.96);backdrop-filter:blur(8px);
border-bottom:1px solid var(--line);padding:14px 20px}}
h1{{margin:0 0 3px;font-size:17px;letter-spacing:.2px}}
.sub{{color:var(--mut);font-size:12px}}
.controls{{display:flex;gap:8px;flex-wrap:wrap;margin-top:11px}}
input,select{{background:var(--card);color:var(--ink);border:1px solid var(--line);
border-radius:8px;padding:7px 10px;font-size:13px;outline:none}}
input:focus,select:focus{{border-color:var(--acc)}}
input[type=search]{{flex:1;min-width:220px}}
main{{padding:18px 20px 60px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;
display:flex;flex-direction:column}}
.shots{{display:flex;gap:2px;background:#0a0c10}}
.shots img{{flex:1;min-width:0;aspect-ratio:1/1;object-fit:cover;display:block;background:#0a0c10}}
.shots img:only-child{{aspect-ratio:16/10}}
.body{{padding:11px 13px 13px}}
.nm{{font-weight:650;font-size:13px;margin-bottom:5px}}
.pr{{color:#c8cede;font-size:12px;line-height:1.5;max-height:8.2em;overflow:auto;
white-space:pre-wrap;word-break:break-word}}
.tags{{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}}
.t{{font-size:10.5px;color:var(--mut);border:1px solid var(--line);border-radius:20px;padding:2px 8px}}
.t.m{{color:var(--acc);border-color:#39406b}}
a.src{{display:block;margin-top:8px;font-size:10.5px}}
a.src{{color:#6f79a0;text-decoration:none;word-break:break-all}}
a.src:hover{{color:var(--acc)}}
.count{{color:var(--mut);font-size:12px;margin:0 0 12px}}
.hidden{{display:none}}
</style></head><body>
<header>
<h1>Higgsfield Prompt Gallery</h1>
<div class="sub">Every prompt beside what it generated · {len(cards)} records · thumbnails are 512px WebP; run <code>tools/download_assets.py</code> for originals</div>
<div class="controls">
<input type="search" id="q" placeholder="Search prompt text, name, model…">
<select id="tool"><option value="">All tool types</option>{''.join(f'<option>{esc(t)}</option>' for t in tools)}</select>
<select id="model"><option value="">All models</option>{''.join(f'<option>{esc(m)}</option>' for m in models)}</select>
<select id="pair"><option value="">Any pairing</option><option value="exact">Exact pairing only</option></select>
</div></header><main>
<p class="count" id="count"></p><div class="grid" id="grid">""")

for r, rid, shots in cards:
    imgs = "".join(
        f'<img loading="lazy" src="{esc(s["thumb_path"])}" alt="{esc(r.get("name") or "sample")}">'
        for s in shots[:4])
    txt = r.get("prompt_text") or r.get("description") or ""
    tags = []
    if r.get("model_or_effect"):
        tags.append(f'<span class="t m">{esc(r["model_or_effect"])}</span>')
    for k in ("tool_type", "generation_style", "visual_subject"):
        v = r.get(k)
        if v:
            for part in str(v).split("; ")[:2]:
                tags.append(f'<span class="t">{esc(part)}</span>')
    if len(shots) > 1:
        tags.append(f'<span class="t">{len(shots)} samples</span>')
    hay = esc(((r.get("name") or "") + " " + txt + " " + (r.get("model_or_effect") or "")).lower(), 900)
    W(f'''<article class="card" data-tool="{esc(r.get("tool_type") or "Other")}"
 data-model="{esc(r.get("model_or_effect") or "Unspecified")}"
 data-pair="{esc(r.get("media_pairing") or "")}" data-h="{hay}">
<div class="shots">{imgs}</div><div class="body">
<div class="nm">{esc(r.get("name") or r.get("tool_type") or "Prompt")}</div>
<div class="pr">{esc(txt, 1200)}</div>
<div class="tags">{"".join(tags)}</div>
<a class="src" href="{esc(r.get("source_url"))}" target="_blank" rel="noopener">{esc(r.get("source_url"))}</a>
</div></article>''')

W("""</div></main><script>
const q=document.getElementById('q'),tool=document.getElementById('tool'),
mdl=document.getElementById('model'),pair=document.getElementById('pair'),
cards=[...document.querySelectorAll('.card')],cnt=document.getElementById('count');
function apply(){
 const s=q.value.trim().toLowerCase(),t=tool.value,m=mdl.value,p=pair.value;let n=0;
 for(const c of cards){
  const ok=(!s||c.dataset.h.includes(s))&&(!t||c.dataset.tool===t)&&
           (!m||c.dataset.model===m)&&(!p||c.dataset.pair===p);
  c.classList.toggle('hidden',!ok); if(ok)n++;
 }
 cnt.textContent=n+' of '+cards.length+' records shown';
}
[q,tool,mdl,pair].forEach(e=>e.addEventListener('input',apply));apply();
</script></body></html>""")

os.makedirs("assets", exist_ok=True)
open("assets/gallery.html", "w", encoding="utf-8").write("\n".join(out))
print(f"gallery: {len(cards)} cards, {sum(len(s) for _,_,s in cards)} thumbnails referenced")
