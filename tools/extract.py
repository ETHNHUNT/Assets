import re, json, sys, html

def get_payload(htmltext):
    """Return concatenated TanStack router payload scripts."""
    scr = re.findall(r'<script[^>]*>(.*?)</script>', htmltext, flags=re.S)
    return "\n".join(s for s in scr if '$_TSR' in s or '$R[' in s)

def jsonld(htmltext):
    out=[]
    for s in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', htmltext, flags=re.S):
        try: out.append(json.loads(html.unescape(s.strip())))
        except Exception: pass
    return out

def js_strings(p):
    """Yield (start,end,value) for every double-quoted JS string literal."""
    i=0; n=len(p)
    while i < n:
        c = p[i]
        if c == '"':
            j=i+1; buf=[]
            while j < n:
                d=p[j]
                if d == '\\':
                    nxt = p[j+1] if j+1<n else ''
                    esc={'n':'\n','t':'\t','r':'\r','"':'"','\\':'\\','/':'/','b':'\b','f':'\f'}
                    if nxt=='u':
                        try: buf.append(chr(int(p[j+2:j+6],16))); j+=6; continue
                        except Exception: buf.append(nxt); j+=2; continue
                    if nxt=='x':
                        try: buf.append(chr(int(p[j+2:j+4],16))); j+=4; continue
                        except Exception: buf.append(nxt); j+=2; continue
                    buf.append(esc.get(nxt,nxt)); j+=2; continue
                if d == '"': break
                buf.append(d); j+=1
            yield (i, j, "".join(buf))
            i=j+1; continue
        i+=1

def field_values(p, field):
    """Extract values of `field:"..."` (and field:$R[n]={...}) from payload."""
    res=[]
    for m in re.finditer(r'(?<![A-Za-z0-9_$])' + re.escape(field) + r'\s*:\s*', p):
        k = m.end()
        if k < len(p) and p[k] == '"':
            for (s,e,v) in js_strings(p[k:k+200000]):
                if s == 0:
                    res.append((m.start(), v)); break
    return res
