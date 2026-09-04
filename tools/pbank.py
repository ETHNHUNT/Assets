import re, sys
sys.path.insert(0, '.')
from extract import get_payload
from jobs import read_string_at

def extract_prompt_bank(h, url):
    p = get_payload(h)
    if not p or 'categoryId' not in p:
        return []
    cats, secs, tabs = {}, {}, {}
    for m in re.finditer(r'id:"([0-9a-f-]{36})",slug:"([^"]*)",title:"([^"]*)",sectionId:"([0-9a-f-]{36})",count:(\d+)', p):
        cats[m.group(1)] = {"slug": m.group(2), "title": m.group(3), "count": int(m.group(5))}
    for m in re.finditer(r'id:"([0-9a-f-]{36})",slug:"([^"]*)",title:"([^"]*)"', p):
        secs.setdefault(m.group(1), m.group(3))
    for m in re.finditer(r'title:"([^"]*)",sectionId:"([0-9a-f-]{36})",order:\d+\}', p):
        tabs.setdefault(m.group(2), m.group(1))
    out = []
    for m in re.finditer(r'id:"([0-9a-f-]{36})",title:"((?:[^"\\]|\\.)*)",prompt:"', p):
        qs = m.end() - 1
        text, endq = read_string_at(p, qs)
        if not text or len(text) < 30:
            continue
        tail = p[endq:endq + 700]
        cid = (re.search(r'categoryId:"([0-9a-f-]{36})"', tail) or [None, None])[1]
        sid = (re.search(r'sectionId:"([0-9a-f-]{36})"', tail) or [None, None])[1]
        media = (re.search(r'url:"(https://[^"]+)"', tail) or [None, None])[1]
        rec = (re.search(r'recreateUrl:"([^"]*)"', tail) or [None, None])[1]
        out.append({
            "name": m.group(2).encode().decode('unicode_escape') if '\\' in m.group(2) else m.group(2),
            "prompt": text.strip(),
            "category": cats.get(cid, {}).get("title"),
            "section": secs.get(sid) or tabs.get(sid),
            "media_url": media,
            "recreate_url": rec,
            "source_url": url,
        })
    return out
