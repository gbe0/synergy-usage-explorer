/*
 * readers.js - reads the meter interval CSVs and the tariffs CSV, checking
 * them as it goes. app.js uses these in the page and the tests load this
 * file in Node, so both use the one parser. Nothing here touches the page.
 *
 * stamp_version.py has a Python copy of csvRows, readTariffs and the checks
 * in parseIntervals, for public/data/. Change both together; the tests in
 * tests/readers.test.js run the same files through each and compare.
 */
(function () {
  'use strict';

  const KWH_COLUMNS = ['PEAK (KWH)', 'OFF PEAK (KWH)', 'SUPER OFF PEAK (KWH)'];
  // Needed in every row of a tariffs CSV, in cents.
  const RATE_COLUMNS = [
    {col: 'supply_cents_per_day', label: 'supply charge'},
    {col: 'peak_cents_per_kwh', label: 'peak rate'},
    {col: 'off_peak_cents_per_kwh', label: 'off-peak rate'},
    {col: 'super_off_peak_cents_per_kwh', label: 'super off-peak rate'},
  ];
  // Optional: a daily credit such as a concession, in cents; blank is none.
  const CREDIT_COLUMN = {col: 'credit_cents_per_day', label: 'daily credit'};
  const TARIFF_COLUMNS = ['tariff', 'current', ...RATE_COLUMNS.map((r) => r.col)];   // must be there
  const TARIFF_CSV_COLUMNS = ['tariff', 'current', 'from', ...RATE_COLUMNS.map((r) => r.col), CREDIT_COLUMN.col];   // as written
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const pad2 = (n) => String(n).padStart(2, '0');
  const niceDate = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  const count = (n) => n.toLocaleString('en');
  const listNames = (names) => (names.length < 2 ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

  // A problem with a file the visitor opened, worded for them.
  class InputError extends Error {}

  /* ------------------------------------------------------------ CSV */

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

  /* ------------------------------------------------------------ dates */

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
  // "2026-09-01", or null when there is no such day. Plain arithmetic rather
  // than Date, whose years 0-99 mean 1900-1999, so stamp_version.py can match it.
  function isoDate(y, month, day) {
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!days || day < 1 || day > days) return null;
    return `${String(y).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  }

  /* ------------------------------------------------------------ meter readings */

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

  /* ------------------------------------------------------------ tariffs */

  // ASCII digits only: other scripts' digits would read as a different number, or none.
  const isAmount = (v) => /^([0-9]+\.?[0-9]*|\.[0-9]+)$/.test(v);

  // A rate period's start: "2025-07-01", or "1/07/2025" (day first, as Excel
  // saves dates in Australia). Returns YYYY-MM-DD, '' for blank, null for no such day.
  function tariffDate(text) {
    if (text === '') return '';
    let m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/.exec(text);
    if (m) return isoDate(+m[1], +m[2], +m[3]);
    m = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/.exec(text);
    return m ? isoDate(+m[3], +m[2], +m[1]) : null;
  }
  const looksLikeDate = (text) => /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$|^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}$/.test(text);

  /*
   * Checks a tariffs CSV. A tariff can have several rows, one per rate period:
   * `from` is the date its rates start, and they last until the tariff's next
   * `from`; blank means since the beginning. Returns {tariffs: [{tariff,
   * current, rates: [{from, <rate columns>, credit_cents_per_day}]}], notes},
   * values as text, rates in date order.
   */
  function readTariffs(text, name) {
    const rows = csvRows(text);
    if (!rows.length) throw new InputError(`${name} is empty.`);
    const head = rows[0].cells.map((h) => h.toLowerCase());
    const missing = TARIFF_COLUMNS.filter((c) => !head.includes(c));
    if (missing.length) throw new InputError(`${name} has no ${missing.join(', ')} column.`);
    const tariffs = [];
    const byName = new Map();
    for (const r of rows.slice(1)) {
      const get = (c) => r.cells[head.indexOf(c)] || '';
      const tariff = get('tariff');
      if (!tariff) continue;
      const at = `${name}, line ${r.line}:`;
      const from = tariffDate(get('from'));
      if (from == null) {
        throw new InputError(`${at} the from date for “${tariff}” is “${get('from')}”, `
          + (looksLikeDate(get('from')) ? 'which isn’t a real date.' : 'not a date like 2025-07-01 or 1/07/2025.'));
      }
      let t = byName.get(tariff.toLowerCase());
      if (!t) {
        t = {tariff, current: false, rates: []};
        byName.set(tariff.toLowerCase(), t);
        tariffs.push(t);
      }
      if (t.rates.some((x) => x.from === from)) {
        throw new InputError(from ? `${at} “${tariff}” is listed twice for the same date, ${niceDate(from)}.`
          : `${at} “${tariff}” is listed twice with no from date. Only one of its rows can leave from blank; give the others the date their rates start.`);
      }
      const rate = {from};
      for (const {col, label} of RATE_COLUMNS) {
        const v = get(col);
        if (!isAmount(v)) throw new InputError(`${at} the ${label} for “${tariff}” (${col}) is “${v}”, not a number of cents.`);
        rate[col] = v;
      }
      const credit = get(CREDIT_COLUMN.col);
      if (credit !== '' && !isAmount(credit)) {
        throw new InputError(`${at} the ${CREDIT_COLUMN.label} for “${tariff}” (${CREDIT_COLUMN.col}) is “${credit}”, not a number of cents. Leave it blank for none.`);
      }
      rate[CREDIT_COLUMN.col] = credit || '0';
      t.rates.push(rate);
      if (get('current').toLowerCase() === 'yes') t.current = true;
    }
    if (!tariffs.length) throw new InputError(`${name} lists no tariffs.`);
    for (const t of tariffs) t.rates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));   // blank first
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

  // The tariff list as CSV: one row per tariff per rate period, in the order given.
  const tariffsToCsv = (list) => [TARIFF_CSV_COLUMNS.join(',')]
    .concat(list.flatMap((t) => t.rates.map((p) => [
      csvCell(t.tariff), t.current ? 'yes' : 'no', p.from || '',
      ...RATE_COLUMNS.map((r) => p[r.col]), p[CREDIT_COLUMN.col] || '0',
    ].join(','))))
    .join('\n') + '\n';

  const looksLikeTariffs = (text) => {
    const first = csvRows(String(text).slice(0, 2000))[0];
    return !!first && first.cells.some((c) => c.toLowerCase() === 'supply_cents_per_day');
  };

  window.SynergyReaders = {
    KWH_COLUMNS, RATE_COLUMNS, CREDIT_COLUMN, TARIFF_COLUMNS, TARIFF_CSV_COLUMNS,
    InputError, csvRows, csvCell, dateParts, isoDate, niceDate, listNames,
    parseIntervals, findGaps, describeGap, mergeIntervals,
    isAmount, tariffDate, readTariffs, tariffsToCsv, looksLikeTariffs,
  };
})();
