import re, html
TAG = re.compile(r'<[^>]+>')
WS = re.compile(r'[ \t ]+')

CINE = ["shot","camera","lighting","lens","angle","close-up","closeup","cinematic","frame","framing",
        "background","foreground","palette","depth of field","bokeh","tracking","dolly","pan ","tilt",
        "wide-angle","aerial","slow motion","golden hour","backlit","silhouette","texture","render",
        "photorealistic","hyperrealistic","4k","8k","macro","portrait","aspect ratio","color grade",
        "mood","atmosphere","composition","subject","scene","style:","wardrobe","props","foley"]
STRUCT = ["format & style","format and style:","camera:","lighting:","subject:","style:","prompt:",
          "main subject","wardrobe and props","actions & camera","sound & foley","dialogue","montage plan",
          "location:","lens:","palette:"]
BAD = ["sign up","log in","pricing","cookie","all rights reserved","privacy policy","terms of service",
       "subscribe to our","help center","©","your browser does not support"]

def clean(s):
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'</(p|div|li|h[1-6])>', '\n', s)
    s = html.unescape(TAG.sub('', s))
    s = WS.sub(' ', s)
    s = re.sub(r'\n\s*\n+', '\n', s)
    return s.strip()

def looks_like_prompt(t):
    if not t: return False
    n = len(t)
    if n < 60 or n > 6000: return False
    low = t.lower()
    if any(b in low for b in BAD): return False
    if low.count('http') > 2: return False
    words = t.split()
    if len(words) < 12: return False
    # too many short nav-ish tokens
    if sum(1 for w in words if len(w) > 3) / len(words) < 0.35: return False
    if any(s in low for s in STRUCT): return True
    hits = sum(1 for c in CINE if c in low)
    if hits >= 3: return True
    if hits >= 2 and n >= 160: return True
    return False


IMPER = ("specify","direct","follow","establish","use ","achieve","place ","define","set ","add ",
         "keep ","describe","choose","select","try ","avoid","ensure","detail ","combine","start ",
         "write ","think ","remember","note that","consider","begin ","include ","apply ","treat ",
         "experiment","learn ","explore ","discover","create a prompt","when creating","for maximum",
         "for best","to prevent","make sure","let the")
ADVICE_MARK = ("your prompt","the model","the ai","you can","you'll","you will","we recommend",
               "guidelines","in this guide","this article","step 1","step-by-step","pro tip","tips",
               "how to ","best practice","e.g.","etc.","should be","helps you","allows you",
               "higgsfield","click ","upload ","select the","toggle","dropdown","menu")
SCENE_OPEN = re.compile(r'^(a|an|the|close[- ]?up|wide|medium|low[- ]angle|high[- ]angle|extreme|'
                        r'pov|first[- ]person|aerial|drone|macro|cinematic|ultra[- ]?detailed|'
                        r'hyper[- ]?realistic|photorealistic|slow[- ]motion|tracking|dolly|handheld|'
                        r'static|straight[- ]on|overhead|top[- ]down|side|front|back|establishing|'
                        r'portrait|full[- ]body|head[- ]tracking|birds?[- ]eye|worms?[- ]eye)\b', re.I)
STRONG = ("format & style:","format and style:","hex values:","camera:","lens:","lighting & palette",
          "actions & camera","sound & foley","montage plan","wardrobe and props","dialogue (full)")

def classify(t):
    """Return 'prompt' or 'guidance'."""
    low = t.lower().strip()
    if any(s in low for s in STRONG):
        return "prompt"
    advice = sum(1 for a in ADVICE_MARK if a in low)
    imper = 1 if low.startswith(IMPER) else 0
    # second-person density
    if re.search(r'\byou(r)?\b', low):
        advice += 1
    scene = 1 if SCENE_OPEN.match(low) else 0
    if scene and advice == 0:
        return "prompt"
    if imper or advice >= 2:
        return "guidance"
    if advice >= 1 and not scene:
        return "guidance"
    return "prompt" if scene else "guidance"

BLOCK_RX = re.compile(r'<(p|blockquote|pre|code|li)\b[^>]*>(.*?)</\1>', re.S | re.I)

def extract_prose(h, url):
    body = re.sub(r'<script.*?</script>', ' ', h, flags=re.S)
    body = re.sub(r'<style.*?</style>', ' ', body, flags=re.S)
    seen = set(); out = []
    for m in BLOCK_RX.finditer(body):
        t = clean(m.group(2))
        if not looks_like_prompt(t): continue
        k = re.sub(r'\W+', '', t.lower())[:200]
        if k in seen: continue
        seen.add(k)
        out.append({"prompt": t, "source_url": url, "tag": m.group(1).lower(), "kind": classify(t)})
    return out
