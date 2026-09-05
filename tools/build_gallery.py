"""Self-contained visual index pairing every prompt with the asset it produced."""
import json, html, os, collections, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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

def esc_full(t):
    """Escape without collapsing whitespace — prompts carry meaningful line breaks."""
    return html.escape(str(t or "").strip())

def esc(t, n=None):
    t = re.sub(r'\s+', ' ', str(t or "")).strip()
    if n and len(t) > n:
        t = t[:n].rsplit(" ", 1)[0] + " …"
    return html.escape(t)

tools = sorted({(c[0].get("tool_type") or "Other") for c in cards})
models = sorted({(c[0].get("model_or_effect") or "Unspecified") for c in cards})
# Built from the records themselves. A hard-coded list silently rots: the previous
# "Exact pairing only" option matched zero of the 2,619 cards.
PAIR_LABEL = {"": "On the record itself (no inference)"}
pairings = sorted({(c[0].get("media_pairing") or "") for c in cards})
kinds = sorted({(c[0].get("asset_type") or "") for c in cards if c[0].get("asset_type")})

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
.shots a,.shots span.sh{{flex:1;min-width:0;position:relative;display:block;line-height:0}}
.shots img{{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:#0a0c10}}
.shots a:only-child img,.shots span.sh:only-child img{{aspect-ratio:16/10}}
.shots a:hover img{{opacity:.82}}
.badge{{position:absolute;left:6px;bottom:6px;font-size:10px;line-height:1.4;color:#fff;
background:rgba(0,0,0,.62);border-radius:4px;padding:1px 5px;pointer-events:none}}
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
.bar{{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}}
button.cp{{background:var(--card);color:var(--mut);border:1px solid var(--line);border-radius:7px;
padding:4px 9px;font-size:11px;font-family:inherit;cursor:pointer}}
button.cp:hover{{border-color:var(--acc);color:var(--ink)}}
button.cp.ok{{color:#7ee0a8;border-color:#2f6b4a}}
a.rid{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:#5f6880;
text-decoration:none}}
a.rid:hover{{color:var(--acc)}}
.count{{color:var(--mut);font-size:12px;margin:0 0 12px}}
.empty{{color:var(--mut);font-size:13px;background:var(--card);border:1px solid var(--line);
border-radius:10px;padding:16px 18px;max-width:640px}}
.card:target{{border-color:var(--acc);box-shadow:0 0 0 2px rgba(124,140,255,.35)}}
.hidden{{display:none}}
</style></head><body>
<header>
<h1>Higgsfield Prompt Gallery</h1>
<div class="sub">Every prompt beside what it generated · {len(cards)} of {len(ds)} records (the rest have no paired asset) ·
click a thumbnail for the full-resolution original · thumbnails are 512px WebP, run <code>tools/download_assets.py</code> to fetch originals in bulk</div>
<div class="controls">
<input type="search" id="q" aria-label="Search prompts" placeholder="Search full prompt text, name, model…">
<select id="tool"><option value="">All tool types</option>{''.join(f'<option>{esc(t)}</option>' for t in tools)}</select>
<select id="model"><option value="">All models</option>{''.join(f'<option>{esc(m)}</option>' for m in models)}</select>
<select id="pair"><option value="__any">Any pairing</option>{''.join(
   f'<option value="{esc(p)}">{esc(PAIR_LABEL.get(p) or p)}</option>' for p in pairings)}</select>
<select id="kind"><option value="">Image and video</option>{''.join(
   f'<option value="{esc(k)}">{esc(k).capitalize()} only</option>' for k in kinds)}</select>
</div></header><main>
<p class="count" id="count"></p>
<p class="empty hidden" id="empty">No records match these filters. Clearing the search box or
widening a filter will bring results back.</p>
<div class="grid" id="grid">""")

def shot_html(s, alt):
    """Thumbnail, linked to the full-resolution original where we have its URL."""
    img = f'<img loading="lazy" src="{esc(s["thumb_path"])}" alt="{alt}">'
    badge = '<span class="badge">video</span>' if s.get("asset_type") == "video" else ""
    url = s.get("full_res_url") or s.get("poster_url")
    if not url:
        return f'<span class="sh">{img}{badge}</span>'
    return (f'<a href="{esc(url)}" target="_blank" rel="noopener" '
            f'title="Open the full-resolution original">{img}{badge}</a>')

for r, rid, shots in cards:
    alt = esc(r.get("name") or "sample")
    imgs = "".join(shot_html(s, alt) for s in shots[:4])
    txt = r.get("prompt_text") or r.get("description") or ""
    tags = []
    if r.get("model_or_effect"):
        tags.append(f'<span class="t m">{esc(r["model_or_effect"])}</span>')
    for k in ("tool_type", "generation_style", "visual_subject"):
        v = r.get(k)
        if v:
            for part in str(v).split("; ")[:2]:
                tags.append(f'<span class="t">{esc(part)}</span>')
    if r.get("asset_type"):
        tags.append(f'<span class="t">{esc(r["asset_type"])}</span>')
    if len(shots) > 1:
        tags.append(f'<span class="t">{len(shots)} samples</span>')
    # presets can carry no prompt and no description — don't offer a no-op button
    copy_btn = ('<button class="cp" type="button">Copy prompt</button>' if txt.strip() else "")
    W(f'''<article class="card" id="{rid}" data-tool="{esc(r.get("tool_type") or "Other")}"
 data-model="{esc(r.get("model_or_effect") or "Unspecified")}"
 data-pair="{esc(r.get("media_pairing") or "")}" data-kind="{esc(r.get("asset_type") or "")}"
 data-n="{esc((r.get("name") or "") + " " + (r.get("model_or_effect") or ""), 160)}">
<div class="shots">{imgs}</div><div class="body">
<div class="nm">{esc(r.get("name") or r.get("tool_type") or "Prompt")}</div>
<div class="pr">{esc_full(txt)}</div>
<div class="tags">{"".join(tags)}</div>
<div class="bar">{copy_btn}<a class="rid" href="#{rid}" title="Permalink — also the join key for manifest.csv and the CSV/Excel/JSON exports">{rid}</a></div>
<a class="src" href="{esc(r.get("source_url"))}" target="_blank" rel="noopener">{esc(r.get("source_url"))}</a>
</div></article>''')

W("""</div></main><script>
const q=document.getElementById('q'),tool=document.getElementById('tool'),
mdl=document.getElementById('model'),pair=document.getElementById('pair'),
kind=document.getElementById('kind'),cards=[...document.querySelectorAll('.card')],
cnt=document.getElementById('count'),empty=document.getElementById('empty');

// Search the whole prompt, not a truncated copy of it. Indexed once at load from
// the text already on the page, so there is no second copy of 2.29M characters.
const hay=cards.map(c=>(c.dataset.n+' '+c.querySelector('.pr').textContent).toLowerCase());

function apply(){
 const s=q.value.trim().toLowerCase(),t=tool.value,m=mdl.value,p=pair.value,k=kind.value;let n=0;
 for(let i=0;i<cards.length;i++){
  const c=cards[i];
  const ok=(!s||hay[i].includes(s))&&(!t||c.dataset.tool===t)&&
           (!m||c.dataset.model===m)&&(p==='__any'||c.dataset.pair===p)&&
           (!k||c.dataset.kind===k);
  c.classList.toggle('hidden',!ok); if(ok)n++;
 }
 cnt.textContent=n+' of '+cards.length+' records shown';
 empty.classList.toggle('hidden',n>0);
}
[q,tool,mdl,pair,kind].forEach(e=>e.addEventListener('input',apply));apply();

// A permalink must survive the filters, so reveal its target before jumping to it.
function jump(){
 const id=location.hash.slice(1); if(!id) return;
 const el=document.getElementById(id); if(!el) return;
 if(el.classList.contains('hidden')){
  q.value='';tool.value='';mdl.value='';pair.value='__any';kind.value='';apply();
 }
 el.scrollIntoView({block:'center'});
}
addEventListener('hashchange',jump); if(location.hash) setTimeout(jump,0);

function copyText(t){
 if(navigator.clipboard&&window.isSecureContext) return navigator.clipboard.writeText(t);
 return new Promise((res,rej)=>{                       // file:// fallback
  const ta=document.createElement('textarea');
  ta.value=t; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-1000px';
  document.body.appendChild(ta); ta.select();
  const ok=document.execCommand('copy'); document.body.removeChild(ta);
  ok?res():rej();
 });
}
document.getElementById('grid').addEventListener('click',e=>{
 const b=e.target.closest('button.cp'); if(!b) return;
 const t=b.closest('.card').querySelector('.pr').textContent;
 const done=(msg,cls)=>{b.textContent=msg; if(cls)b.classList.add(cls);
  setTimeout(()=>{b.textContent='Copy prompt';b.classList.remove('ok');},1300);};
 copyText(t).then(()=>done('Copied \u2713','ok')).catch(()=>done('Press \u2318/Ctrl+C'));
});
</script></body></html>""")

os.makedirs("assets", exist_ok=True)
open("assets/gallery.html", "w", encoding="utf-8").write("\n".join(out))
print(f"gallery: {len(cards)} cards, {sum(len(s) for _,_,s in cards)} thumbnails referenced")
