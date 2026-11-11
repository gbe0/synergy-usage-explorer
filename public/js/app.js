/*
 * app.js - everything around the dashboard: opening and checking the meter
 * CSV, the tariff editor, keeping both in this browser (IndexedDB), and the
 * offline / install plumbing. Nothing here sends data anywhere.
 */
(function () {
  'use strict';

  // The default tariffs come from data/tariffs.csv, which stamp_version.py copies into
  // js/default-tariffs.js (a page opened from disk can't read the CSV itself).
  const DEFAULT_TARIFFS = typeof window.SYNERGY_TOOL_DEFAULT_TARIFFS === 'string' ? window.SYNERGY_TOOL_DEFAULT_TARIFFS : null;
  const KWH_COLUMNS = ['PEAK (KWH)', 'OFF PEAK (KWH)', 'SUPER OFF PEAK (KWH)'];
  const RATE_COLUMNS = [
    {col: 'supply_cents_per_day', label: 'supply charge'},
    {col: 'peak_cents_per_kwh', label: 'peak rate'},
    {col: 'off_peak_cents_per_kwh', label: 'off-peak rate'},
    {col: 'super_off_peak_cents_per_kwh', label: 'super off-peak rate'},
  ];
  const TARIFF_COLUMNS = ['tariff', 'current', ...RATE_COLUMNS.map((r) => r.col)];
  const MAX_BYTES = 50 * 1024 * 1024;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const $ = (sel) => document.querySelector(sel);
  const pad2 = (n) => String(n).padStart(2, '0');
  const niceDate = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  const count = (n) => n.toLocaleString('en');

  class InputError extends Error {}

  /* ------------------------------------------------------------ CSV reading */

  // Rows of cells (trimmed), each with the line it starts on; blank rows dropped.
  function csvRows(text) {
    const out = [];
    const s = String(text || '').replace(/^\uFEFF/, '');
    let row = [], field = '', quoted = false, line = 1, start = 1;
    const push = () => {
      row.push(field);
      if (row.some((x) => x.trim() !== '')) out.push({cells: row.map((x) => x.trim()), line: start});
      row = []; field = '';
    };
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (quoted) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
        else { if (c === '\n') line += 1; field += c; }
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i += 1;
        push();
        line += 1; start = line;
      } else field += c;
    }
    if (field !== '' || row.length) push();
    return out;
  }

  const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  // "01/09/2026", "1.9.26", "2026-09-01" -> parts; null when it isn't a date.
  function dateParts(text) {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
    if (m) return {iso: true, y: +m[1], a: +m[2], b: +m[3]};
    m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?:\s.*)?$/.exec(text);
    if (!m) return null;
    let y = +m[3];
    if (y < 100) y += 2000;
    return {iso: false, a: +m[1], b: +m[2], y};
  }
  function isoDate(y, month, day) {
    const t = new Date(Date.UTC(y, month - 1, day));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) return null;
    return `${y}-${pad2(month)}-${pad2(day)}`;
  }

  /*
   * Reads one meter interval CSV into half-hour rows. order ('dmy' or 'mdy')
   * only matters when every date in the file could be read either way.
   * Header rows repeated part-way down (files joined by hand) are skipped.
   */
  function parseIntervals(text, order, name) {
    const rows = csvRows(text);
    if (!rows.length) throw new InputError(`${name} is empty.`);
    const head = rows[0].cells.map((h) => h.toUpperCase());
    const col = (h) => head.indexOf(h);
    const missing = ['DATE', 'TIME', ...KWH_COLUMNS].filter((h) => col(h) < 0);
    if (missing.length) {
      throw new InputError(`${name} isn't a meter interval file: it has no ${missing.join(', ')} column. `
        + `Its columns are: ${rows[0].cells.filter(Boolean).join(', ') || 'none'}.`);
    }
    const iDate = col('DATE'), iTime = col('TIME'), iStatus = col('BILLING STATUS');
    const iKwh = KWH_COLUMNS.map(col);
    const body = rows.slice(1).filter((r) => (r.cells[iDate] || '').toUpperCase() !== 'DATE');
    const repeatedHeaders = rows.length - 1 - body.length;
    if (!body.length) throw new InputError(`${name} has a header row but no readings.`);

    // Work out the date order from the dates themselves where possible.
    let maxA = 0, maxB = 0, slash = false;
    const parts = body.map((r) => {
      const p = dateParts(r.cells[iDate] || '');
      if (!p) throw new InputError(`${name}, line ${r.line}: "${r.cells[iDate] || ''}" is not a date.`);
      if (!p.iso) { slash = true; maxA = Math.max(maxA, p.a); maxB = Math.max(maxB, p.b); }
      return p;
    });
    if (maxA > 12 && maxB > 12) throw new InputError(`${name}: the dates mix day/month and month/day order, so they can't be read.`);
    const ambiguous = slash && maxA <= 12 && maxB <= 12;
    const used = maxA > 12 ? 'dmy' : maxB > 12 ? 'mdy' : order === 'mdy' ? 'mdy' : 'dmy';

    let readings = 0;
    const out = body.map((r, n) => {
      const p = parts[n];
      const [month, day] = p.iso ? [p.a, p.b] : used === 'mdy' ? [p.a, p.b] : [p.b, p.a];
      const date = isoDate(p.y, month, day);
      if (!date) throw new InputError(`${name}, line ${r.line}: "${r.cells[iDate]}" is not a real date${p.iso ? '' : ` when read as ${used === 'mdy' ? 'month/day' : 'day/month'}`}.`);
      const tm = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(r.cells[iTime] || '');
      if (!tm || +tm[1] > 23 || +tm[2] > 59) throw new InputError(`${name}, line ${r.line}: "${r.cells[iTime] || ''}" is not a time like 13:30.`);
      const values = iKwh.map((i, k) => {
        const v = (r.cells[i] || '').replace(/^\+/, '');
        if (v === '') return '';
        if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v)) throw new InputError(`${name}, line ${r.line}: "${r.cells[i]}" under ${KWH_COLUMNS[k]} is not a number of kWh.`);
        readings += 1;
        return String(Number(v));
      });
      const status = iStatus >= 0 ? (r.cells[iStatus] || '').replace(/[",\r\n]/g, ' ') : 'Billed';
      return {date, time: `${pad2(+tm[1])}:${tm[2]}`, values, status};
    });
    if (!readings) throw new InputError(`${name} has no kWh readings: the PEAK, OFF PEAK and SUPER OFF PEAK columns are empty.`);
    return {name, rows: out, ambiguous, order: used, hasStatus: iStatus >= 0, repeatedHeaders};
  }

  const HALF_HOURS = Array.from({length: 48}, (_, i) => `${pad2(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
  const halfHourEnd = (t) => HALF_HOURS[(HALF_HOURS.indexOf(t) + 1) % 48];
  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = (iso) => `${WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${niceDate(iso)}`;

  // Runs of missing half-hours between 00:00 on the first day and 23:30 on the last.
  function findGaps(has, first, last) {
    const gaps = [];
    let run = null;
    for (let t = Date.parse(first); t <= Date.parse(last); t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10);
      for (const time of HALF_HOURS) {
        if (has(date, time)) { run = null; continue; }
        if (run) { run.toDate = date; run.toTime = time; run.n += 1; }
        else { run = {fromDate: date, fromTime: time, toDate: date, toTime: time, n: 1}; gaps.push(run); }
      }
    }
    return gaps;
  }
  function describeGap(g) {
    const whole = g.fromTime === '00:00' && g.toTime === '23:30';
    if (whole && g.fromDate === g.toDate) return `${dayName(g.fromDate)} (the whole day)`;
    if (whole) return `${dayName(g.fromDate)} – ${dayName(g.toDate)} (${count(g.n / 48)} whole days)`;
    if (g.fromDate === g.toDate) return `${dayName(g.fromDate)}, ${g.fromTime}–${halfHourEnd(g.toTime)}`;
    return `${dayName(g.fromDate)} ${g.fromTime} – ${dayName(g.toDate)} ${halfHourEnd(g.toTime)}`;
  }

  const listNames = (names) => (names.length < 2 ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

  /*
   * Combines parsed files into the one layout dashboard.js reads (DD/MM/YYYY
   * dates), counting every half-hour once. When the same half-hour appears
   * more than once (overlapping exports, or files joined by hand), a billed
   * reading beats one not yet billed; otherwise the copy from the file whose
   * readings run latest wins, and within one file the later row.
   */
  function mergeIntervals(parsed) {
    const ranked = parsed
      .map((p, i) => ({p, i, last: p.rows.reduce((m, r) => (r.date > m ? r.date : m), '')}))
      .sort((x, y) => (x.last < y.last ? -1 : x.last > y.last ? 1 : x.i - y.i));
    const byKey = new Map();
    const repeated = new Set(), differing = new Set();
    for (const {p} of ranked) {
      for (const r of p.rows) {
        const key = `${r.date} ${r.time}`;
        const had = byKey.get(key);
        if (had) {
          repeated.add(key);
          if (had.values.join() !== r.values.join()) differing.add(key);
          if (had.status === 'Billed' && r.status !== 'Billed') continue;
        }
        byKey.set(key, r);
      }
    }
    const keys = [...byKey.keys()].sort();
    const lines = ['Date,Time,PEAK (KWH),OFF PEAK (KWH),SUPER OFF PEAK (KWH),Billing Status'];
    const dates = new Set();
    for (const key of keys) {
      const r = byKey.get(key);
      dates.add(r.date);
      lines.push([`${r.date.slice(8, 10)}/${r.date.slice(5, 7)}/${r.date.slice(0, 4)}`, r.time, ...r.values, r.status].join(','));
    }
    const days = [...dates].sort();

    const gaps = findGaps((date, time) => byKey.has(`${date} ${time}`), days[0], days[days.length - 1]);
    const missing = gaps.reduce((n, g) => n + g.n, 0);

    const files = parsed.map((p) => {
      const own = new Set(p.rows.map((r) => `${r.date} ${r.time}`));
      const ds = p.rows.map((r) => r.date).sort();
      return {name: p.name, halfHours: own.size, first: ds[0], last: ds[ds.length - 1]};
    });
    const notes = [];
    const many = parsed.length > 1;
    for (const p of parsed.filter((x) => !x.hasStatus)) {
      notes.push(many ? `${p.name} has no Billing Status column, so its readings count as billed.`
        : 'There is no Billing Status column, so every reading counts as billed.');
    }
    const joined = parsed.filter((p) => p.repeatedHeaders);
    if (joined.length) notes.push(`${listNames(joined.map((p) => p.name))} ${joined.length > 1 ? 'repeat' : 'repeats'} the header row part-way down, as files joined by hand do; the extra header rows were skipped.`);
    const ambiguous = parsed.some((p) => p.ambiguous);
    if (ambiguous) {
      const used = parsed.find((p) => p.ambiguous).order;
      notes.push(`Every date in ${many ? listNames(parsed.filter((p) => p.ambiguous).map((p) => p.name)) : 'the file'} could be read as day/month or as month/day. They are read as ${used === 'mdy' ? 'month/day' : 'day/month'}; change this under “Dates are” if that’s wrong.`);
    }
    if (repeated.size) {
      let note = `${count(repeated.size)} half-hour${repeated.size === 1 ? '' : 's'} appear${repeated.size === 1 ? 's' : ''} more than once`
        + `${many ? ' across the files' : ' in the file'} and ${repeated.size === 1 ? 'is' : 'are'} counted once.`;
      if (differing.size) {
        note += ` ${count(differing.size)} of them ${differing.size === 1 ? 'has' : 'have'} different readings in different copies; the billed reading is used, or else the one from the file whose readings run latest.`;
      }
      notes.push(note);
    }
    if (missing) {
      const shown = gaps.slice(0, 4).map(describeGap);
      notes.unshift(`${count(missing)} half-hour${missing === 1 ? ' is' : 's are'} missing between the first and last day, `
        + `in ${count(gaps.length)} gap${gaps.length === 1 ? '' : 's'}: ${shown.join('; ')}${gaps.length > 4 ? `; and ${count(gaps.length - 4)} more` : ''}. `
        + 'Nothing is counted for those times, so use and costs there are understated; Data checks lists the gaps in the chosen dates.');
    }
    return {
      csv: lines.join('\n') + '\n', halfHours: keys.length, missing, gaps: gaps.length, first: days[0], last: days[days.length - 1], days: days.length,
      notes, ambiguous, order: ambiguous ? parsed.find((p) => p.ambiguous).order : 'dmy', files, overlaps: repeated.size, differing: differing.size,
    };
  }

  const isAmount = (v) => /^(\d+\.?\d*|\.\d+)$/.test(v);

  // Checks a tariffs CSV; returns {tariffs: [{tariff, current, <rate columns as text>}], notes}.
  function readTariffs(text, name) {
    const rows = csvRows(text);
    if (!rows.length) throw new InputError(`${name} is empty.`);
    const head = rows[0].cells.map((h) => h.toLowerCase());
    const missing = TARIFF_COLUMNS.filter((c) => !head.includes(c));
    if (missing.length) throw new InputError(`${name} has no ${missing.join(', ')} column.`);
    const tariffs = [];
    const names = new Set();
    for (const r of rows.slice(1)) {
      const get = (c) => r.cells[head.indexOf(c)] || '';
      const t = {tariff: get('tariff'), current: get('current').toLowerCase() === 'yes'};
      if (!t.tariff) continue;
      if (names.has(t.tariff.toLowerCase())) throw new InputError(`${name}, line ${r.line}: “${t.tariff}” is listed twice.`);
      names.add(t.tariff.toLowerCase());
      for (const {col, label} of RATE_COLUMNS) {
        const v = get(col);
        if (!isAmount(v)) throw new InputError(`${name}, line ${r.line}: the ${label} for “${t.tariff}” (${col}) is “${v}”, not a number of cents.`);
        t[col] = v;
      }
      tariffs.push(t);
    }
    if (!tariffs.length) throw new InputError(`${name} lists no tariffs.`);
    const notes = [];
    const current = tariffs.filter((t) => t.current);
    if (!current.length) {
      tariffs[0].current = true;
      notes.push(`No tariff was marked current, so “${tariffs[0].tariff}” is treated as current.`);
    } else if (current.length > 1) {
      current.slice(1).forEach((t) => { t.current = false; });
      notes.push(`More than one tariff was marked current; “${current[0].tariff}” is used.`);
    }
    return {tariffs, notes};
  }

  const tariffsToCsv = (list) => [TARIFF_COLUMNS.join(',')]
    .concat(list.map((t) => [csvCell(t.tariff), t.current ? 'yes' : 'no', ...RATE_COLUMNS.map((r) => t[r.col])].join(',')))
    .join('\n') + '\n';

  const looksLikeTariffs = (text) => {
    const first = csvRows(String(text).slice(0, 2000))[0];
    return !!first && first.cells.some((c) => c.toLowerCase() === 'supply_cents_per_day');
  };

  /* ------------------------------------------------------------ storage */

  // A tiny key-value store in IndexedDB. Every call resolves, even when the
  // browser blocks storage; set/del resolve to false then.
  const store = (() => {
    let dbp = null;
    const open = () => {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          const req = indexedDB.open('synergy-tool', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('IndexedDB is blocked'));
        });
      }
      return dbp;
    };
    const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
    const safe = (p, fallback) => {
      try { return p().catch((e) => { console.warn('Storage:', e); return fallback; }); }
      catch (e) { console.warn('Storage:', e); return Promise.resolve(fallback); }
    };
    return {
      get: (key) => safe(() => run('readonly', (s) => s.get(key)), undefined),
      set: (key, value) => safe(() => run('readwrite', (s) => s.put(value, key)).then(() => true), false),
      del: (key) => safe(() => run('readwrite', (s) => s.delete(key)).then(() => true), false),
    };
  })();

  /* ------------------------------------------------------------ state + messages */

  const state = {
    rec: null,        // what is stored: {files: [{name, text, size}], order, savedAt}
    merged: null,     // mergeIntervals() result for rec
    tariffs: [],
    tariffsCsv: '',
    storageWarned: false,
  };

  function message(kind, text, action) {
    const box = $('#app-msg');
    const div = document.createElement('div');
    div.className = `app-msg app-msg-${kind}`;
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const span = document.createElement('span');
    span.textContent = text;
    div.append(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'app-btn app-btn-primary';
      b.textContent = action.label;
      b.addEventListener('click', action.fn);
      div.append(b);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'app-msg-close';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', () => div.remove());
    div.append(x);
    box.replaceChildren(div);
  }
  const clearMessages = () => $('#app-msg').replaceChildren();

  function warnNoStorage() {
    if (state.storageWarned) return;
    state.storageWarned = true;
    message('info', 'This browser isn’t letting the app keep a copy, so the file and any tariff changes will need to be opened or made again next time.');
  }
  const saveOrWarn = (key, value) => store.set(key, value).then((ok) => { if (!ok) warnNoStorage(); });

  /* ------------------------------------------------------------ data in, dashboard out */

  function show(view) {
    $('#app-welcome').hidden = view !== 'welcome';
    $('#dash-root').hidden = view !== 'dash';
    document.body.dataset.view = view;
    if (view === 'dash') dash.redraw();
  }

  function pushSources() {
    if (state.merged) dash.setSources({intervals: state.merged.csv, tariffs: state.tariffsCsv});
    else dash.setSources({tariffs: state.tariffsCsv});
  }

  function setTariffs(text, name, save) {
    const r = readTariffs(text, name);
    state.tariffs = r.tariffs;
    state.tariffsCsv = tariffsToCsv(r.tariffs);
    if (save) {
      saveOrWarn('tariffs', state.tariffsCsv);
      // Remember which defaults this list was made from, to spot when they change.
      store.set('tariffsBase', DEFAULT_TARIFFS);
    }
    pushSources();
    return r;
  }

  // Records saved by the first version held one file: {name, text, size, order}.
  function asRecord(saved) {
    if (saved && Array.isArray(saved.files)) return saved;
    if (saved && typeof saved.text === 'string') {
      return {files: [{name: saved.name || 'readings.csv', text: saved.text, size: saved.size || saved.text.length}], order: saved.order || 'dmy', savedAt: saved.savedAt};
    }
    return null;
  }

  /*
   * Reads and merges every file in rec and shows the result. Files that can't
   * be read are left out (and named in `errors`). Returns {rec, merged, errors},
   * with rec holding only the files that were used, or null if none could be.
   */
  function useRecord(rec, fresh) {
    const parsed = [], kept = [], errors = [];
    for (const f of rec.files) {
      try {
        parsed.push(parseIntervals(f.text, rec.order, f.name));
        kept.push(f);
      } catch (e) {
        if (!(e instanceof InputError)) console.error(e);
        errors.push(e instanceof InputError ? e.message : `${f.name} couldn’t be read (${e.message}).`);
      }
    }
    if (!parsed.length) return {rec: null, merged: null, errors};
    const merged = mergeIntervals(parsed);
    const used = Object.assign({}, rec, {files: kept});
    state.rec = used;
    state.merged = merged;
    if (fresh) dash.setParams({range: 'all', day: '', from: '', to: ''});
    pushSources();
    renderDataStrip();
    show('dash');
    return {rec: used, merged, errors};
  }

  const shortRange = (a, b) => (a === b ? niceDate(a) : `${niceDate(a)} – ${niceDate(b)}`);

  function renderDataStrip() {
    const {rec, merged} = state;
    const many = rec.files.length > 1;
    $('#app-file-name').textContent = many ? `${rec.files.length} files` : rec.files[0].name;
    $('#app-file-meta').textContent = `${count(merged.halfHours)} readings over ${count(merged.days)} days, ${shortRange(merged.first, merged.last)}`;
    $('#app-order-wrap').hidden = !merged.ambiguous;
    $('#app-order').value = merged.order;
    const box = $('#app-files');
    box.hidden = !many;
    $('#app-files-summary').textContent = `Show the ${rec.files.length} files`;
    $('#app-files-list').replaceChildren(...merged.files.map((f, i) => {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = f.name;
      const info = document.createElement('span');
      info.textContent = `${shortRange(f.first, f.last)}, ${count(f.halfHours)} readings`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'app-link';
      rm.textContent = 'Remove';
      rm.setAttribute('aria-label', `Remove ${f.name}`);
      rm.addEventListener('click', () => removeFile(i));
      li.append(name, info, rm);
      return li;
    }));
    const notes = $('#app-notes');
    const sampleNote = rec.files.some((f) => f.sample)
      ? ['This is sample data, not your own: 90 days of real readings re-dated to July–September 2025, with some events added to show what the '
        + 'dashboard picks up: a hot-water boost overnight (15 Jul), a weekend away (25–27 Jul), an electric car charging at peak (21 Aug), '
        + 'a meter dropout (3 Sep), a heatwave (6 Sep), a heater left on (15–20 Sep) and a power cut (22 Sep). The readings have a few unusual '
        + 'days of their own too. Open your own CSV with Open CSV… to replace it.'] : [];
    notes.replaceChildren(...sampleNote.concat(merged.notes).map((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      return li;
    }));
    notes.hidden = !(sampleNote.length + merged.notes.length);
    const names = listNames(rec.files.map((f) => f.name));
    document.querySelectorAll('[data-app="file-name"]').forEach((el) => { el.textContent = names; });
  }

  async function readAll(list) {
    return Promise.all([...list].map(async (file) => {
      if (file.size > MAX_BYTES) return {name: file.name, error: `${file.name} is ${(file.size / 1048576).toFixed(0)} MB; the app reads files up to ${MAX_BYTES / 1048576} MB.`};
      try {
        return {name: file.name, size: file.size, text: await file.text()};
      } catch (e) {
        return {name: file.name, error: `${file.name} couldn’t be read (${e.message}).`};
      }
    }));
  }

  /*
   * Opens CSV files. mode 'replace' starts again with just these files; 'add'
   * merges them with the files already open. A tariffs CSV among them
   * replaces the tariff list instead.
   */
  async function openFiles(list, mode) {
    const read = await readAll(list || []);
    if (!read.length) return;
    const errors = read.filter((f) => f.error).map((f) => f.error);
    const info = [];
    const ok = read.filter((f) => !f.error);
    const tariffFiles = ok.filter((f) => looksLikeTariffs(f.text));
    for (const f of tariffFiles) {
      try {
        const r = setTariffs(f.text, f.name, true);
        info.push(`Tariffs loaded from ${f.name}: ${listNames(r.tariffs.map((t) => t.tariff))}. ${r.notes.join(' ')}`.trim());
      } catch (e) {
        errors.push(e.message);
      }
    }
    const meter = ok.filter((f) => !tariffFiles.includes(f));
    // Adding to the sample data would mix it with real readings, so that replaces it instead.
    const adding = mode === 'add' && state.rec && !state.rec.files.every((f) => f.sample);
    const base = adding ? state.rec.files : [];
    const fresh = [], already = [];
    for (const f of meter) {
      if (base.concat(fresh).some((b) => b.text === f.text)) already.push(f.name);
      else fresh.push({name: f.name, text: f.text, size: f.size});
    }
    if (already.length) info.push(`${listNames(already)} ${already.length > 1 ? 'are' : 'is'} already open.`);

    if (fresh.length) {
      const before = adding ? state.merged.halfHours : 0;
      const rec = {files: base.concat(fresh), order: state.rec ? state.rec.order : 'dmy', savedAt: Date.now()};
      const res = useRecord(rec, !adding);
      errors.push(...res.errors);
      if (res.rec) {
        saveOrWarn('intervals', res.rec);
        const added = res.rec.files.filter((f) => fresh.includes(f));
        if (added.length && (adding || added.length > 1)) {
          const got = res.merged.halfHours - before;
          const theirs = d3.sum(res.merged.files.filter((f) => added.some((x) => x.name === f.name)), (f) => f.halfHours);
          const overlap = Math.max(0, theirs - got);
          info.unshift(`${adding ? 'Added' : 'Opened'} ${listNames(added.map((f) => f.name))}: ${count(got)} ${adding ? 'new ' : ''}readings`
            + `${overlap ? `, plus ${count(overlap)} already ${adding ? 'open' : 'in another file'} that ${overlap === 1 ? 'is' : 'are'} only counted once` : ''}.`);
        }
      }
    }
    if (errors.length) {
      const leftOut = errors.length > 1 ? 'Those files were left out.' : 'That file was left out.';
      message('error', `${errors.join(' ')}${state.rec ? ` ${leftOut}` : ''} ${info.join(' ')}`.trim());
    } else if (info.length) {
      message('info', info.join(' '));
    } else {
      clearMessages();
    }
  }

  function removeFile(i) {
    const f = state.rec.files[i];
    const rec = Object.assign({}, state.rec, {files: state.rec.files.filter((_, j) => j !== i)});
    const res = useRecord(rec, false);
    if (res.rec) {
      saveOrWarn('intervals', res.rec);
      message('info', `${f.name} was removed.`);
    }
  }

  // The sample readings (data/sample-interval-data.csv, copied into js/sample-data.js by
  // stamp_version.py) are loaded only when asked for. A script tag works offline and
  // from disk, where fetch() can't (and the page's CSP blocks it).
  function loadSample() {
    if (window.SYNERGY_TOOL_SAMPLE) return Promise.resolve(window.SYNERGY_TOOL_SAMPLE);
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'js/sample-data.js';
      tag.onload = () => (window.SYNERGY_TOOL_SAMPLE ? resolve(window.SYNERGY_TOOL_SAMPLE) : reject(new Error('it was empty')));
      tag.onerror = () => { tag.remove(); reject(new Error('js/sample-data.js didn’t load')); };
      document.head.append(tag);
    });
  }
  async function openSample() {
    try {
      const smp = await loadSample();
      const res = useRecord({files: [{name: smp.name, text: smp.text, size: smp.text.length, sample: true}], order: 'dmy', savedAt: Date.now()}, true);
      if (res.errors.length) message('error', res.errors.join(' '));
      if (res.rec) { clearMessages(); saveOrWarn('intervals', res.rec); }
    } catch (e) {
      message('error', `The sample data couldn’t be opened (${e.message}).`);
    }
  }
  async function downloadSample() {
    try {
      const smp = await loadSample();
      downloadText(smp.name, smp.text);
    } catch (e) {
      message('error', `The sample data couldn’t be downloaded (${e.message}).`);
    }
  }

  async function forgetData() {
    if (!window.confirm('Remove the meter readings kept in this browser? Your tariffs stay.')) return;
    await store.del('intervals');
    state.rec = null;
    state.merged = null;
    dash.forgetParams();
    pushSources();
    show('welcome');
    message('info', 'The readings have been removed from this browser.');
  }

  /* ------------------------------------------------------------ tariff editor */

  const dialog = () => $('#tariff-dialog');

  function tariffCard(t, i) {
    const card = $('#tariff-card').content.firstElementChild.cloneNode(true);
    card.querySelector('legend').textContent = `Tariff ${i + 1}`;
    card.querySelector('[name="tariff"]').value = t.tariff;
    const radio = card.querySelector('[name="current"]');
    radio.checked = !!t.current;
    for (const {col} of RATE_COLUMNS) card.querySelector(`[data-col="${col}"]`).value = t[col] || '';
    // Give every input an id so the labels and error messages can point at it.
    card.querySelectorAll('input').forEach((input) => {
      const key = input.name === 'current' ? 'current' : input.dataset.col || 'name';
      input.id = `tariff-${i}-${key}`;
    });
    card.querySelector('.app-remove').setAttribute('aria-label', `Remove ${t.tariff || `tariff ${i + 1}`}`);
    return card;
  }

  function renderTariffCards(list) {
    const box = $('#tariff-list');
    box.replaceChildren(...list.map(tariffCard));
    syncTariffCards();
  }

  function syncTariffCards() {
    const cards = [...document.querySelectorAll('#tariff-list .app-tariff')];
    cards.forEach((c, i) => {
      c.querySelector('legend').textContent = `Tariff ${i + 1}`;
      c.querySelector('.app-remove').disabled = cards.length < 2;
    });
    if (cards.length && !cards.some((c) => c.querySelector('[name="current"]').checked)) {
      cards[0].querySelector('[name="current"]').checked = true;
    }
  }

  function tariffStatus(kind, text) {
    const p = $('#tariff-status');
    p.textContent = text || '';
    p.className = kind === 'error' ? 'app-error' : 'app-hint';
    p.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    p.hidden = !text;
  }

  // Reads the editor; returns {list} or {error, input}.
  function collectTariffs() {
    document.querySelectorAll('#tariff-list [aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const list = [];
    const names = new Map();
    for (const card of document.querySelectorAll('#tariff-list .app-tariff')) {
      const nameInput = card.querySelector('[name="tariff"]');
      const name = nameInput.value.trim();
      if (!name) return {error: 'Give each tariff a name.', input: nameInput};
      if (names.has(name.toLowerCase())) return {error: `Two tariffs are called “${name}”. Give them different names.`, input: nameInput};
      names.set(name.toLowerCase(), true);
      const t = {tariff: name, current: card.querySelector('[name="current"]').checked};
      for (const {col, label} of RATE_COLUMNS) {
        const input = card.querySelector(`[data-col="${col}"]`);
        const v = input.value.trim().replace(/^0+(?=\d)/, '');
        if (v === '') return {error: `Fill in the ${label} for “${name}”.`, input};
        if (!isAmount(v)) return {error: `The ${label} for “${name}” should be a number of cents, like 24.3431.`, input};
        t[col] = v;
      }
      list.push(t);
    }
    if (!list.length) return {error: 'Add at least one tariff.', input: $('#tariff-add')};
    return {list};
  }

  function checkedTariffs() {
    const r = collectTariffs();
    if (r.error) {
      if (r.input.tagName === 'INPUT') r.input.setAttribute('aria-invalid', 'true');
      tariffStatus('error', r.error);
      r.input.focus();
      return null;
    }
    return r.list;
  }

  function openTariffs() {
    renderTariffCards(state.tariffs);
    tariffStatus('', '');
    dialog().showModal();
  }

  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], {type: 'text/csv'}));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wireTariffs() {
    $('#app-tariffs-btn').addEventListener('click', openTariffs);
    dialog().querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog().close()));
    $('#tariff-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const list = checkedTariffs();
      if (!list) return;
      setTariffs(tariffsToCsv(list), 'The tariff list', true);
      dialog().close();
      message('info', 'Tariffs saved.');
    });
    $('#tariff-add').addEventListener('click', () => {
      const box = $('#tariff-list');
      const card = tariffCard({tariff: '', current: false}, box.children.length);
      box.append(card);
      syncTariffCards();
      card.querySelector('[name="tariff"]').focus();
    });
    $('#tariff-list').addEventListener('click', (e) => {
      const b = e.target.closest('.app-remove');
      if (!b) return;
      const card = b.closest('.app-tariff');
      const next = card.nextElementSibling || card.previousElementSibling;
      card.remove();
      syncTariffCards();
      if (next) next.querySelector('[name="tariff"]').focus();
    });
    $('#tariff-list').addEventListener('input', (e) => {
      e.target.removeAttribute('aria-invalid');
      if (e.target.name === 'tariff') {
        const card = e.target.closest('.app-tariff');
        card.querySelector('.app-remove').setAttribute('aria-label', `Remove ${e.target.value.trim() || 'this tariff'}`);
      }
    });
    $('#tariff-import').addEventListener('click', () => $('#tariff-file').click());
    $('#tariff-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const r = readTariffs(await file.text(), file.name);
        renderTariffCards(r.tariffs);
        tariffStatus('info', `${r.tariffs.length} tariff${r.tariffs.length > 1 ? 's' : ''} from ${file.name}. ${r.notes.join(' ')} Save to use them.`.replace(/\s+/g, ' '));
      } catch (err) {
        tariffStatus('error', err instanceof InputError ? err.message : `${file.name} couldn’t be read.`);
      }
    });
    $('#tariff-export').addEventListener('click', () => {
      const list = checkedTariffs();
      if (list) downloadText('tariffs.csv', tariffsToCsv(list));
    });
    $('#tariff-reset').addEventListener('click', () => {
      renderTariffCards(readTariffs(DEFAULT_TARIFFS, 'tariffs.csv').tariffs);
      tariffStatus('info', 'The default tariffs are back in the list. Save to use them.');
    });
  }

  /* ------------------------------------------------------------ opening files */

  function wireFiles() {
    const input = $('#app-file');
    let mode = 'replace';
    const pick = (m) => { mode = m; input.click(); };
    document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => pick('replace')));
    $('#app-add').addEventListener('click', () => pick('add'));
    input.addEventListener('change', () => {
      const files = [...input.files];
      const m = mode;
      mode = 'replace';
      input.value = '';
      openFiles(files, m);
    });
    // Drop files anywhere on the page: they open, or are added to what's open.
    const overlay = $('#app-drop');
    let depth = 0;
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || dialog().open) return;
      depth += 1;
      overlay.querySelector('p').textContent = state.rec ? 'Drop CSV files to add them to the readings' : 'Drop CSV files to open them';
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dialog().open ? 'none' : 'copy';
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      if (dialog().open) return;
      if ($('#help-dialog').open) $('#help-dialog').close();
      openFiles([...e.dataTransfer.files], state.rec ? 'add' : 'replace');
    });
    $('#app-order').addEventListener('change', (e) => {
      const res = useRecord(Object.assign({}, state.rec, {order: e.target.value}), true);
      if (res.rec) saveOrWarn('intervals', res.rec);
    });
    $('#app-forget').addEventListener('click', forgetData);
    $('#app-sample').addEventListener('click', openSample);
    $('#app-sample-download').addEventListener('click', downloadSample);
    // The Synergy download steps from the first page, in a dialog for later exports.
    const help = $('#help-dialog');
    $('#app-help').addEventListener('click', () => {
      const box = $('#help-steps');
      if (!box.firstChild) {
        const steps = $('#synergy-steps').cloneNode(true);
        steps.removeAttribute('id');
        steps.removeAttribute('aria-labelledby');
        steps.querySelector('h2').removeAttribute('id');
        steps.querySelector('[data-step="open"]').replaceChildren('Add the CSV here: drop it on this page, or use ', Object.assign(document.createElement('b'), {textContent: 'Add CSV files…'}), ' above the dashboard. Readings you already have stay, and overlaps are only counted once.');
        steps.querySelector('.app-hint').replaceChildren('Synergy exports up to 90 days at a time. For a longer period, export each 90 days and add all the files.');
        box.append(steps);
      }
      help.showModal();
    });
    help.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => help.close()));
  }

  /* ------------------------------------------------------------ offline + install */

  function wireOffline() {
    const status = $('#app-offline');
    if (location.protocol === 'file:') {
      status.textContent = 'Opened from a file on this computer, so it needs no internet.';
      return;
    }
    if (!('serviceWorker' in navigator)) {
      status.textContent = window.isSecureContext ? '' : 'It isn’t served over https, so it can’t save itself for offline use.';
      return;
    }
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated' && hadController) {
            message('info', 'A new version of the app has been downloaded.', {label: 'Reload', fn: () => window.location.reload()});
          }
        });
      });
    }).catch((e) => {
      console.warn('Service worker:', e);
      status.textContent = 'This browser didn’t let it save itself for offline use.';
    });
    navigator.serviceWorker.ready.then(() => {
      status.textContent = 'The app is saved on this device and works offline.';
    });

    let deferred = null;
    const btn = $('#app-install');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      btn.hidden = false;
    });
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch { /* dismissed */ }
      deferred = null;
      btn.hidden = true;
    });
    window.addEventListener('appinstalled', () => { btn.hidden = true; });
  }

  /* ------------------------------------------------------------ theme */

  // Light or dark: follows the system until the button picks one, which is remembered.
  function wireTheme() {
    const btn = $('#app-theme');
    const root = document.documentElement;
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const current = () => root.dataset.theme || (system.matches ? 'dark' : 'light');
    const sync = () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', `Switch to ${next} theme`);
      btn.title = `Switch to ${next} theme`;
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
        if (root.dataset.theme) m.setAttribute('content', root.dataset.theme === 'dark' ? '#14161b' : '#ffffff');
      });
    };
    btn.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('synergy-tool-theme', next); } catch { /* storage blocked */ }
      sync();
      dash.redraw();
    });
    system.addEventListener('change', () => { sync(); if (!root.dataset.theme) dash.redraw(); });
    sync();
  }

  /* ------------------------------------------------------------ start */

  async function start() {
    if (!window.d3 || !window.dash || !dash.start || DEFAULT_TARIFFS == null) {
      $('#app-boot-error').hidden = false;
      return;
    }
    wireFiles();
    wireTariffs();
    wireOffline();
    wireTheme();
    dash.start();

    const [savedTariffs, savedFile, savedBase] = await Promise.all([store.get('tariffs'), store.get('intervals'), store.get('tariffsBase')]);
    const canon = (text) => { try { return tariffsToCsv(readTariffs(text, 'tariffs').tariffs); } catch { return null; } };
    let useSaved = typeof savedTariffs === 'string';
    if (useSaved && typeof savedBase === 'string' && savedBase !== DEFAULT_TARIFFS) {
      // data/tariffs.csv has changed since this browser's tariff list was saved.
      if (canon(savedTariffs) === canon(savedBase)) {
        useSaved = false;   // the list was just the old defaults, so take the new ones
        store.del('tariffs');
        store.del('tariffsBase');
      } else {
        store.set('tariffsBase', DEFAULT_TARIFFS);   // say so once
        message('info', 'The app’s default tariffs have been updated since you changed your tariff list. Your list is still used; Restore defaults, under Tariffs, shows the new ones.');
      }
    }
    try {
      setTariffs(useSaved ? savedTariffs : DEFAULT_TARIFFS, useSaved ? 'The saved tariffs' : 'tariffs.csv', false);
    } catch (e) {
      if (useSaved) {
        setTariffs(DEFAULT_TARIFFS, 'tariffs.csv', false);
        message('error', `${e.message} The default tariffs are used instead.`);
      } else {
        message('error', `The default tariffs couldn’t be read: ${e.message} Add your tariffs under Tariffs.`);
      }
    }
    const names = (() => { try { return readTariffs(DEFAULT_TARIFFS, 'tariffs.csv').tariffs.map((t) => t.tariff); } catch { return []; } })();
    document.querySelectorAll('[data-app="default-tariffs"]').forEach((el) => { el.textContent = names.length ? listNames(names) : 'no'; });
    const rec = asRecord(savedFile);
    if (rec) {
      const res = useRecord(rec, false);
      if (res.errors.length) message('error', res.errors.join(' '));
      if (res.rec) return;
    }
    show('welcome');
  }

  // For scripting and tests: open Files (or {name, text} objects) as if they were chosen.
  const asFile = (f) => (f instanceof Blob ? f : new File([f.text], f.name, {type: 'text/csv'}));
  window.synergyTool = {
    open: (files) => openFiles([].concat(files).map(asFile), 'replace'),
    add: (files) => openFiles([].concat(files).map(asFile), 'add'),
    parseIntervals,
    mergeIntervals,
    readTariffs,
  };

  start().catch((e) => {
    console.error(e);
    message('error', `The app didn’t start properly (${e.message}).`);
  });
})();
