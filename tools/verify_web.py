"""Pixel-level regression check for the 3D atlas.

The atlas is 1,500 lines of layout, morph and physics code that all writes the same
transform buffers. Refactoring it safely needs a way to answer "does it still draw the
same thing?", and eyeballing it does not scale. This renders a fixed set of scenes
headlessly and compares each frame's perceptual signature against a committed baseline.

    python3 tools/verify_web.py --update     # capture the baseline (do this BEFORE a refactor)
    python3 tools/verify_web.py              # check the current code against it
    python3 tools/verify_web.py --backend webgl

Signatures are a 16x16 grid of mean luma, not raw pixels: a software rasteriser and a
real GPU disagree in the low bits of every antialiased edge, but they agree on where
the tiles are. A tile that moves shifts the grid; a recompiled shader does not.

Measured on this workload, per scene kind — noise is repeat runs against an unchanged
baseline, signal is a deliberate ~1% perturbation of that scene's own code:

    scene kind   noise   signal
    layout         0     14   grid pitch 1.5 -> 1.52
    physics       0-1     7   linear damping 0.16 -> 0.1618
    detail        0-1    12   centre-crop offset /2 -> /2.4

A tolerance of 3 sits above every noise floor and well under every signal, which is what
makes it worth keeping tight. The layout scenes are exactly reproducible; physics and the
detail cache carry a little float and decode noise, so they are not, and a tolerance of 0
would be unusable. Never widen it to silence a diff you have not explained.

Baselines are specific to a backend and a machine — re-capture after changing browser,
driver or backend.

The browser always launches headed: headless Chrome has no surface to present to, so it
hands back SwiftShader and a software frame that is not what you meant to test. On macOS
that is the whole story — WebGPU runs on Metal unaided. On Linux it needs the recipe from
README section 7, headed under Xvfb with software Vulkan pinned, which this sets up itself;
without mesa-vulkan-drivers it falls back to the WebGL2 backend and says so.

Whichever path runs, the backend and adapter actually bound are checked against the one
asked for, and a mismatch exits rather than quietly recording the wrong frame.
"""
import argparse, http.server, json, os, socket, socketserver, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE_DIR = os.path.join(ROOT, "web", "docs")


def baseline_path(backend, tag=None):
    """Baselines are per-backend and per-machine, so they get separate files.

    A signature captured on llvmpipe/WebGL2 in a container and one captured on a real
    GPU are not comparable, and keeping both under one filename means whoever captures
    last breaks everyone else. `--tag` names the machine; the default keeps the
    container's file where it already is.
    """
    name = f"baseline.{backend}" + (f".{tag}" if tag else "") + ".json"
    return os.path.join(BASELINE_DIR, name)
VULKAN_ICD = "/usr/share/vulkan/icd.d/lvp_icd.json"


def chromium_path():
    """The browser Playwright's own version pin expects may not be the one installed.

    Sandboxes commonly ship a fixed Chromium under PLAYWRIGHT_BROWSERS_PATH and forbid
    downloading another, so prefer whatever full Chromium is actually on disk (the
    headless shell will not do — a WebGPU swapchain reads back blank without a
    surface). Returning None lets Playwright use its own default.
    """
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    if not os.path.isdir(root):
        return None
    cands = []
    for d in sorted(os.listdir(root)):
        if not d.startswith("chromium-"):
            continue
        for rel in ("chrome-linux/chrome", "chrome-linux64/chrome"):
            exe = os.path.join(root, d, rel)
            if os.path.exists(exe):
                cands.append(exe)
    return cands[-1] if cands else None

CHROME_FLAGS = [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist", "--disable-gpu-driver-bug-workarounds",
    "--disable-gpu-watchdog", "--no-sandbox",
]

# Linux reaches WebGPU through a software Vulkan stack, and pinning it is what makes a
# container reproducible. macOS reaches it through Metal and needs none of this — asking
# Chrome for Vulkan there points it at a driver the machine does not have.
LINUX_VULKAN_FLAGS = ["--enable-features=Vulkan", "--disable-vulkan-surface"]

# Each scene is (name, layout mode, camera position, physics steps). The camera is
# parked explicitly because OrbitControls damping never quite settles, and a drifting
# camera would make every signature differ from the last.
#
# A scene with a step count is a physics scene, and is captured differently: a layout
# settles and then holds still, so it can be waited on, but a pile never settles. What
# is reproducible about it is "exactly N steps from a seeded start", so the page is
# asked to run those steps synchronously rather than waited on.
SCENES = [
    ("grid-front",   "grid",     (0, 0, 96),    None, None),
    ("grid-angled",  "grid",     (60, 34, 70),  None, None),
    ("sphere",       "sphere",   (0, 10, 120),  None, None),
    ("helix",        "helix",    (0, 0, 130),   None, None),
    ("by-model",     "model",    (0, 20, 150),  None, None),
    ("physics-transit", "grid",  (0, 0, 96),    90,   None),
    # Close enough to trip the detail cache. A tile has to cover DETAIL_MIN_PX (74px)
    # before it is worth a full-res load, which works out at roughly 8 units — every
    # other scene here sits at 96 or further, so without this one the LOD path, and the
    # aToPos.w / aMeta writes it owns, are never executed at all.
    ("detail-closeup", "grid",   (0, 0, 7),     None, None),

    # The two lanes highlight.js owns are invisible to every scene above: nothing is
    # filtered and nothing is hovered, so dim sits at 1, focus at 0, and the easing
    # loop never writes. These two are the only ones that execute it — a filter is the
    # dim lane mid-wave, a hover is the focus lane. The bug that stranded the furthest
    # tile after a filter cleared lived here for the whole life of the harness.
    ("filtered",       "grid",   (0, 0, 96),    None, {"filter": "portrait"}),
    # Same camera as grid-front on purpose: the only difference between the two frames
    # is the focus lane on one tile, so this is a controlled comparison rather than a
    # new view. A closer camera was tried and was not stable — at z=24 the frame varied
    # by maxD 118 between runs whose highlight lanes read identically, so whatever moved
    # was not what this scene is here to measure.
    ("hovered",        "grid",   (0, 0, 96),    None, {"hover": 1462}),
    # Filter, then clear, then assert every tile came back. A stranded tile is one of
    # 2,936 and moves no luma cell past a tolerance of 3, so this scene is checked by
    # its post-condition rather than by its signature — the pixels are captured too,
    # but they are not what would fail.
    ("filter-cleared", "grid",   (0, 0, 96),    None, {"filter": "portrait", "clear": True}),
    # A grid ordered by prompt length rather than by tool. Short prompts and the 538
    # presets that publish none gather at one end, so the wall gains a gradient a
    # signature can see — which the default order does not have.
    ("sorted-length",  "grid",   (0, 0, 96),    None, {"sort": "length"}),
]

# Any fixed value works; it only has to be the same one the baseline was captured with.
SEED = 1


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(port):
    """navigator.gpu needs a secure context, so the page has to come off localhost."""
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def log_message(self, *a):
            pass

    httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def check_sort(page):
    """A sort has to actually reorder, and the order has to be the one it claims.

    The atlas was always ordered — the build sorts by tool then model — but fixed and
    invisible, which on 2,936 tiles reads the same as unordered. So the thing to check
    is not that a control exists but that the laid-out sequence obeys it.

    Monotonicity is the assertion for length, because it is checkable rather than
    merely different: every tile's word count must be at least the one before it. And
    the order must genuinely change, or a comparator that quietly returned 0 would
    pass a monotonicity test on data that happened to arrive sorted.
    """
    res = page.evaluate("""() => {
      const A = window.__atlas;
      A.clearHighlight();
      A.setLayout('grid', true);

      A.setSort('');
      const base = A.order();
      A.setSort('length');
      const byLen = A.order();
      const w = A.wordCounts(byLen);

      let drops = 0, firstDrop = null;
      for (let i = 1; i < w.length; i++) {
        if (w[i] < w[i - 1]) { drops++; if (!firstDrop) firstDrop = [i, w[i - 1], w[i]]; }
      }
      let moved = 0;
      for (let i = 0; i < base.length; i++) if (base[i] !== byLen[i]) moved++;

      A.setSort('model');
      const byModel = A.order();
      A.setSort('');
      return { n: byLen.length, drops, firstDrop, moved,
               first: w.slice(0, 3), last: w.slice(-3),
               modelChanged: byModel.some((v, i) => v !== base[i]) };
    }""")
    if res["drops"]:
        sys.exit(f"sort: prompt length is not monotonic across the laid-out order — "
                 f"{res['drops']} places where a tile has fewer words than the one "
                 f"before it, first at index {res['firstDrop']}")
    if res["moved"] < res["n"] * 0.5:
        sys.exit(f"sort: only {res['moved']} of {res['n']} tiles changed place when "
                 f"sorting by length. The comparator is barely reordering anything.")
    if not res["modelChanged"]:
        sys.exit("sort: ordering by model produced the atlas order unchanged")
    print(f"  sort: {res['n']} tiles ordered by length, monotonic, "
          f"{res['moved']} moved (from {res['first']} to {res['last']} words)")


def check_labels(page):
    """Cluster labels have to be controls, not captions.

    "By model" reads as analysis — headings with record counts — but a heading that
    tells you a model holds 1,338 records and cannot show you them is describing the
    work rather than doing it.

    So: every label must name a model that exists, isolating one must leave exactly
    the count the label claimed, and the rolled-up tail must not pretend to be a
    model — "12 smaller models" is a bucket, and filtering to a model of that name
    would match nothing at all.
    """
    res = page.evaluate("""() => {
      const A = window.__atlas;
      A.clearHighlight();
      A.setLayout('clusters', true);
      const labels = A.labels();
      const clickable = labels.filter((l) => l.key);
      const out = { total: labels.length, clickable: clickable.length, checked: [] };
      for (const l of clickable) {
        const shown = A.isolate(l.key);
        const n = parseInt(shown.replace(/,/g, ''), 10);
        out.checked.push({ key: l.key, n, claimed: l.count });
      }
      A.clearHighlight();
      return out;
    }""")
    if not res["clickable"]:
        sys.exit("labels: no cluster label carries a model to isolate")
    if res["clickable"] >= res["total"]:
        sys.exit(f"labels: all {res['total']} labels are clickable, so the rolled-up "
                 f"tail is claiming to be a model it is not")
    empty = [c for c in res["checked"] if c["n"] < 1]
    if empty:
        sys.exit(f"labels: isolating a label matched nothing, e.g. {empty[:3]} — the "
                 f"key does not correspond to a value the model filter accepts")
    # The count on the label is a promise about what clicking it gives you.
    lying = [c for c in res["checked"] if c["n"] != c["claimed"]]
    if lying:
        sys.exit(f"labels: a label's count is not what isolating it returns, e.g. "
                 f"{lying[:3]} (as key/got/claimed). The heading is describing a set "
                 f"the filter does not produce.")
    print(f"  labels: {res['clickable']} of {res['total']} isolate a model "
          f"(tail correctly inert), e.g. "
          f"{res['checked'][0]['key']} -> {res['checked'][0]['n']} records, "
          f"matching every label's stated count")


def check_url(browser, base, viewport):
    """A view has to survive being sent to someone else.

    Selection already lived in the hash; mode, filters and sort did not, so a link to
    "grid, this model, sorted by length, this record" was a set of instructions rather
    than a URL. This drives one page into a state, takes the URL it produced, and
    opens it in a second page — which is the only honest way to test the round trip,
    since reading back what you just wrote proves nothing about whether it can be read.

    A fresh page, not a reload: the state has to come from the URL alone and not from
    anything the first page left behind.
    """
    a = browser.new_page(viewport=viewport, reduced_motion="reduce")
    a.goto(base, wait_until="load")
    a.wait_for_function("() => window.__atlas && window.__atlas.counts.instances>0")
    made = a.evaluate("""() => {
      const A = window.__atlas;
      A.setLayout('sphere', true);
      A.setSort('length');
      A.setFilter('portrait');
      const order = A.order();
      A.select(order[3]);
      return { url: A.url, count: document.querySelector('#count').textContent,
               selected: A.panel.selected, rid: A.panel.rid };
    }""")
    a.close()

    if not made["url"]["query"]:
        sys.exit("url: driving the view wrote nothing to the query string")

    shared = base.split("?")[0] + "?" + made["url"]["query"] + "&" + \
        base.split("?", 1)[1] + made["url"]["hash"]
    b = browser.new_page(viewport=viewport, reduced_motion="reduce")
    b.goto(shared, wait_until="load")
    b.wait_for_function("() => window.__atlas && window.__atlas.counts.instances>0")
    got = b.evaluate("""() => {
      const A = window.__atlas;
      return { count: document.querySelector('#count').textContent,
               sort: document.querySelector('#f-sort').value,
               q: document.querySelector('#q').value,
               mode: [...document.querySelector('#modes').children]
                 .find((c) => c.classList.contains('on'))?.dataset.mode,
               selected: A.panel.selected, rid: A.panel.rid,
               open: A.panel.open };
    }""")
    b.close()

    if got["count"] != made["count"]:
        sys.exit(f"url: the shared link shows {got['count']!r}, the view it came from "
                 f"showed {made['count']!r} — the filter did not survive")
    if got["mode"] != "sphere" or got["sort"] != "length" or got["q"] != "portrait":
        sys.exit(f"url: mode/sort/query did not survive the round trip ({got})")
    if not got["open"] or got["rid"] != made["rid"]:
        sys.exit(f"url: the selected record did not survive — opened {got['rid']!r}, "
                 f"expected {made['rid']!r}")
    print(f"  url: {made['count']} + sphere + sort + selection survive a fresh page "
          f"({len(made['url']['query'])} chars of query)")


def check_audio(page, bursts=500):
    """The audio graph, and the voice cap that keeps a collapsing pile from killing it.

    A 2,936-body pile generates thousands of contact events per frame. Every impact
    that gets through builds a buffer source, a filter and a gain and hangs them off
    the master, so without a ceiling one frame of a collapse fans out into thousands
    of live nodes. The cap is five per 16 ms window and it is the whole reason sound
    survives physics mode.

    Nothing needs an audio device for this. Under ?audio=0 — which every run here uses
    — toggle() still constructs the context and builds the graph, then returns false
    and leaves `on` false, so the silent path is exactly what the harness is already
    running. The cap is exercised by forcing `on` and counting nodes; a suspended
    context creates them quite happily, it simply never plays them.

    The lower bound on that count matters as much as the upper one. A cap check that
    passes because nothing was created at all is the failure mode this whole harness
    keeps running into, so the assertion is 1 <= created <= 5, never just <= 5.
    """
    res = page.evaluate("""([bursts]) => {
      const a = window.__atlas.audio;
      const out = {};

      return (async () => {
        const enabled = await a.toggle();          // ?audio=0: builds, stays silent
        out.toggleReturned = enabled;
        out.on = a.on;
        out.built = !!(a.ctx && a.master && a.bed);
        if (!out.built) return out;

        // count what actually reaches the graph
        const ctx = a.ctx;
        let sources = 0, oscs = 0;
        const realSrc = ctx.createBufferSource.bind(ctx);
        const realOsc = ctx.createOscillator.bind(ctx);
        ctx.createBufferSource = () => { sources++; return realSrc(); };
        ctx.createOscillator = () => { oscs++; return realOsc(); };

        // silent while off
        for (let k = 0; k < 50; k++) { a.impact(0.5); a.select(); a.morph(); }
        out.whileOff = sources + oscs;

        // the cap, with one window forced open
        let panners = 0;
        const realPan = ctx.createPanner.bind(ctx);
        ctx.createPanner = () => { panners++; return realPan(); };

        a.on = true;
        sources = 0; oscs = 0;
        a.impactWindow = 0; a.impacts = 0;
        for (let k = 0; k < bursts; k++) a.impact(0.6);
        out.capped = sources;
        out.pannersWhenMono = panners;          // no position given: none expected

        // the same burst, positioned
        panners = 0; sources = 0;
        a.impactWindow = 0; a.impacts = 0;
        for (let k = 0; k < bursts; k++) a.impact(0.6, 40, 0, -10);
        out.cappedSpatial = sources;
        out.pannersWhenSpatial = panners;

        // the listener has to follow the camera, or the soundstage is nailed to
        // wherever the page happened to start
        const L = ctx.listener;
        const readL = () => L.positionX ? [L.positionX.value, L.positionY.value, L.positionZ.value]
                                        : null;
        a.setListener(11, 22, 33, 0, 0, -1, 0, 1, 0);
        out.listener = readL();

        a.on = false;
        ctx.createPanner = realPan;

        ctx.createBufferSource = realSrc;
        ctx.createOscillator = realOsc;
        return out;
      })();
    }""", [bursts])

    if not res.get("built"):
        sys.exit("audio: the graph did not build — ctx, master or bed missing")
    if res["toggleReturned"] or res["on"]:
        sys.exit(f"audio: ?audio=0 did not keep it silent "
                 f"(toggle returned {res['toggleReturned']}, on={res['on']})")
    if res["whileOff"]:
        sys.exit(f"audio: {res['whileOff']} node(s) built while sound was off — the "
                 f"silent path is meant to cost nothing")
    if res["capped"] > 5:
        sys.exit(f"audio: {bursts} impacts in one window built {res['capped']} sources. "
                 f"The cap is 5; a collapsing pile fans out without it.")
    if res["capped"] < 1:
        sys.exit(f"audio: {bursts} impacts built nothing at all, so the cap proved "
                 f"nothing. Sound was off, or impact() no longer reaches the graph.")
    if res["cappedSpatial"] > 5 or res["cappedSpatial"] < 1:
        sys.exit(f"audio: positioned impacts built {res['cappedSpatial']} sources; the "
                 f"cap must hold whether or not a position is given")
    if res["pannersWhenMono"]:
        sys.exit(f"audio: {res['pannersWhenMono']} panner(s) built for impacts with no "
                 f"position — an unpositioned sound should stay on the direct path")
    if res["pannersWhenSpatial"] != res["cappedSpatial"]:
        sys.exit(f"audio: {res['cappedSpatial']} positioned voices produced "
                 f"{res['pannersWhenSpatial']} panners — every positioned sound needs "
                 f"exactly one, or it plays from the middle regardless of where it was")
    if res["listener"] and [round(v) for v in res["listener"]] != [11, 22, 33]:
        sys.exit(f"audio: the listener did not move to where it was put "
                 f"({res['listener']}) — the soundstage will not follow the camera")
    print(f"  audio: graph builds, silent under ?audio=0, {bursts} impacts capped to "
          f"{res['capped']} voices ({res['pannersWhenSpatial']} panned when positioned, "
          f"{res['pannersWhenMono']} when not), listener follows")


def check_detail_panel(page, runs=12):
    """The detail panel, including the history rule that is invisible from the code.

    Selecting a record opens the panel and pushes one history entry. Selecting another
    must REPLACE that entry rather than push a second, because on a phone the panel is
    a full-screen takeover and Back is how it is dismissed — stepping back through
    forty records to escape is not what anyone means by that. So forty selections owe
    exactly one entry, and nothing about reading selectIndex makes that obvious enough
    to stay true through a refactor.

    The rest is content: the panel must show the record that was asked for, and the
    copy button must be absent for the presets that publish no prompt text.
    """
    res = page.evaluate("""([runs]) => {
      const A = window.__atlas;
      A.clearHighlight();
      A.setLayout('grid', true);
      const before = history.length;
      const seen = [];
      for (let k = 0; k < runs; k++) {
        const i = k * 137 % A.counts.instances;
        A.select(i);
        const p = A.panel;
        seen.push({ i, open: p.open, selected: p.selected, rid: p.rid,
                    hash: p.hash, tags: p.tags, copyShown: p.copyShown,
                    promptLen: p.prompt.length });
      }
      const afterSelects = history.length;
      A.closePanel();
      const closed = A.panel;
      return { before, afterSelects, pushed: afterSelects - before,
               closedOpen: closed.open, closedSelected: closed.selected, seen };
    }""", [runs])

    if res["pushed"] > 1:
        sys.exit(f"detail panel: {runs} selections pushed {res['pushed']} history entries. "
                 f"The panel owes one, so Back dismisses it instead of walking back "
                 f"through every record that was opened.")
    if res["closedOpen"] or res["closedSelected"] != -1:
        sys.exit(f"detail panel: still open after close "
                 f"(open={res['closedOpen']}, selected={res['closedSelected']})")

    wrong = [s for s in res["seen"] if not s["open"] or s["selected"] != s["i"]]
    if wrong:
        sys.exit(f"detail panel: did not open on the record asked for, e.g. {wrong[:3]}")
    stale = [s for s in res["seen"] if s["hash"] != "#" + s["rid"]]
    if stale:
        sys.exit(f"detail panel: the URL does not name the record shown, e.g. {stale[:3]}")
    empty = [s for s in res["seen"] if s["copyShown"] and s["promptLen"] == 0]
    if empty:
        sys.exit(f"detail panel: copy offered for a record with no prompt text, "
                 f"e.g. {empty[:3]}")
    nav = page.evaluate("""() => {
      const A = window.__atlas;
      A.clearHighlight();
      A.setLayout('grid', true);
      A.setFilter('portrait');                 // a set small enough to walk to the end
      const order = A.order();
      A.select(order[0]);
      const atStart = A.nav;
      const walked = [];
      for (let k = 0; k < 5; k++) { A.step(1); walked.push(A.panel.selected); }
      A.select(order[order.length - 1]);
      const atEnd = A.nav;
      A.closePanel(); A.clearHighlight();
      return { n: order.length, expected: order.slice(1, 6), walked, atStart, atEnd };
    }""")
    # Stepping has to follow the order tiles were laid out in, not the order records
    # happen to be stored in — otherwise "next" means something different from what
    # is on screen, which is worse than having no next at all.
    if nav["walked"] != nav["expected"]:
        sys.exit(f"detail panel: stepping did not follow the laid-out order — got "
                 f"{nav['walked']}, expected {nav['expected']}")
    if not nav["atStart"]["prevDisabled"] or nav["atStart"]["nextDisabled"]:
        sys.exit(f"detail panel: at the first record, prev should be the only one "
                 f"disabled ({nav['atStart']})")
    if nav["atEnd"]["prevDisabled"] or not nav["atEnd"]["nextDisabled"]:
        sys.exit(f"detail panel: at the last record, next should be the only one "
                 f"disabled ({nav['atEnd']})")
    if not nav["atStart"]["pos"].endswith(str(nav["n"])):
        sys.exit(f"detail panel: position reads {nav['atStart']['pos']!r} for a set of "
                 f"{nav['n']} — it should count within the filtered set")

    nprompt = sum(1 for s in res["seen"] if s["promptLen"] > 0)
    print(f"  detail panel: {len(res['seen'])} records shown correctly, "
          f"{res['pushed']} history entry for all of them "
          f"({nprompt} with prompt text), closes clean; "
          f"steps the filtered set in order, {nav['atStart']['pos']}")


def check_framing(page, modes=("grid", "sphere", "helix", "clusters")):
    """Framing an arrangement must actually fit it on screen.

    frameCamera() fits the bounding box against both FOV axes rather than using a
    bounding sphere, and the comment says why: a sphere fudge factor crops the helix
    top and bottom, which is nothing like spherical.
    Nothing checked that claim. A fit that crops looks like a framing choice rather
    than a bug, which is the kind of regression that survives.

    So: frame it, let the flight land, then project every visible tile and require it
    inside NDC. Pure maths on both sides, no baseline and no tolerance — the same
    property that makes the picking round trip machine-independent.

    A small margin is allowed past the edge because the fit adds 6% headroom and then
    shifts sideways when the detail panel is open; the check is "nothing is cropped",
    not "the fit is tight".
    """
    for mode in modes:
        res = page.evaluate("""async ([mode]) => {
          const A = window.__atlas;
          A.clearHighlight();
          A.setLayout(mode, true);
          A.frameAll();
          for (let k = 0; k < 400; k++) {
            if (!A.flying) break;
            await new Promise(r => requestAnimationFrame(r));
          }
          // project() reads camera.matrixWorldInverse, which is only refreshed when a
          // frame renders. Under reduced motion the flight ends in 1 ms, so this loop
          // can exit before any frame has run and the projection would be computed
          // against the camera's previous transform — which reads as a crop that is
          // not there. Ask for the matrix directly rather than hoping a frame landed.
          A.camera.updateMatrixWorld(true);
          const n = A.counts.instances;
          let worstX = 0, worstY = 0, tested = 0, behind = 0;
          for (let i = 0; i < n; i += 7) {
            const [x, y, z] = A.project(i);
            if (z > 1) { behind++; continue; }          // behind the camera
            tested++;
            worstX = Math.max(worstX, Math.abs(x));
            worstY = Math.max(worstY, Math.abs(y));
          }
          return { flying: A.flying, tested, behind,
                   worstX: +worstX.toFixed(3), worstY: +worstY.toFixed(3) };
        }""", [mode])
        if res["flying"]:
            sys.exit(f"framing {mode}: the flight never landed")
        if not res["tested"]:
            sys.exit(f"framing {mode}: nothing was in front of the camera to check")
        worst = max(res["worstX"], res["worstY"])
        if worst > 1.0:
            sys.exit(f"framing {mode}: the fit crops — a tile projects to {worst} in NDC, "
                     f"outside the [-1, 1] the screen shows (x {res['worstX']}, "
                     f"y {res['worstY']}). frameCamera is not fitting both FOV axes.")
        print(f"  framing {mode}: fits, worst NDC {worst} "
              f"({res['tested']} sampled, {res['behind']} behind)")


def check_picking(page, sample=240):
    """Every tile must be pickable at its own centre.

    Picking is the one subsystem no scene covers, and a signature never could: it is a
    ray test against posCur, and its output is an index rather than a colour. A tile
    can stop being clickable without a single pixel moving.

    The check is a round trip. Project a tile's centre to NDC through the camera, aim
    there, and picking has to return that tile. Both halves are pure maths, so unlike a
    rendered frame the answer is identical on every machine — no baseline, no tolerance,
    no per-machine file.

    Tiles outside the frustum are skipped rather than counted as failures; the grid is
    wider than the view and a tile that is not on screen is not expected to be pickable.
    """
    res = page.evaluate("""([sample]) => {
      const A = window.__atlas;
      A.setLayout('grid', true);
      A.park(0, 0, 96);
      const n = A.counts.instances, step = Math.max(1, Math.floor(n / sample));
      const half = A.highlight.halfSize(0);   // grid tiles are unfocused and lit: 0.5
      let tested = 0, offscreen = 0;
      const wrong = [], edgeWrong = [], gapWrong = [];

      // Aiming at a centre proves less than it looks: the ray passes ~0 from the tile,
      // so any broad-phase radius above zero accepts it and any half-extent above zero
      // contains it. The two offset probes are what actually exercise those numbers —
      // just inside the tile's own edge, and out in the gap past it.
      for (let i = 0; i < n; i += step) {
        const c = A.project(i);
        if (Math.abs(c[0]) > 0.9 || Math.abs(c[1]) > 0.9) { offscreen++; continue; }
        tested++;
        if (A.pickAt(c[0], c[1]) !== i) wrong.push([i, A.pickAt(c[0], c[1])]);

        // NDC per world unit at this depth, measured off the neighbouring tile rather
        // than derived from the projection matrix
        const scale = (A.project(i + 1)[0] - c[0]);   // one grid step = 1.5 world units
        const perUnit = Math.abs(scale) / 1.5;
        if (!isFinite(perUnit) || perUnit <= 0) continue;

        const inX = c[0] + perUnit * half * 0.80;     // inside the tile
        if (A.pickAt(inX, c[1]) !== i) edgeWrong.push([i, A.pickAt(inX, c[1])]);

        const outX = c[0] + perUnit * half * 1.60;    // past the edge, into the gap
        if (A.pickAt(outX, c[1]) === i) gapWrong.push(i);
      }
      A.pickAt(-9, -9);                       // leave no hover behind
      return { tested, offscreen, half,
               wrong: wrong.slice(0, 6), wrongCount: wrong.length,
               edgeWrong: edgeWrong.slice(0, 6), edgeWrongCount: edgeWrong.length,
               gapWrong: gapWrong.slice(0, 6), gapWrongCount: gapWrong.length };
    }""", [sample])
    if not res["tested"]:
        sys.exit("picking: every sampled tile was off screen — the check proved nothing")
    if res["wrongCount"]:
        sys.exit(f"picking: {res['wrongCount']} of {res['tested']} tiles did not pick "
                 f"themselves at their own centre, e.g. {res['wrong']}")
    # State what was seen, not why. The pairs say it better than a guess would: -1 is a
    # ray that found nothing, and i+1 is a neighbour winning a point that should have
    # been inside tile i — which happens when the half-extent grows past the midpoint
    # between tiles, the opposite cause from a ray that reaches nothing.
    if res["edgeWrongCount"]:
        sys.exit(f"picking: {res['edgeWrongCount']} of {res['tested']} tiles did not pick "
                 f"themselves just inside their own edge, e.g. {res['edgeWrong']} "
                 f"(as [aimed at, got]; -1 means nothing was hit). Suspect the broad-phase "
                 f"radius or Highlight.halfSize.")
    if res["gapWrongCount"]:
        sys.exit(f"picking: {res['gapWrongCount']} of {res['tested']} tiles were picked "
                 f"from the gap past their own edge, e.g. {res['gapWrong']}. The tile is "
                 f"claiming more area than it draws.")
    print(f"  picking: {res['tested']} tiles pick themselves at centre, inside the edge, "
          f"and not from the gap (half {res['half']}, {res['offscreen']} off screen)")


def settle_highlight(page, name, tries=400, expect_moved=True):
    """Wait for the dim/focus sweep to finish, and prove it actually ran.

    A filter is deliberately a wave — the nearest tiles change first and it spreads —
    so for the first frames the mean barely moves and any "has it stopped" test says
    yes before it has started. Waiting on the sweep's own `settled` flag avoids
    guessing: it is false from the moment something invalidates it and true only once
    a whole pass changed nothing.

    The assertion afterwards matters as much as the wait. These two scenes exist to
    execute lanes nothing else touches, so a scene that captured with dim still at 1
    and focus still at 0 would record a duplicate of grid-front and quietly claim
    coverage it does not have.
    """
    for _ in range(tries):
        h = page.evaluate("() => { const h = window.__atlas.highlight;"
                          "        return h && h.settled; }")
        if h:
            break
        page.wait_for_timeout(25)
    lanes = page.evaluate("""() => {
      const m = window.__atlas.mesh.geometry.getAttribute('aMeta');
      let dim = 0, focus = 0;
      for (let i = 0; i < m.count; i++) { dim += m.array[i*4+1]; focus += m.array[i*4+2]; }
      return { dimMean: dim / m.count, focusMax: focus };
    }""")
    if expect_moved and lanes["dimMean"] > 0.999 and lanes["focusMax"] < 1e-4:
        sys.exit(f"scene {name}: neither lane moved — dim {lanes['dimMean']:.4f}, "
                 f"focus {lanes['focusMax']:.4f}. This scene exists to exercise them.")
    print(f"  {name}: dim mean {lanes['dimMean']:.4f}, focus total {lanes['focusMax']:.4f}")


def assert_all_lit(page, name, tries=400):
    """After a filter is cleared, every tile must come back.

    This is the shape of a bug that was in the sweep from the beginning: the tile
    furthest from the view centre gets a delay of exactly `stagger`, `delay` is a
    Float32Array, and 0.30 stored as float32 is 0.30000001192 — larger than the float64
    0.30 the timer stops at. That tile never satisfies `t >= delay[i]`, so its target
    holds, nothing reports as touched, the sweep latches settled, and it stays dark
    until something else invalidates.

    One tile in 2,936 moves no luma cell past a tolerance of 3, so no signature was ever
    going to catch it. A post-condition does, and cheaply.
    """
    for _ in range(tries):
        if page.evaluate("() => { const h = window.__atlas.highlight; return h && h.settled; }"):
            break
        page.wait_for_timeout(25)
    # Two checks, because neither alone is enough. The invariant below is the one the
    # fix establishes: every delay strictly under the value the timer is guaranteed to
    # reach. Unclamped it holds only by luck — whether float32 rounding puts the
    # furthest tile's delay above or below `stagger` depends on that run's distances —
    # so this catches a violation whenever one exists rather than every run. The dark
    # tile check below catches the symptom on the runs where it does bite. Together
    # they are a good deal more than the pixels, which cannot see one tile in 2,936 at
    # all.
    inv = page.evaluate("""() => {
      const h = window.__atlas.highlight;
      if (!h.delay) return null;
      let max = 0;
      for (let i = 0; i < h.delay.length; i++) if (h.delay[i] > max) max = h.delay[i];
      return { maxDelay: max, stagger: h.stagger, t: h.t };
    }""")
    # Assert the margin, not the boundary. Unclamped, the furthest delay lands within a
    # rounding step of `stagger` and whether it is above or below depends on that run's
    # distances — so `maxDelay >= stagger` catches the bug only on the runs where the
    # float32 rounding happens to go up, which is a test that passes while broken. The
    # clamp puts it at 0.999 * stagger, three orders of magnitude clear of the rounding,
    # so a margin check separates clamped from unclamped on every run.
    if inv and inv["maxDelay"] > inv["stagger"] * 0.9995:
        sys.exit(f"scene {name}: the largest stagger delay is {inv['maxDelay']!r}, which is "
                 f"not clear of stagger {inv['stagger']!r}. The timer stops at the first "
                 f"t >= stagger, so a delay at or near stagger can never satisfy "
                 f"t >= delay and that tile strands dark. Clamp the delays below stagger.")

    dark = page.evaluate("""() => {
      const m = window.__atlas.mesh.geometry.getAttribute('aMeta');
      const out = [];
      for (let i = 0; i < m.count; i++) if (m.array[i*4+1] < 0.5) out.push(i);
      return { count: out.length, first: out.slice(0, 5) };
    }""")
    if dark["count"]:
        sys.exit(f"scene {name}: {dark['count']} tile(s) still dark after the filter was "
                 f"cleared, e.g. {dark['first']} — the sweep stranded them")
    print(f"  {name}: all tiles lit after clearing")


def settle_detail(page, tries=80, quiet=3):
    """Drive the detail cache to a steady state before the frame is read.

    "Nothing in flight" is not the same as "finished". The loader holds itself to 8
    concurrent requests and takes the rest on later elections, so it falls quiet
    between batches with most slots still empty — and a capture taken in one of those
    gaps records however many tiles happened to have landed. That is what made the
    close-up read a constant 3 against its own baseline: not noise, just two runs
    stopping at different points up the same ramp.

    So wait for the bound count to stop moving rather than for the queue to empty, and
    re-elect each time round, since election is what starts the next batch. A scene too
    far away to elect anything settles at zero on the first pass.
    """
    prev, stable = None, 0
    for _ in range(tries):
        page.evaluate("() => window.__atlas.forceDetail()")
        page.wait_for_timeout(150)
        d = page.evaluate("() => window.__atlas.detail")
        if d is None:                       # ?lod=off — nothing to settle
            return None
        if d["inFlight"] == 0 and d["bound"] == prev:
            stable += 1
            if stable >= quiet:
                return d
        else:
            stable = 0
        prev = d["bound"]
    return d


def capture(backend, scenes, timeout_s=90):
    from playwright.sync_api import sync_playwright

    port = free_port()
    httpd = serve(port)
    chrome_flags = list(CHROME_FLAGS)
    if sys.platform.startswith("linux"):
        # Only Linux needs the software Vulkan stack, and only Linux can be missing it.
        if os.path.exists(VULKAN_ICD):
            os.environ["VK_DRIVER_FILES"] = VULKAN_ICD
            chrome_flags += LINUX_VULKAN_FLAGS
        elif backend == "webgpu":
            print("  mesa-vulkan-drivers not installed — falling back to the WebGL2 backend")
            backend = "webgl"

    # physics is deliberately NOT disabled here. FLAGS.physics gates only startPhysics(),
    # so a scene that never enters physics renders identically either way — and the
    # physics scene needs the engine available. The seed is what makes that pile
    # comparable at all.
    flags = f"dust=0&audio=0&seed={SEED}"
    if backend == "webgl":
        flags += "&webgl"
    url = f"http://127.0.0.1:{port}/web/?{flags}"

    out = {}
    with sync_playwright() as pw:
        # Headed on purpose, and on every platform: a headless Chrome has no surface to
        # present to, so it answers with SwiftShader and reads back a software frame that
        # is not the thing being tested. Linux supplies the display via Xvfb.
        exe = chromium_path()
        if exe:
            print(f"  chromium: {exe}")
        browser = pw.chromium.launch(headless=False, args=chrome_flags,
                                     executable_path=exe or None)
        page = browser.new_page(viewport={"width": 1280, "height": 800},
                                reduced_motion="reduce")   # morphs land instantly
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="load", timeout=timeout_s * 1000)
        page.wait_for_function("() => window.__atlas && window.__atlas.counts.instances > 0",
                               timeout=timeout_s * 1000)
        info = page.evaluate("() => ({...window.__atlas.counts, ...window.__atlas.flags})")

        # What was asked for is not always what runs: a headless Chrome, a blocklisted
        # GPU or a missing driver all degrade quietly, and a baseline captured off
        # SwiftShader looks fine until it is compared against one that is not. Ask the
        # renderer what it actually bound, and refuse rather than record the wrong thing.
        actual = page.evaluate("""async () => {
          const b = window.__atlas.renderer.backend;
          let adapter = null;
          if (navigator.gpu) {
            const a = await navigator.gpu.requestAdapter();
            const i = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null));
            if (i) adapter = [i.vendor, i.architecture].filter(Boolean).join('/');
          }
          return { webgpu: !!b.isWebGPUBackend, adapter };
        }""")
        ran = "webgpu" if actual["webgpu"] else "webgl"
        adapter = actual["adapter"] or "n/a"
        # Only meaningful under WebGPU. navigator.gpu answers on a WebGL run too, but
        # three never bound that adapter, so printing it there would name the wrong device.
        shown = f" adapter={adapter}" if ran == "webgpu" else ""
        print(f"  backend={ran}{shown} "
              f"instances={info['instances']} active={info['active']}")
        if ran != backend:
            browser.close(); httpd.shutdown()
            sys.exit(f"asked for the {backend} backend, got {ran} — refusing to use the frame")
        if ran == "webgpu" and "swiftshader" in adapter.lower():
            browser.close(); httpd.shutdown()
            sys.exit("WebGPU resolved to SwiftShader, a software adapter — refusing to "
                     "use the frame. This means Chrome found no usable GPU.")

        check_picking(page)

        for name, mode, (x, y, z), steps, setup in scenes:
            # Highlight state is global and outlives a scene, so reset before each one.
            # Without this the filtered scene dims everything the scenes after it draw.
            page.evaluate("() => window.__atlas.clearHighlight()")
            if steps is None:
                page.evaluate("([m]) => window.__atlas.setLayout(m, true)", [mode])
                page.wait_for_function("() => window.__atlas.settled",
                                       timeout=timeout_s * 1000)
            else:
                # Loads a ~3 MB wasm bundle on first use, so give it the full timeout.
                res = page.evaluate("async ([n]) => await window.__atlas.physics(n)",
                                    [steps])
                if not res:
                    browser.close(); httpd.shutdown()
                    sys.exit(f"scene {name}: physics refused to start")
                if not res["seeded"]:
                    browser.close(); httpd.shutdown()
                    sys.exit(f"scene {name}: physics ran unseeded — the pile is not "
                             "reproducible and the baseline would be noise")
                print(f"  {name}: {res['bodies']} bodies, {res['steps']} steps "
                      f"{res['from']} -> {res['to']}")
            page.evaluate("([x,y,z]) => window.__atlas.park(x,y,z)", [x, y, z])

            if setup:
                # The page is opened with prefers-reduced-motion so morphs land
                # instantly, and that also flattens the filter stagger to all-zero
                # delays — which is the one code path these scenes exist to cover.
                # Turn it back on for them only.
                page.evaluate("() => { window.__atlas.highlight.reduced = false; }")
                if "sort" in setup:
                    page.evaluate("([k]) => window.__atlas.setSort(k)", [setup["sort"]])
                if "filter" in setup:
                    shown = page.evaluate("([q]) => window.__atlas.setFilter(q)",
                                          [setup["filter"]])
                    print(f"  {name}: filter {setup['filter']!r} -> {shown}")
                if "hover" in setup:
                    page.evaluate("([i]) => window.__atlas.hover(i)", [setup["hover"]])
                if "sort" not in setup:
                    settle_highlight(page, name, expect_moved="clear" not in setup)
                if setup.get("clear"):
                    page.evaluate("() => window.__atlas.clearHighlight()")
                    assert_all_lit(page, name)

            d = settle_detail(page)
            if steps is None and mode == "grid" and name.startswith("detail"):
                if not d or d["bound"] == 0:
                    browser.close(); httpd.shutdown()
                    sys.exit(f"scene {name}: the detail cache bound nothing — this scene "
                             "exists to exercise the LOD path and did not")
                print(f"  {name}: {d['bound']}/{d['slots']} detail tiles bound")
            page.wait_for_timeout(250)          # let one frame with the new camera land
            out[name] = page.evaluate("async () => await window.__atlas.signature(512, 16)")

        # After the captures, not before: frameCamera ties fog density to the framed
        # distance, so running it first leaves every scene rendering through somebody
        # else's fog. That read as maxD 173 across the board — the scenes were fine and
        # the check had moved the weather.
        check_framing(page)
        check_detail_panel(page)
        check_audio(page)
        check_sort(page)
        check_labels(page)
        check_url(browser, url, {"width": 1280, "height": 800})
        browser.close()
    httpd.shutdown()
    if errors:
        print("  page errors:")
        for e in errors[:5]:
            print("   ", e[:160])
    return out, backend, errors


def compare(base, cur, tol):
    """Per-scene max and mean absolute difference across the 256 cells."""
    rows, worst = [], 0
    for name in sorted(set(base) | set(cur)):
        if name not in base or name not in cur:
            rows.append((name, None, None, "missing"))
            worst = max(worst, tol + 1)
            continue
        a, b = base[name], cur[name]
        d = [abs(x - y) for x, y in zip(a, b)]
        mx, mean = max(d), sum(d) / len(d)
        worst = max(worst, mx)
        rows.append((name, mx, mean, "ok" if mx <= tol else "CHANGED"))
    return rows, worst


def audit_baseline(path):
    """Say whether `path` is a baseline this build can be checked against.

    Returns None when it is, or a one-line reason when it is not. The scene set is part
    of the contract, not a detail: SCENES grows whenever a subsystem needs covering, and
    a baseline captured before that growth makes compare() report the new scenes as
    MISSING on every single run. That is a stale baseline, not a regression, and the two
    have to be told apart before a red build can mean anything — so this answers the
    question without launching a browser, cheaply enough for CI to ask first and decide
    whether to check or to re-capture.

    It takes the backend at face value, since it does not render: the caller that cares
    (CI) passes --backend explicitly, and capture()'s driver-missing downgrade cannot
    apply to a run that never starts one.
    """
    rel = os.path.relpath(path, ROOT)
    if not os.path.exists(path):
        return f"no baseline at {rel}"
    try:
        base = json.load(open(path))
    except (ValueError, OSError) as e:
        return f"{rel} is not readable as a baseline: {e}"
    have = set(base.get("scenes") or {})
    want = {name for name, _mode, _cam, _steps in SCENES}
    missing, extra = sorted(want - have), sorted(have - want)
    if missing or extra:
        why = []
        if missing:
            why.append("does not cover " + ", ".join(missing))
        if extra:
            why.append("covers scenes no longer defined: " + ", ".join(extra))
        return (f"{rel} is stale — it has {len(have)} scene(s) against the {len(want)} "
                f"this harness defines, and {'; '.join(why)}")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="write the baseline instead of checking")
    ap.add_argument("--backend", choices=["webgpu", "webgl"], default="webgpu")
    ap.add_argument("--tag", default=None,
                    help="name this machine, e.g. --tag mbp. Signatures from different "
                         "GPUs are not comparable, so each machine keeps its own baseline.")
    ap.add_argument("--baseline", default=None, help="explicit baseline path, overriding --tag")
    ap.add_argument("--audit-baseline", action="store_true",
                    help="render nothing: just report whether the baseline this run would "
                         "check against exists and covers today's scene set. Exits 0 when it "
                         "does, 1 with the reason when it does not, so a build can tell a "
                         "stale baseline from a real regression before it renders anything.")
    ap.add_argument("--tolerance", type=int, default=3,
                    help="max per-cell luma difference (0-255) still considered unchanged. "
                         "Run-to-run noise on one machine is 0, so this is deliberately tight; "
                         "a real 1.3%% layout shift reads 14. Do not raise it to make a failure "
                         "go away — re-capture instead, and only for a browser or driver change.")
    a = ap.parse_args()

    if a.audit_baseline:
        path = a.baseline or baseline_path(a.backend, a.tag)
        why = audit_baseline(path)
        if why:
            sys.exit(why)
        print(f"{os.path.relpath(path, ROOT)} covers all {len(SCENES)} scenes")
        return

    print(f"atlas visual check ({'capturing baseline' if a.update else 'checking'})")
    cur, backend, errors = capture(a.backend, SCENES)
    if errors:
        sys.exit("page raised errors — refusing to trust the capture")
    if len(cur) != len(SCENES):
        sys.exit(f"captured {len(cur)} of {len(SCENES)} scenes")

    path = a.baseline or baseline_path(backend, a.tag)
    if a.update:
        os.makedirs(BASELINE_DIR, exist_ok=True)
        json.dump({"backend": backend, "tag": a.tag, "cells": 16, "size": 512,
                   "instances": None, "scenes": cur}, open(path, "w"), indent=1)
        print(f"\nbaseline written -> {os.path.relpath(path, ROOT)} ({len(cur)} scenes)")
        return

    if not os.path.exists(path):
        have = sorted(f for f in os.listdir(BASELINE_DIR) if f.startswith("baseline."))
        sys.exit(f"no baseline at {os.path.relpath(path, ROOT)} — run with --update first"
                 + (f"\navailable: {', '.join(have)}" if have else ""))
    base = json.load(open(path))
    print(f"  baseline: {os.path.relpath(path, ROOT)}")
    if base.get("backend") != backend:
        print(f"  note: baseline captured on {base.get('backend')}, checking on {backend} — "
              f"these are not comparable; capture one for this backend instead")
    rows, worst = compare(base["scenes"], cur, a.tolerance)

    print(f"\n  {'scene':14s} {'maxΔ':>6s} {'meanΔ':>7s}")
    bad = 0
    for name, mx, mean, verdict in rows:
        if verdict == "missing":
            print(f"  {name:14s} {'—':>6s} {'—':>7s}  MISSING"); bad += 1
        else:
            print(f"  {name:14s} {mx:6d} {mean:7.2f}  {verdict}")
            bad += verdict == "CHANGED"
    print(f"\ntolerance {a.tolerance} · worst {worst}")
    if bad:
        sys.exit(f"{bad} scene(s) changed — inspect before accepting")
    print("all scenes match the baseline")


if __name__ == "__main__":
    main()
