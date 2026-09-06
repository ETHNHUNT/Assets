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
    ("grid-front",   "grid",     (0, 0, 96),    None),
    ("grid-angled",  "grid",     (60, 34, 70),  None),
    ("sphere",       "sphere",   (0, 10, 120),  None),
    ("helix",        "helix",    (0, 0, 130),   None),
    ("towers",       "towers",   (0, 20, 150),  None),
    ("by-model",     "model",    (0, 20, 150),  None),
    ("physics-pile", "physics",  (0, 6, 120),   240),
    # Close enough to trip the detail cache. A tile has to cover DETAIL_MIN_PX (74px)
    # before it is worth a full-res load, which works out at roughly 8 units — every
    # other scene here sits at 96 or further, so without this one the LOD path, and the
    # aToPos.w / aMeta writes it owns, are never executed at all.
    ("detail-closeup", "grid",   (0, 0, 7),     None),
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

        for name, mode, (x, y, z), steps in scenes:
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
                print(f"  {name}: {res['bodies']} bodies, {res['steps']} steps")
            page.evaluate("([x,y,z]) => window.__atlas.park(x,y,z)", [x, y, z])

            d = settle_detail(page)
            if steps is None and mode == "grid" and name.startswith("detail"):
                if not d or d["bound"] == 0:
                    browser.close(); httpd.shutdown()
                    sys.exit(f"scene {name}: the detail cache bound nothing — this scene "
                             "exists to exercise the LOD path and did not")
                print(f"  {name}: {d['bound']}/{d['slots']} detail tiles bound")
            page.wait_for_timeout(250)          # let one frame with the new camera land
            out[name] = page.evaluate("async () => await window.__atlas.signature(512, 16)")
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="write the baseline instead of checking")
    ap.add_argument("--backend", choices=["webgpu", "webgl"], default="webgpu")
    ap.add_argument("--tag", default=None,
                    help="name this machine, e.g. --tag mbp. Signatures from different "
                         "GPUs are not comparable, so each machine keeps its own baseline.")
    ap.add_argument("--baseline", default=None, help="explicit baseline path, overriding --tag")
    ap.add_argument("--tolerance", type=int, default=3,
                    help="max per-cell luma difference (0-255) still considered unchanged. "
                         "Run-to-run noise on one machine is 0, so this is deliberately tight; "
                         "a real 1.3%% layout shift reads 14. Do not raise it to make a failure "
                         "go away — re-capture instead, and only for a browser or driver change.")
    a = ap.parse_args()

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
