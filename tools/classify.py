"""Shared classifiers: model names, tool type, generation style, visual subject.

Split out of clean.py so anything that adds records to the dataset labels them the
same way the crawl pipeline does. clean.py imports these; importing clean.py itself
would run the whole build, which is why this module exists.
"""
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
    "imagegen_2_0": ("GPT Image 2", "Image"),
    "marketing_studio_video": ("Marketing Studio", "Video"),
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
