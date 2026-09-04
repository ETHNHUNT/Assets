import json, re, sys, collections, unicodedata
sys.path.insert(0, '.')
from prose import looks_like_prompt, classify

def _iter_rows():
    with open("raw_rows.jsonl", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)

rows = list(_iter_rows())

# ---------- model normalisation ----------
MODEL_MAP = {
    "text2image_soul_v2": ("Higgsfield Soul 2.0", "Image"),
    "text2image_soul": ("Higgsfield Soul", "Image"),
    "kling3_0": ("Kling 3.0", "Video"),
    "kling_3_0": ("Kling 3.0", "Video"),
    "seedance_2_5": ("Seedance 2.5", "Video"),
    "seedance_2_0": ("Seedance 2.0", "Video"),
    "wan2_5_video": ("Wan 2.5", "Video"),
    "viral_hub_video": ("Viral Preset (Higgsfield)", "Video"),
    "mixed_media": ("Mixed Media", "Mixed"),
    "minimax_hailuo": ("MiniMax Hailuo", "Video"),
    "minimax": ("MiniMax", "Video"),
    "minimax-2.3": ("MiniMax 2.3", "Video"),
    "minimax-2.3-fast": ("MiniMax 2.3 Fast", "Video"),
    "sora2": ("Sora 2", "Video"),
    "veo3": ("Veo 3", "Video"),
    "gpt": ("GPT Image", "Image"),
    "gpt-image": ("GPT Image", "Image"),
    "gpt_image": ("GPT Image", "Image"),
    "gpt-image-2": ("GPT Image 2", "Image"),
    "gpt_image_2": ("GPT Image 2", "Image"),
    "flux": ("FLUX", "Image"),
    "flux-2": ("FLUX 2", "Image"),
    "flux_2": ("FLUX 2", "Image"),
    "flux-2-pro": ("FLUX 2 Pro", "Image"),
    "flux-2-max": ("FLUX 2 Max", "Image"),
    "grok-imagine": ("Grok Imagine", "Image"),
    "grok_imagine": ("Grok Imagine", "Image"),
    "higgsfield_soul": ("Higgsfield Soul", "Image"),
    "nano-banana": ("Nano Banana", "Image"),
    "nano_banana": ("Nano Banana", "Image"),
    "kling-o1": ("Kling O1", "Image"),
    "sora2_video": ("Sora 2", "Video"),
    "soul_cinematic": ("Higgsfield Soul (Cinematic)", "Image"),
    "seedance_2_0": ("Seedance 2.0", "Video"),
    "seedance_2_5": ("Seedance 2.5", "Video"),
    "nano-banana-pro": ("Nano Banana Pro", "Image"),
    "nano_banana_pro": ("Nano Banana Pro", "Image"),
    "sora_2": ("Sora 2", "Video"),
    "veo3_video": ("Veo 3", "Video"),
    "wan_2_5": ("Wan 2.5", "Video"),
}

def norm_model(m):
    if not m:
        return None, None
    k = str(m).strip()
    if k in MODEL_MAP:
        return MODEL_MAP[k]
    kl = k.lower().replace(" ", "_")
    if kl in MODEL_MAP:
        return MODEL_MAP[kl]
    return k, None

# ---------- model inference from source URL ----------
URL_MODEL = [
    ("seedance-2-5", "Seedance 2.5"), ("seedance-2.5", "Seedance 2.5"),
    ("seedance4k", "Seedance 2.0 4K"), ("seedance-4k", "Seedance 2.0 4K"),
    ("seedance-2-0", "Seedance 2.0"), ("seedance-2.0", "Seedance 2.0"), ("seedance", "Seedance"),
    ("sora-2", "Sora 2"), ("sora2", "Sora 2"),
    ("nano-banana-pro", "Nano Banana Pro"), ("nano-banana", "Nano Banana"),
    ("kling-3", "Kling 3.0"), ("kling-30", "Kling 3.0"), ("kling3", "Kling 3.0"),
    ("veo3.1", "Veo 3.1"), ("veo3", "Veo 3"),
    ("wan-2.6", "Wan 2.6"), ("wan-animate", "Wan Animate"), ("wan-2-5", "Wan 2.5"),
    ("flux-2", "FLUX 2"), ("flux2", "FLUX 2"), ("flux-max", "FLUX Max"),
    ("grok-imagine-1.5", "Grok Imagine 1.5"), ("grok-imagine", "Grok Imagine"),
    ("seedream-5.0-pro", "Seedream 5.0 Pro"), ("seedream-5.0", "Seedream 5.0"),
    ("recraft-v4", "Recraft V4"), ("gemini-omni", "Gemini Omni"),
    ("minimax", "MiniMax"), ("z-image", "Z-Image"),
    ("soul", "Higgsfield Soul"), ("cinema-studio", "Cinema Studio"),
    ("marketing-studio", "Marketing Studio"),
]

def model_from_url(url):
    u = (url or "").lower()
    for frag, name in URL_MODEL:
        if frag in u:
            return name
    return None

# ---------- tool type ----------
def tool_type(r):
    src = r.get("extraction_source")
    sec = (r.get("site_section") or "").lower()
    mdl = (r.get("model_or_effect") or "")
    layer = r.get("asset_layer")
    if src == "prompt_bank":
        return "Camera Movement Prompt"
    is_preset = r.get("record_type") == "preset_effect"
    if sec == "motion":
        return "Motion Effect Preset" if is_preset else "Motion Effect Prompt"
    if sec == "viral-presets":
        return "Viral Preset" if is_preset else "Viral Preset Prompt"
    if sec == "mixed-media-presets":
        return "Mixed Media Preset" if is_preset else "Mixed Media Prompt"
    if src == "flat_payload":
        m, kind = norm_model(r.get("recreate_model") or mdl)
        if (r.get("mode") or "") == "image" or kind == "Image":
            return "Image Generation"
        if (r.get("mode") or "") in ("video", "scene") or kind == "Video":
            return "Video Generation"
        return "Lesson / Course Prompt"
    if layer == "Image":
        return "Image Generation"
    if layer == "Video":
        return "Video Generation"
    m, kind = norm_model(mdl)
    if kind == "Image":
        return "Image Generation"
    if kind == "Video":
        return "Video Generation"
    tp = (r.get("target_path") or "")
    if "audio" in tp or sec.startswith("audio"):
        return "Audio / Voice"
    if "marketing" in tp or "marketing" in sec:
        return "Marketing / Ad Generation"
    if "lipsync" in tp:
        return "Lipsync / Avatar"
    if "cinema" in tp or "cinema" in sec:
        return "Cinema Studio"
    if sec in ("academy", "blog", "creator-hub"):
        return "Editorial / Tutorial Prompt"
    return "Video Generation"

# ---------- style ----------
STYLES = [
    ("Cinematic / Film", ["cinematic", "film still", "anamorphic", "35mm", "16mm", "film grain",
                          "blockbuster", "movie", "widescreen", "letterbox", "colour grade", "color grade"]),
    ("Photorealistic", ["photorealistic", "hyperrealistic", "ultra-realistic", "photo-real",
                        "true-to-life", "lifelike", "realism"]),
    ("Anime / Cartoon", ["anime", "manga", "cartoon", "cel-shaded", "cel shaded", "toon", "studio ghibli"]),
    ("3D / CGI Render", ["3d render", "3d animation", "cgi", "octane", "blender", "isometric",
                         "claymation", "stop motion", "pixar"]),
    ("UGC / Handheld", ["ugc", "iphone", "selfie", "handheld", "vlog", "phone camera", "front camera",
                        "unfiltered realism", "raw phone"]),
    ("Retro / VHS / Analog", ["vhs", "retro", "y2k", "1990s", "1980s", "90s", "80s", "grainy tape",
                              "camcorder", "super 8", "polaroid", "vintage"]),
    ("Glitch / Experimental", ["datamosh", "glitch", "psychedelic", "distortion", "kaleidoscope",
                               "trippy", "acid", "vaporwave", "surreal"]),
    ("Fashion / Editorial", ["editorial", "lookbook", "runway", "vogue", "fashion", "high-fashion",
                             "campaign", "magazine"]),
    ("Product / Commercial", ["commercial", "advert", "product shot", "packshot", "brand film",
                              "ad ", "billboard", "promo"]),
    ("Documentary", ["documentary", "reportage", "photojournalis", "candid", "observational"]),
    ("Fantasy / Sci-Fi", ["fantasy", "sci-fi", "science fiction", "cyberpunk", "dystopian", "mythical",
                          "dragon", "kaiju", "alien", "post-apocalyptic", "medieval"]),
    ("Horror / Thriller", ["horror", "thriller", "eerie", "sinister", "creepy", "nightmare", "found footage"]),
    ("Noir / Moody", ["noir", "low-key", "moody", "chiaroscuro", "brooding", "melancholic", "somber"]),
    ("Aerial / Drone", ["drone", "aerial", "bird's eye", "birds eye", "fpv", "overhead flight"]),
]

def styles_of(t):
    tl = t.lower()
    out = [name for name, kws in STYLES if any(k in tl for k in kws)]
    return out

# ---------- subject ----------
SUBJECTS = [
    ("People / Portrait", ["woman", "man ", "girl", "boy", "person", "man,", "man.", "male", "female",
                           "portrait", "subject", "model ", "face", "she ", "he ", "people", "crowd",
                           "dancer", "athlete", "child", "couple"]),
    ("Animals / Creatures", ["animal", "dog", "cat ", "horse", "bird", "falcon", "lion", "tiger",
                             "wolf", "dragon", "creature", "fish", "insect", "monster", "kaiju"]),
    ("Vehicles / Transport", ["car ", "vehicle", "motorcycle", "truck", "train", "aircraft", "plane",
                              "boat", "ship", "helicopter", "bike", "spaceship"]),
    ("Landscape / Nature", ["landscape", "mountain", "forest", "ocean", "sea ", "beach", "desert",
                            "sky", "sunset", "sunrise", "river", "waterfall", "glacier", "field",
                            "valley", "canyon", "jungle"]),
    ("Architecture / Interior", ["building", "interior", "room", "kitchen", "apartment", "house",
                                 "office", "corridor", "architecture", "skyscraper", "street",
                                 "city", "urban", "hotel", "studio "]),
    ("Food / Drink", ["food", "drink", "coffee", "cocktail", "meal", "dish", "restaurant", "bottle",
                      "juice", "dessert", "honey", "water"]),
    ("Product / Object", ["product", "bottle", "package", "device", "phone", "watch", "shoe",
                          "sneaker", "bag", "cosmetic", "perfume", "lamp", "object"]),
    ("Abstract / Texture", ["abstract", "texture", "pattern", "gradient", "particle", "smoke",
                            "liquid", "fractal", "geometry"]),
    ("Text / Logo / Graphic", ["logo", "typography", "text ", "lettering", "poster", "banner",
                               "title card", "graphic"]),
]

def subjects_of(t):
    tl = " " + t.lower() + " "
    return [name for name, kws in SUBJECTS if any(k in tl for k in kws)]

# ---------- normalise / dedupe ----------
def norm_key(t):
    t = unicodedata.normalize("NFKC", t or "")
    t = re.sub(r'\s+', ' ', t).strip().lower()
    t = re.sub(r'[^a-z0-9 ]+', '', t)
    return t[:400]

JUNK = re.compile(r'^(sample by id of|interface with options|screenshot|a screenshot|ui screenshot|'
                  r'the image shows where)', re.I)
UIISH = re.compile(r'(interface|toggle|dropdown|sidebar|click here|navigation bar)', re.I)

# page-frequency for boilerplate detection (figure captions)
pagecount = collections.defaultdict(set)
for r in rows:
    if r.get("prompt"):
        pagecount[norm_key(r["prompt"])].add(r.get("source_url"))

clean = []
for r in rows:
    if r["record_type"] == "preset_effect":
        clean.append(r); continue
    t = (r.get("prompt") or "").strip()
    if not t:
        continue
    k = norm_key(t)
    w = len(t.split())
    src = r["extraction_source"]
    if JUNK.search(t):
        continue
    if src == "figure_caption":
        if len(pagecount[k]) > 3 or w < 8:
            continue
        if (' — ' in t and w < 25) or (' - ' in t and w < 18):
            continue
        if UIISH.search(t) and w < 30:
            continue
    # structured sources label the field as a prompt, so trust short ones;
    # inferred sources still need enough text to be worth keeping
    if w < (4 if src in ("job_payload", "flat_payload", "prompt_bank", "recreate_link") else 6):
        continue
    # confidence
    if src in ("job_payload", "flat_payload", "recreate_link", "prompt_bank"):
        conf = "High"
    elif looks_like_prompt(t) and classify(t) == "prompt":
        conf = "High"
    elif w >= 20:
        conf = "Medium"
    else:
        conf = "Low"
    r["_conf"] = conf
    clean.append(r)

# dedupe: keep richest record per normalised prompt
best = {}
order = {"job_payload": 0, "flat_payload": 0, "prompt_bank": 1, "recreate_link": 2,
         "figure_caption": 3, "article_body": 4, "catalog_page": 5}
for r in clean:
    if r["record_type"] == "preset_effect":
        key = ("preset", (r.get("name") or "").lower(), r.get("model_or_effect"))
    else:
        key = ("prompt", norm_key(r["prompt"]))
    cur = best.get(key)
    if cur is None:
        best[key] = r; continue
    def score(x):
        return (-order.get(x["extraction_source"], 9),
                len([v for v in x.values() if v]),
                len(x.get("prompt") or ""))
    if score(r) > score(cur):
        # merge non-empty fields from cur
        for kk, vv in cur.items():
            if vv and not r.get(kk):
                r[kk] = vv
        best[key] = r
    else:
        for kk, vv in r.items():
            if vv and not cur.get(kk):
                cur[kk] = vv

final = []
for r in best.values():
    text = r.get("prompt") or ""
    model_raw = r.get("model_or_effect")
    model, kind = norm_model(model_raw)
    if not model:
        model = model_from_url(r.get("source_url"))
    basis = text if text else ((r.get("name") or "") + " " + (r.get("description") or ""))
    rec = {
        "record_type": "Prompt" if r["record_type"] == "prompt" else "Preset / Effect",
        "name": r.get("name"),
        "prompt_text": text or None,
        "description": r.get("description"),
        "model_or_effect": model,
        "tool_type": tool_type(r),
        "generation_style": "; ".join(styles_of(basis)) or None,
        "visual_subject": "; ".join(subjects_of(basis)) or None,
        "category": r.get("category"),
        "preset_name": r.get("preset_name"),
        "aspect_ratio": r.get("aspect_ratio"),
        "duration_sec": r.get("duration"),
        "quality": r.get("quality"),
        "badges": r.get("badges"),
        "media_url": r.get("media_url"),
        "full_res_url": (r.get("full_res_url") or r.get("media_url")
                          or r.get("poster_url")),
        "poster_url": r.get("poster_url"),
        "asset_type": r.get("asset_type"),
        "media_pairing": (r.get("media_pairing")
                          if (r.get("full_res_url") or r.get("media_url") or r.get("poster_url"))
                          else None),
        "extra_assets": r.get("extra_assets") or [],
        "width": r.get("width"),
        "height": r.get("height"),
        "recreate_model": r.get("recreate_model"),
        "lesson_title": r.get("lesson_title"),
        "timestamp_in_lesson": r.get("start_seconds"),
        "source_url": r.get("source_url"),
        "site_section": r.get("site_section"),
        "extraction_source": r.get("extraction_source"),
        "confidence": r.get("_conf") or "High",
        "word_count": len(text.split()) if text else None,
        "char_count": len(text) if text else None,
    }
    final.append(rec)

MARKETING = re.compile(
    r'(higgsfield\s+(blender|plugin|academy|supercomputer)|^learn how to|in action\.?\s*example|'
    r'lock your style once|^bring \w+, |^make videos for|subscribers and millions|'
    r'^explore |^discover |^turn your |^generate any |^create your |^predict how)', re.I)
final = [r for r in final
         if not (r["confidence"] == "Low" and r["prompt_text"]
                 and MARKETING.search(r["prompt_text"]))]

final.sort(key=lambda x: (x["record_type"], x["tool_type"], -(x["char_count"] or 0)))
json.dump(final, open("dataset.json", "w"), ensure_ascii=False, indent=1)
print("FINAL RECORDS:", len(final))
print("by record_type:", dict(collections.Counter(r["record_type"] for r in final)))
print("by tool_type:", dict(collections.Counter(r["tool_type"] for r in final)))
print("by confidence:", dict(collections.Counter(r["confidence"] for r in final)))
print("by model:", collections.Counter(r["model_or_effect"] for r in final).most_common(12))
