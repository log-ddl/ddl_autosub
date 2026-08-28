"""Guard against the two ways i18n silently degrades to English.

1. UNRESOLVED - a t("...") lookup in src/ that en/translation.json cannot
   answer, either because the key is absent or because the path walks through
   a string. Renders the English fallback (or the raw key) in every language.

2. DRIFT - a key that exists in en but is missing from another locale, or a
   key a locale still carries that en dropped. Missing keys fall back to
   English; leftover keys are dead weight.

3. PLACEHOLDER - a locale whose {{interpolation}} variables don't match en's.
   These blow up as literal "{{count}}" text or silently drop a value.

Run from AutoSubs-App/:  python scripts/check-i18n-keys.py
Exits non-zero if anything is wrong, so it can gate CI.
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
LOCALES = os.path.join(ROOT, "src", "i18n", "locales")

# Matches t("some.key") / t('some.key') / t(`some.key`) - literal keys only.
KEY_RE = re.compile(r"""\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]""")
VAR_RE = re.compile(r"{{\s*(\w+)")

# i18next resolves these from a base key using the locale's CLDR plural rules,
# so a locale legitimately has categories English doesn't (Russian has four).
PLURAL_SUFFIXES = ("_zero", "_one", "_two", "_few", "_many", "_other")


def flatten(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else k))
    else:
        out[prefix] = obj
    return out


def load(lang):
    with open(os.path.join(LOCALES, lang, "translation.json"), encoding="utf-8") as fh:
        return json.load(fh)


langs = sorted(
    d for d in os.listdir(LOCALES) if os.path.isdir(os.path.join(LOCALES, d))
)
raw = {lang: load(lang) for lang in langs}
flat = {lang: flatten(obj) for lang, obj in raw.items()}
en_raw, en_flat = raw["en"], flat["en"]

problems = 0


def resolve(key):
    """Mirror i18next deepFind: a key may be flat-with-dots at any level."""
    node = en_raw
    parts = key.split(".")
    i = 0
    while i < len(parts):
        if not isinstance(node, dict):
            return None
        for j in range(len(parts), i, -1):
            candidate = ".".join(parts[i:j])
            if candidate in node:
                node = node[candidate]
                i = j
                break
        else:
            return None
    return node


def exists(key):
    if resolve(key) is not None:
        return True
    return any(resolve(key + s) is not None for s in PLURAL_SUFFIXES)


# --- 1. unresolved lookups -------------------------------------------------
for dirpath, _dirs, files in os.walk(os.path.join(ROOT, "src")):
    for name in files:
        if not name.endswith((".ts", ".tsx")):
            continue
        path = os.path.join(dirpath, name)
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                for key in KEY_RE.findall(line):
                    if "." not in key or exists(key):
                        continue
                    rel = os.path.relpath(path, ROOT).replace("\\", "/")
                    print(f"{rel}:{lineno}  UNRESOLVED  {key}")
                    problems += 1


def plural_base(key):
    for s in PLURAL_SUFFIXES:
        if key.endswith(s):
            return key[: -len(s)]
    return None


# --- 2. drift --------------------------------------------------------------
for lang in langs:
    if lang == "en":
        continue
    keys = set(flat[lang])
    for key in sorted(set(en_flat) - keys):
        print(f"{lang}  MISSING     {key}")
        problems += 1
    for key in sorted(keys - set(en_flat)):
        # An extra plural category is expected, not drift.
        base = plural_base(key)
        if base and any(base + s in en_flat for s in PLURAL_SUFFIXES):
            continue
        print(f"{lang}  ORPHANED    {key}")
        problems += 1

# --- 3. placeholder mismatches --------------------------------------------
for lang in langs:
    if lang == "en":
        continue
    for key, value in sorted(flat[lang].items()):
        if not isinstance(value, str):
            continue
        base = plural_base(key)
        ref = en_flat.get(key)
        if ref is None and base:
            ref = next(
                (en_flat[base + s] for s in PLURAL_SUFFIXES if base + s in en_flat),
                None,
            )
        if not isinstance(ref, str):
            continue
        if set(VAR_RE.findall(ref)) != set(VAR_RE.findall(value)):
            print(f"{lang}  PLACEHOLDER {key}")
            problems += 1

print(f"\n{len(langs)} locales checked: {problems} problem(s)")
sys.exit(1 if problems else 0)
