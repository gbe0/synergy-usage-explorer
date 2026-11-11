#!/usr/bin/env python3
"""
stamp_version.py - run this after changing anything in public/, including
the CSV files in public/data/.

This script:
  * checks public/data/tariffs.csv (the default tariffs) and copies it into
    public/js/default-tariffs.js, and copies public/data/sample-interval-data.csv
    (the sample readings) into public/js/sample-data.js. That is how the app
    reads them: a page opened straight from disk can't read a CSV file by itself,
  * lists every file in public/ in sw.js's FILES, so all of them are saved
    for offline use, and
  * sets VERSION in sw.js from a hash of those files' contents. The app's
    service worker (public/sw.js) saves a copy of the app on each device and
    keeps serving it until sw.js itself changes, so any edit needs a new
    VERSION for browsers to fetch the new copy.

    python3 stamp_version.py           # update public/sw.js
    python3 stamp_version.py --check   # exit 1 if sw.js is out of date (for CI)

Needs Python 3.8+ and nothing else.
"""

import csv
import hashlib
import io
import json
import re
import sys
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent / "public"
SW = PUBLIC / "sw.js"
DATA = PUBLIC / "data"
TARIFFS = DATA / "tariffs.csv"
TARIFFS_JS = PUBLIC / "js" / "default-tariffs.js"
SAMPLE = DATA / "sample-interval-data.csv"
SAMPLE_JS = PUBLIC / "js" / "sample-data.js"
TARIFF_COLUMNS = ["tariff", "current", "supply_cents_per_day", "peak_cents_per_kwh",
                  "off_peak_cents_per_kwh", "super_off_peak_cents_per_kwh"]
SKIP = {"sw.js", "index.html", ".DS_Store", "Thumbs.db"}  # index.html is saved as "./"


def app_files():
    files = []
    for p in sorted(PUBLIC.rglob("*")):
        rel = p.relative_to(PUBLIC).as_posix()
        parts = p.relative_to(PUBLIC).parts
        # data/ holds the CSV sources of the generated js files, so it isn't saved for offline use twice.
        if p.is_file() and p.name not in SKIP and parts[0] != "data" and not any(x.startswith(".") for x in parts):
            files.append(rel)
    return files


def tariffs_js():
    """Check tariffs.csv and return the text of default-tariffs.js made from it."""
    try:
        text = TARIFFS.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        sys.exit("public/data/tariffs.csv is missing: the app needs it for its default tariffs.")
    rows = list(csv.reader(io.StringIO(text)))
    rows = [r for r in rows if any(c.strip() for c in r)]
    problems = []
    head = [h.strip().lower() for h in rows[0]] if rows else []
    missing = [c for c in TARIFF_COLUMNS if c not in head]
    if missing:
        problems.append(f"it has no {', '.join(missing)} column")
    else:
        names, current = set(), 0
        for n, r in enumerate(rows[1:], start=2):
            def get(c, r=r):
                i = head.index(c)
                return (r[i] if i < len(r) else "").strip()
            name = get("tariff")
            if not name:
                continue
            if name.lower() in names:
                problems.append(f'line {n}: "{name}" is listed twice')
            names.add(name.lower())
            current += get("current").lower() == "yes"
            for c in TARIFF_COLUMNS[2:]:
                if not re.fullmatch(r"\d+\.?\d*|\.\d+", get(c)):
                    problems.append(f'line {n}: {c} for "{name}" is "{get(c)}", not a number of cents')
        if not names:
            problems.append("it lists no tariffs")
        elif current != 1:
            print(f"note: data/tariffs.csv marks {current} tariffs current=yes; the app uses "
                  + ("the first one listed." if current == 0 else "the first of them."))
    if problems:
        sys.exit("public/data/tariffs.csv needs fixing before the app can use it:\n  " + "\n  ".join(problems))
    return ("/* Made by stamp_version.py from data/tariffs.csv: edit that file, then run\n"
            " * python3 stamp_version.py. Don't edit this one. */\n"
            f"window.SYNERGY_TOOL_DEFAULT_TARIFFS = {json.dumps(text)};\n")


def sample_js():
    """Return the text of sample-data.js made from the sample CSV, or None if there is none."""
    if not SAMPLE.exists():
        print("note: public/data/sample-interval-data.csv is missing, so \"Try it with sample data\" won't work.")
        return None
    with open(SAMPLE, encoding="utf-8-sig", newline="") as f:   # keep its line endings, so a download matches the file
        text = f.read()
    head = [h.strip().upper() for h in next(csv.reader(io.StringIO(text)), [])]
    missing = [c for c in ["DATE", "TIME", "PEAK (KWH)", "OFF PEAK (KWH)", "SUPER OFF PEAK (KWH)"] if c not in head]
    if missing:
        sys.exit(f"public/data/sample-interval-data.csv has no {', '.join(missing)} column.")
    return ("/* Sample meter readings for \"Try it with sample data\". Made by stamp_version.py from\n"
            " * data/sample-interval-data.csv: edit that file, then run python3 stamp_version.py.\n"
            " * Don't edit this one. Loaded only when the sample is asked for. */\n"
            "window.SYNERGY_TOOL_SAMPLE = " + json.dumps({"name": SAMPLE.name, "text": text}) + ";\n")


def stamped(text):
    files = app_files()
    digest = hashlib.sha256()
    for rel in ["index.html", *files]:
        digest.update(rel.encode() + b"\0" + (PUBLIC / rel).read_bytes() + b"\0")
    listing = "const FILES = [\n  './',\n" + "".join(f"  '{f}',\n" for f in files) + "];\n"
    text, n1 = re.subn(r"(// FILES-START[^\n]*\n).*?(// FILES-END)", lambda m: m.group(1) + listing + m.group(2), text, flags=re.DOTALL)
    if n1 != 1:
        sys.exit("sw.js has lost its // FILES-START ... // FILES-END markers.")
    # The version covers the file list too, so it is worked out after the list is in place.
    body = re.sub(r"const VERSION = '[^']*';", "const VERSION = '';", text)
    digest.update(body.encode())
    version = digest.hexdigest()[:12]
    text, n2 = re.subn(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", text)
    if n2 != 1:
        sys.exit("sw.js has no `const VERSION = '...';` line.")
    return text, version, files


def main():
    check = "--check" in sys.argv[1:]
    for target, want, source in [(TARIFFS_JS, tariffs_js(), "data/tariffs.csv"), (SAMPLE_JS, sample_js(), "data/sample-interval-data.csv")]:
        have = target.read_text(encoding="utf-8") if target.exists() else None
        if want == have:
            continue
        name = target.relative_to(PUBLIC).as_posix()
        if check:
            print(f"public/{name} doesn't match {source}: run python3 stamp_version.py")
            return 1
        if want is None:
            target.unlink()
            print(f"public/{name} removed.")
        else:
            target.write_text(want, encoding="utf-8")
            print(f"public/{name} updated from {source}.")
    old = SW.read_text(encoding="utf-8")
    new, version, files = stamped(old)
    if check:
        if new != old:
            print("public/sw.js is out of date: run python3 stamp_version.py")
            return 1
        print(f"public/sw.js is up to date (version {version}).")
        return 0
    if new == old:
        print(f"Nothing changed; version is still {version}.")
        return 0
    SW.write_text(new, encoding="utf-8")
    print(f"public/sw.js now has version {version} and saves {len(files) + 1} files for offline use.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
