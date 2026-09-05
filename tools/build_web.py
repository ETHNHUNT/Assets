"""Pack the committed thumbnails into texture atlases and emit the record index
that web/ (the 3D gallery) loads.

One InstancedMesh draws every tile in a single draw call, which means every
thumbnail has to live in one texture. Cells are square and images are
centre-cropped to fill them: the thumbnails run from 0.50 to 5.82 aspect, and a
uniform grid reads far better than a ragged one.

    python3 tools/build_web.py              # both tiers
    python3 tools/build_web.py --tier high  # just the 64px atlas

Outputs (all under web/data/, none of them committed by hand):
    atlas-64.webp   4096x4096, 64px cells  — desktop
    atlas-32.webp   2048x2048, 32px cells  — mobile / low tier
    records.json    one entry per paired record, in atlas cell order
"""
import json, os, sys, math, argparse
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

DATASET = os.path.join(ROOT, "data", "higgsfield_prompt_dataset.json")
THUMBS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "web", "data")

TIERS = {"high": (64, 4096), "low": (32, 2048)}


def cover(im, n):
    """Centre-crop to square, then resize to n x n."""
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    return im.resize((n, n), Image.LANCZOS)


def build_atlas(records, tile, side, path):
    per_row = side // tile
    cap = per_row * per_row
    if len(records) > cap:
        sys.exit(f"{len(records)} tiles will not fit {per_row}x{per_row} cells in {path}")
    atlas = Image.new("RGB", (side, side), (10, 12, 16))
    ok = 0
    for i, r in enumerate(records):
        fp = os.path.join(THUMBS, r["thumb_path"])
        try:
            with Image.open(fp) as im:
                atlas.paste(cover(im.convert("RGB"), tile),
                            ((i % per_row) * tile, (i // per_row) * tile))
            ok += 1
        except Exception as e:
            print(f"  skip {r['record_id']}: {type(e).__name__}", file=sys.stderr)
    atlas.save(path, "WEBP", quality=82, method=5)
    print(f"  {os.path.basename(path)}: {ok}/{len(records)} tiles, "
          f"{per_row}x{per_row} cells of {tile}px, {os.path.getsize(path)/1048576:.1f} MB")
    return per_row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=list(TIERS) + ["both"], default="both")
    a = ap.parse_args()

    import assets as A
    d = json.load(open(DATASET, encoding="utf-8"))
    recs = [r for r in d if r.get("thumb_path")]

    # Group by tool type then model, so neighbouring atlas cells are related.
    # Cell order is also the default grid order, and a grid that drifts through
    # related work reads as intentional rather than shuffled.
    recs.sort(key=lambda r: ((r.get("tool_type") or "~"), (r.get("model_or_effect") or "~"),
                             -(r.get("word_count") or 0)))
    print(f"{len(recs)} paired records")

    os.makedirs(OUT, exist_ok=True)
    grids = {}
    for name, (tile, side) in TIERS.items():
        if a.tier in (name, "both"):
            grids[name] = build_atlas(recs, tile, side,
                                      os.path.join(OUT, f"atlas-{tile}.webp"))

    def split(v):
        return [x for x in (v or "").split("; ") if x]

    out = []
    for i, r in enumerate(recs):
        out.append({
            "i": i,
            "id": r.get("record_id") or A.record_id(r),
            "n": r.get("name") or "",
            "p": r.get("prompt_text") or r.get("description") or "",
            "t": r.get("tool_type") or "",
            "m": r.get("model_or_effect") or "",
            "s": split(r.get("generation_style")),
            "v": split(r.get("visual_subject")),
            "k": r.get("asset_type") or "",
            "g": r.get("media_pairing") or "",
            "w": r.get("word_count") or 0,
            "c": r.get("confidence") or "",
            "a": r.get("asset_count") or 0,
            "u": r.get("source_url") or "",
            "f": r.get("full_res_url") or "",
            "th": r.get("thumb_path") or "",
        })

    meta = {
        "count": len(out),
        "atlas": {k: {"tile": TIERS[k][0], "side": TIERS[k][1], "perRow": v}
                  for k, v in grids.items()},
        "records": out,
    }
    p = os.path.join(OUT, "records.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  records.json: {len(out)} records, {os.path.getsize(p)/1048576:.1f} MB")


if __name__ == "__main__":
    main()
