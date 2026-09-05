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

Measured on this workload: repeat runs on one machine differ by 0, and nudging the grid
pitch by 1.3% reads 14. So the baseline is sensitive to what it needs to be sensitive to
— but it is specific to a backend and a machine. Re-capture after changing browser,
driver or backend; never widen the tolerance to silence a diff you have not explained.

Running WebGPU headlessly needs the recipe from README section 7 — headed under Xvfb,
software Vulkan pinned, `--disable-vulkan-surface` — which this sets up itself. Without
mesa-vulkan-drivers installed it falls back to the WebGL2 backend and says so.
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
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-vulkan-surface",
    "--ignore-gpu-blocklist", "--disable-gpu-driver-bug-workarounds",
    "--disable-gpu-watchdog", "--no-sandbox",
]

# Each scene is (name, layout mode, camera position). The camera is parked explicitly
# because OrbitControls damping never quite settles, and a drifting camera would make
# every signature differ from the last.
SCENES = [
    ("grid-front",   "grid",     (0, 0, 96)),
    ("grid-angled",  "grid",     (60, 34, 70)),
    ("sphere",       "sphere",   (0, 10, 120)),
    ("helix",        "helix",    (0, 0, 130)),
    ("towers",       "towers",   (0, 20, 150)),
    ("by-model",     "model",    (0, 20, 150)),
]


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


def capture(backend, scenes, timeout_s=90):
    from playwright.sync_api import sync_playwright

    port = free_port()
    httpd = serve(port)
    env_icd = os.path.exists(VULKAN_ICD)
    if env_icd:
        os.environ["VK_DRIVER_FILES"] = VULKAN_ICD
    elif backend == "webgpu":
        print("  mesa-vulkan-drivers not installed — falling back to the WebGL2 backend")
        backend = "webgl"

    flags = "dust=0&audio=0&physics=0"
    if backend == "webgl":
        flags += "&webgl"
    url = f"http://127.0.0.1:{port}/web/?{flags}"

    out = {}
    with sync_playwright() as pw:
        # headed under Xvfb: a headless swapchain reads back blank (README section 7)
        exe = chromium_path()
        if exe:
            print(f"  chromium: {exe}")
        browser = pw.chromium.launch(headless=False, args=CHROME_FLAGS,
                                     executable_path=exe or None)
        page = browser.new_page(viewport={"width": 1280, "height": 800},
                                reduced_motion="reduce")   # morphs land instantly
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="load", timeout=timeout_s * 1000)
        page.wait_for_function("() => window.__atlas && window.__atlas.counts.instances > 0",
                               timeout=timeout_s * 1000)
        info = page.evaluate("() => ({...window.__atlas.counts, ...window.__atlas.flags})")
        print(f"  backend={backend} instances={info['instances']} active={info['active']}")

        for name, mode, (x, y, z) in scenes:
            page.evaluate("([m]) => window.__atlas.setLayout(m, true)", [mode])
            page.wait_for_function("() => window.__atlas.settled", timeout=timeout_s * 1000)
            page.evaluate("([x,y,z]) => window.__atlas.park(x,y,z)", [x, y, z])
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
