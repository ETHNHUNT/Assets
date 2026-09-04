import os, re, sys, time, hashlib, threading, queue, gzip, io
import urllib.request, urllib.error

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
OUT = "pages"
os.makedirs(OUT, exist_ok=True)

# --- robots disallow rules (English/root scope) ---
DISALLOW = []
for line in open("robots.txt", encoding="utf-8", errors="replace"):
    line = line.strip()
    if line.lower().startswith("disallow:"):
        p = line.split(":", 1)[1].strip()
        if p:
            DISALLOW.append(p.rstrip("$"))
DISALLOW = sorted(set(DISALLOW))

LOCALE_RE = re.compile(r'^/(es|ja|ko|de)(/|$)')

def allowed(path):
    if LOCALE_RE.match(path):
        return False
    for d in DISALLOW:
        if d.endswith("/"):
            if path.startswith(d):
                return False
        else:
            if path == d or path.startswith(d + "/") or path.startswith(d + "?"):
                return False
    return True

def keyfor(url):
    return hashlib.sha1(url.encode()).hexdigest() + ".html"

def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return r.status, data.decode("utf-8", errors="replace")

lock = threading.Lock()
done = {}
stats = {"ok": 0, "err": 0}

def worker(q):
    while True:
        try:
            url = q.get_nowait()
        except queue.Empty:
            return
        fp = os.path.join(OUT, keyfor(url))
        if os.path.exists(fp) and os.path.getsize(fp) > 500:
            with lock:
                stats["ok"] += 1
            q.task_done(); continue
        code = None
        for attempt in range(3):
            try:
                code, body = fetch(url)
                with open(fp, "w", encoding="utf-8") as f:
                    f.write("<!--SRCURL:" + url + "-->\n" + body)
                with lock:
                    stats["ok"] += 1
                break
            except Exception as e:
                code = str(e)
                time.sleep(1.5 * (attempt + 1))
        else:
            with lock:
                stats["err"] += 1
                open("errors.log", "a").write(url + "\t" + str(code) + "\n")
        time.sleep(0.15)
        q.task_done()

def run(urls, nthreads=6):
    q = queue.Queue()
    for u in urls:
        q.put(u)
    ts = [threading.Thread(target=worker, args=(q,), daemon=True) for _ in range(nthreads)]
    for t in ts: t.start()
    total = len(urls)
    while any(t.is_alive() for t in ts):
        time.sleep(5)
        with lock:
            print(f"  progress {stats['ok']+stats['err']}/{total} ok={stats['ok']} err={stats['err']}", flush=True)
    for t in ts: t.join()

if __name__ == "__main__":
    urls = [u.strip() for u in open(sys.argv[1]) if u.strip()]
    urls = [u for u in urls if allowed(u.replace("https://higgsfield.ai", "") or "/")]
    print("crawling", len(urls), "urls; disallow rules:", len(DISALLOW), flush=True)
    run(urls)
    print("DONE ok=%d err=%d" % (stats["ok"], stats["err"]), flush=True)
