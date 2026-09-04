import re, os, glob, html, sys
sys.path.insert(0, '.')
import crawl

known = set(u.strip() for u in open('known4.txt') if u.strip())
found = set()
for f in glob.glob('pages/*.html'):
    h = open(f, encoding='utf-8', errors='replace').read()
    for m in re.finditer(r'href="([^"]+)"', h):
        u = html.unescape(m.group(1))
        if u.startswith('//'): continue
        if u.startswith('http'):
            if not u.startswith('https://higgsfield.ai/'): continue
            path = u[len('https://higgsfield.ai'):]
        elif u.startswith('/'):
            path = u
        else:
            continue
        path = path.split('#')[0]
        if not path: path = '/'
        if any(path.lower().endswith(e) for e in ('.xml', '.json', '.png', '.jpg', '.webp', '.mp4', '.svg', '.ico', '.txt')):
            continue
        if not crawl.allowed(path):
            continue
        full = 'https://higgsfield.ai' + path
        if full not in known:
            found.add(full)
print(len(found))
open('discovered.txt', 'w').write("\n".join(sorted(found)))
