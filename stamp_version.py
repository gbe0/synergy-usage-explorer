#!/usr/bin/env python3
"""
stamp_version.py - run this after changing anything in public/, including
the CSV files in public/data/.

This script:
  * checks public/data/tariffs.csv (the default tariffs) and copies it into
    public/js/default-tariffs.js, and checks public/data/sample-interval-data.csv
    (the sample readings) and copies it into public/js/sample-data.js. That is
    how the app reads them: a page opened straight from disk can't read a CSV
    file by itself,
  * lists every file in public/ in sw.js's FILES, so all of them are saved
    for offline use, and
  * sets VERSION in sw.js from a hash of those files' contents. The app's
    service worker (public/sw.js) saves a copy of the app on each device and
    keeps serving it until sw.js itself changes, so any edit needs a new
    VERSION for browsers to fetch the new copy. Line endings don't count:
    a Windows (CRLF) checkout stamps the same VERSION as a Linux (LF) one.

The CSV checks are a Python copy of the app's own (csvRows, readTariffs and
parseIntervals in public/js/readers.js), so a file passes here exactly when
the app can read it. tests/readers.test.js runs the same files through both.

    python3 stamp_version.py           # update public/sw.js and the generated js files
    python3 stamp_version.py --check   # exit 1 if any of them is out of date (for CI)
    python3 stamp_version.py --check-tariffs PATH
        # check a tariffs CSV as the app would: exit 1 and list the problems,
        # with their line numbers, if the app can't use it
    python3 stamp_version.py --check-intervals PATH
        # the same for a meter interval CSV; the app reports only the first problem

Needs Python 3.8+ and nothing else.
"""

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

PUBLIC = Path(__file__).resolve().parent / "public"
SW = PUBLIC / "sw.js"
DATA = PUBLIC / "data"
TARIFFS = DATA / "tariffs.csv"
TARIFFS_JS = PUBLIC / "js" / "default-tariffs.js"
SAMPLE = DATA / "sample-interval-data.csv"
SAMPLE_JS = PUBLIC / "js" / "sample-data.js"
SKIP = {"sw.js", "index.html"}  # paths within public/; index.html is saved as "./"
JUNK = {".DS_Store", "Thumbs.db", "desktop.ini"}  # left by file managers, in any folder
# Files hashed with CRLF read as LF. Anything else (images) is hashed as it is.
TEXT_SUFFIXES = {".html", ".htm", ".js", ".mjs", ".css", ".svg", ".txt", ".json", ".webmanifest", ".csv", ".md", ".xml"}

RATE_COLUMNS = [("supply_cents_per_day", "supply charge"), ("peak_cents_per_kwh", "peak rate"),
                ("off_peak_cents_per_kwh", "off-peak rate"), ("super_off_peak_cents_per_kwh", "super off-peak rate")]
CREDIT_COLUMN = ("credit_cents_per_day", "daily credit")
TARIFF_COLUMNS = ["tariff", "current"] + [c for c, _ in RATE_COLUMNS]
KWH_COLUMNS = ["PEAK (KWH)", "OFF PEAK (KWH)", "SUPER OFF PEAK (KWH)"]

# JavaScript's idea of white space (trim() and \s), which isn't quite str.strip()'s:
# that also strips \x1c-\x1f and \x85, and leaves the byte order mark.
JS_SPACE = ("\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
            "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
JS_DOT = "[^\n\r\u2028\u2029]"  # what . matches in JavaScript
# [0-9], not \d, which in Python also matches other scripts' digits.
AMOUNT = re.compile(r"[0-9]+\.?[0-9]*|\.[0-9]+")
TARIFF_ISO = re.compile(r"([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})")
TARIFF_DMY = re.compile(r"([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})")
METER_ISO = re.compile(r"([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[T" + JS_SPACE + "]" + JS_DOT + "*)?")
METER_DMY = re.compile(r"([0-9]{1,2})[/.]([0-9]{1,2})[/.]([0-9]{4}|[0-9]{2})(?:[" + JS_SPACE + "]" + JS_DOT + "*)?")
METER_TIME = re.compile(r"([0-9]{1,2}):([0-9]{2})(?::[0-9]{2}(?:\.[0-9]+)?)?")
METER_KWH = re.compile(r"-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?")


class InputError(Exception):
    """A problem that stops the app reading a CSV file, worded as the app words it."""


def read_csv_text(path, label):
    """The text of a CSV file as the app sees it: UTF-8, byte order mark dropped, line endings kept."""
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            return f.read()
    except UnicodeDecodeError as e:
        sys.exit(f"{label} isn't saved as UTF-8 text (byte {e.start + 1} isn't valid UTF-8), so the app would "
                 'misread it. In Excel, use Save As and choose "CSV UTF-8 (Comma delimited)"; other programs '
                 "have a similar choice. Then run this again.")
    except OSError as e:
        sys.exit(f"{label} can't be read ({e.strerror}).")


def csv_rows(text):
    """Port of csvRows: [(line, cells)], cells trimmed, with the line each row starts on; blank rows dropped."""
    out = []
    s = text[1:] if text.startswith("\ufeff") else text
    row, field, quoted, line, start = [], "", False, 1, 1

    def push():
        row.append(field)
        if any(x.strip(JS_SPACE) for x in row):
            out.append((start, [x.strip(JS_SPACE) for x in row]))

    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if quoted:
            if c == '"':
                if i + 1 < n and s[i + 1] == '"':
                    field += '"'
                    i += 1
                else:
                    quoted = False
            else:
                if c == "\n":
                    line += 1
                field += c
        elif c == '"':
            quoted = True
        elif c == ",":
            row.append(field)
            field = ""
        elif c in "\r\n":
            if c == "\r" and i + 1 < n and s[i + 1] == "\n":
                i += 1
            push()
            row, field = [], ""
            line += 1
            start = line
        else:
            field += c
        i += 1
    if field != "" or row:
        push()
    return out


def cell(cells, i):
    return cells[i] if 0 <= i < len(cells) else ""


def iso_date(y, month, day):
    """Port of isoDate: "2026-09-01", or None when there is no such day."""
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if not 1 <= month <= 12 or not 1 <= day <= days[month - 1]:
        return None
    return f"{y:04d}-{month:02d}-{day:02d}"


def nice_date(iso):
    month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][int(iso[5:7]) - 1]
    return f"{int(iso[8:10])} {month} {iso[:4]}"


def tariff_date(text):
    """Port of tariffDate: YYYY-MM-DD for "2025-07-01" or "1/07/2025", "" for blank, None for no such day."""
    if text == "":
        return ""
    m = TARIFF_ISO.fullmatch(text)
    if m:
        return iso_date(int(m[1]), int(m[2]), int(m[3]))
    m = TARIFF_DMY.fullmatch(text)
    return iso_date(int(m[3]), int(m[2]), int(m[1])) if m else None


def read_tariffs(text):
    """Port of readTariffs. Returns (tariffs, problems, notes): tariffs maps each name to its
    rate periods' start dates; problems is [(line or None, message)]. The app stops at the
    first problem, which is the first here too; this goes on to list the rest."""
    rows = csv_rows(text)
    if not rows:
        return {}, [(None, "it is empty.")], []
    head = [h.lower() for h in rows[0][1]]
    missing = [c for c in TARIFF_COLUMNS if c not in head]
    if missing:
        return {}, [(None, f"it has no {', '.join(missing)} column.")], []
    tariffs, current, problems = {}, {}, []
    for line, cells in rows[1:]:
        def get(col, cells=cells):
            return cell(cells, head.index(col)) if col in head else ""

        name = get("tariff")
        if not name:
            continue
        raw = get("from")
        start = tariff_date(raw)
        if start is None:
            looks = TARIFF_ISO.fullmatch(raw) or TARIFF_DMY.fullmatch(raw)
            problems.append((line, f"the from date for “{name}” is “{raw}”, "
                             + ("which isn’t a real date." if looks else "not a date like 2025-07-01 or 1/07/2025.")))
        key = name.lower()
        dates = tariffs.setdefault(key, (name, []))[1]
        if start is not None and start in dates:
            problems.append((line, f"“{name}” is listed twice for the same date, {nice_date(start)}." if start else
                             f"“{name}” is listed twice with no from date. Only one of its rows can leave from blank; "
                             "give the others the date their rates start."))
        for col, label in RATE_COLUMNS:
            v = get(col)
            if not AMOUNT.fullmatch(v):
                problems.append((line, f"the {label} for “{name}” ({col}) is “{v}”, not a number of cents."))
        credit = get(CREDIT_COLUMN[0])
        if credit != "" and not AMOUNT.fullmatch(credit):
            problems.append((line, f"the {CREDIT_COLUMN[1]} for “{name}” ({CREDIT_COLUMN[0]}) is “{credit}”, "
                                   + "not a number of cents. Leave it blank for none."))
        if start is not None:
            dates.append(start)
        current[key] = current.get(key, False) or get("current").lower() == "yes"
    if not tariffs:
        problems.append((None, "it lists no tariffs."))
    named = {name: sorted(dates) for name, dates in tariffs.values()}
    notes = []
    marked = [tariffs[k][0] for k, yes in current.items() if yes]
    if named and not marked:
        notes.append(f"No tariff was marked current, so “{next(iter(named))}” is treated as current.")
    elif len(marked) > 1:
        notes.append(f"More than one tariff was marked current; “{marked[0]}” is used.")
    return named, problems, notes


def date_parts(text):
    """Port of dateParts: (iso, y, a, b), or None when it isn't a date."""
    m = METER_ISO.fullmatch(text)
    if m:
        return True, int(m[1]), int(m[2]), int(m[3])
    m = METER_DMY.fullmatch(text)
    if not m:
        return None
    y = int(m[3])
    return False, y + 2000 if y < 100 else y, int(m[1]), int(m[2])


def parse_intervals(text, name, order="dmy"):
    """Port of parseIntervals's checks: raises InputError with the app's message for the
    first problem; returns the number of rows otherwise."""
    rows = csv_rows(text)
    if not rows:
        raise InputError(f"{name} is empty.")
    head = [h.upper() for h in rows[0][1]]
    missing = [h for h in ["DATE", "TIME"] + KWH_COLUMNS if h not in head]
    if missing:
        raise InputError(f"{name} isn't a meter interval file: it has no {', '.join(missing)} column. "
                         f"Its columns are: {', '.join(c for c in rows[0][1] if c) or 'none'}.")
    i_date, i_time = head.index("DATE"), head.index("TIME")
    i_kwh = [head.index(h) for h in KWH_COLUMNS]
    body = [(line, cells) for line, cells in rows[1:] if cell(cells, i_date).upper() != "DATE"]
    if not body:
        raise InputError(f"{name} has a header row but no readings.")
    # The date order, from the dates themselves where possible.
    max_a = max_b = 0
    parts = []
    for line, cells in body:
        p = date_parts(cell(cells, i_date))
        if not p:
            raise InputError(f'{name}, line {line}: "{cell(cells, i_date)}" is not a date.')
        if not p[0]:
            max_a, max_b = max(max_a, p[2]), max(max_b, p[3])
        parts.append(p)
    if max_a > 12 and max_b > 12:
        raise InputError(f"{name}: the dates mix day/month and month/day order, so they can't be read.")
    used = "dmy" if max_a > 12 else "mdy" if max_b > 12 else "mdy" if order == "mdy" else "dmy"
    readings = 0
    for (line, cells), (iso, y, a, b) in zip(body, parts):
        month, day = (a, b) if iso or used == "mdy" else (b, a)
        if not iso_date(y, month, day):
            how = "" if iso else f" when read as {'month/day' if used == 'mdy' else 'day/month'}"
            raise InputError(f'{name}, line {line}: "{cell(cells, i_date)}" is not a real date{how}.')
        tm = METER_TIME.fullmatch(cell(cells, i_time))
        if not tm or int(tm[1]) > 23 or int(tm[2]) > 59:
            raise InputError(f'{name}, line {line}: "{cell(cells, i_time)}" is not a time like 13:30.')
        for i, column in zip(i_kwh, KWH_COLUMNS):
            v = cell(cells, i)
            v = v[1:] if v.startswith("+") else v
            if v == "":
                continue
            if not METER_KWH.fullmatch(v):
                raise InputError(f'{name}, line {line}: "{cell(cells, i)}" under {column} is not a number of kWh.')
            readings += 1
    if not readings:
        raise InputError(f"{name} has no kWh readings: the PEAK, OFF PEAK and SUPER OFF PEAK columns are empty.")
    return len(body)


def problem_lines(problems):
    return "".join(f"\n  line {line}: {text}" if line else f"\n  {text}" for line, text in problems)


def tariffs_js():
    """Check tariffs.csv and return the text of default-tariffs.js made from it."""
    if not TARIFFS.exists():
        sys.exit("public/data/tariffs.csv is missing: the app needs it for its default tariffs.")
    text = read_csv_text(TARIFFS, "public/data/tariffs.csv").replace("\r\n", "\n")
    _, problems, notes = read_tariffs(text)
    if problems:
        sys.exit("public/data/tariffs.csv needs fixing before the app can use it:" + problem_lines(problems))
    for note in notes:
        print(f"note: data/tariffs.csv: {note}")
    return ("/* Made by stamp_version.py from data/tariffs.csv: edit that file, then run\n"
            " * python3 stamp_version.py. Don't edit this one. */\n"
            f"window.SYNERGY_TOOL_DEFAULT_TARIFFS = {json.dumps(text)};\n")


def sample_js():
    """Check the sample CSV and return the text of sample-data.js made from it, or None if there is none."""
    if not SAMPLE.exists():
        print("note: public/data/sample-interval-data.csv is missing, so \"Try it with sample data\" won't work.")
        return None
    label = "public/data/sample-interval-data.csv"
    text = read_csv_text(SAMPLE, label).replace("\r\n", "\n")
    try:
        parse_intervals(text, label)
    except InputError as e:
        sys.exit(f"{e} Fix it, then run this again: the app couldn't open it as the sample.")
    return ("/* Sample meter readings for \"Try it with sample data\". Made by stamp_version.py from\n"
            " * data/sample-interval-data.csv: edit that file, then run python3 stamp_version.py.\n"
            " * Don't edit this one. Loaded only when the sample is asked for. */\n"
            "window.SYNERGY_TOOL_SAMPLE = " + json.dumps({"name": SAMPLE.name, "text": text}) + ";\n")


def app_files():
    files = []
    for p in PUBLIC.rglob("*"):
        parts = p.relative_to(PUBLIC).parts
        rel = "/".join(parts)
        # data/ holds the CSV sources of the generated js files, so it isn't saved for offline use twice.
        if p.is_file() and rel not in SKIP and p.name not in JUNK and parts[0] != "data" \
                and not any(x.startswith(".") for x in parts):
            files.append(rel)
    return sorted(files)  # as text, so every system lists them in the same order


def file_bytes(path):
    """A file's contents for the VERSION hash, text files with CRLF read as LF."""
    data = path.read_bytes()
    return data.replace(b"\r\n", b"\n") if path.suffix.lower() in TEXT_SUFFIXES else data


def url_path(rel):
    """rel as sw.js should ask for it: percent-encoded where a browser would encode it itself, plus
    #, ?, % and \\, which would otherwise change the URL. Everything else stays as it is, so the
    saved copy's address matches the page's own requests for it."""
    url = quote(rel, safe="/!$&'()*+,;=:@[]^|")
    return "./" + url if ":" in url.split("/")[0] else url  # "a:b.js" would read as a URL scheme


def stamped(text):
    files = app_files()
    digest = hashlib.sha256()
    for rel in ["index.html", *files]:
        digest.update(rel.encode() + b"\0" + file_bytes(PUBLIC / rel) + b"\0")
    listing = "const FILES = [\n" + "".join(f"  {json.dumps(u)},\n" for u in ["./"] + [url_path(f) for f in files]) + "];\n"
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


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:  # LF on every system
        f.write(text)


def check_file(kind, path):
    """--check-tariffs and --check-intervals: 0 if the app can read the file, 1 if not."""
    text = read_csv_text(path, path)
    if kind == "--check-tariffs":
        tariffs, problems, notes = read_tariffs(text)
        if problems:
            print(f"{path} needs fixing before the app can use it:" + problem_lines(problems))
            return 1
        for note in notes:
            print(f"note: {note}")
        print(f"{path} is fine: {len(tariffs)} tariff{'' if len(tariffs) == 1 else 's'}, "
              f"{sum(len(d) for d in tariffs.values())} sets of rates.")
        return 0
    try:
        rows = parse_intervals(text, path)
    except InputError as e:
        print(e)
        return 1
    print(f"{path} is fine: {rows} rows.")
    return 0


def main():
    # Names in the CSVs can hold any character; don't let a console that can't show one stop the script.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    args = sys.argv[1:]
    if args and args[0] in ("--check-tariffs", "--check-intervals"):
        if len(args) != 2:
            sys.exit(f"usage: python3 stamp_version.py {args[0]} PATH")
        return check_file(args[0], args[1])
    check = "--check" in args
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
            write(target, want)
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
    write(SW, new)
    print(f"public/sw.js now has version {version} and saves {len(files) + 1} files for offline use.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
