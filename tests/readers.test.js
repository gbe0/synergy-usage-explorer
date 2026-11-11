/*
 * readers.test.js - checks the CSV readers in public/js/readers.js, and that
 * stamp_version.py's Python copy of them accepts and rejects the same files,
 * at the same line. Also stamps temporary copies of public/ to check that
 * line endings don't change VERSION and that odd file names still give a
 * working sw.js. Run with `npm test`; needs python3.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {loadReaders, plain, ROOT, PUBLIC} = require('./load-readers.js');

const R = loadReaders();
const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0), NEL = ch(0x85), BOM = ch(0xfeff);

const IH = 'Date,Time,PEAK (KWH),OFF PEAK (KWH),SUPER OFF PEAK (KWH),Billing Status';
const TH = 'tariff,current,from,supply_cents_per_day,peak_cents_per_kwh,off_peak_cents_per_kwh,super_off_peak_cents_per_kwh,credit_cents_per_day';
const OLD = 'tariff,current,supply_cents_per_day,peak_cents_per_kwh,off_peak_cents_per_kwh,super_off_peak_cents_per_kwh';
const HALF_HOURS = Array.from({length: 48}, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

// A day of off-peak readings, one per half-hour from `from` up to (not including) `to`.
const day = (date, kWh, status = 'Billed', from = 0, to = 48) =>
  HALF_HOURS.slice(from, to).map((t) => `${date},${t},,${kWh},,${status}`);
const meter = (...rows) => [IH, ...rows.flat()].join('\n') + '\n';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synergy-readers-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const python = (args, cwd = ROOT) => spawnSync('python3', args, {cwd, encoding: 'utf8'});

/* ------------------------------------------------------------ parseIntervals */

test('parseIntervals reads the sample readings', () => {
  const text = fs.readFileSync(path.join(PUBLIC, 'data', 'sample-interval-data.csv'), 'utf8');
  const p = R.parseIntervals(text, 'dmy', 'sample.csv');
  assert.equal(p.rows.length, text.trim().split(/\r?\n/).length - 1);
  assert.deepEqual([p.order, p.ambiguous, p.hasStatus, p.repeatedHeaders], ['dmy', false, true, 0]);
  assert.deepEqual(plain(p.rows[0]), {date: '2025-07-01', time: '00:00', values: ['', '1.253', ''], status: 'Billed'});
});

test('parseIntervals works out the date order, and asks when it can’t', () => {
  const mdy = R.parseIntervals(meter(day('07/13/2025', 1, 'Billed', 0, 1)), 'dmy', 'a.csv');
  assert.equal(mdy.rows[0].date, '2025-07-13');
  assert.equal(mdy.order, 'mdy');
  const either = meter(day('03/04/2025', 1, 'Billed', 0, 1));
  assert.equal(R.parseIntervals(either, 'dmy', 'a.csv').rows[0].date, '2025-04-03');
  assert.equal(R.parseIntervals(either, 'mdy', 'a.csv').rows[0].date, '2025-03-04');
  assert.equal(R.parseIntervals(either, 'dmy', 'a.csv').ambiguous, true);
  const iso = R.parseIntervals(meter(['2025-07-01T00:00,0:30,+.5,,,Billed', '1.7.25,23:30:00,,1e-3,-0.2,']), 'dmy', 'a.csv');
  assert.deepEqual(plain(iso.rows.map((r) => [r.date, r.time, r.values])), [
    ['2025-07-01', '00:30', ['0.5', '', '']],
    ['2025-07-01', '23:30', ['', '0.001', '-0.2']],
  ]);
});

test('parseIntervals skips repeated headers and reads files with no Billing Status', () => {
  const p = R.parseIntervals(['Date,Time,PEAK (KWH),OFF PEAK (KWH),SUPER OFF PEAK (KWH)', '01/07/2025,00:00,,1,',
    'Date,Time,PEAK (KWH),OFF PEAK (KWH),SUPER OFF PEAK (KWH)', '01/07/2025,00:30,,2,'].join('\r\n'), 'dmy', 'a.csv');
  assert.equal(p.repeatedHeaders, 1);
  assert.equal(p.hasStatus, false);
  assert.deepEqual(plain(p.rows.map((r) => r.status)), ['Billed', 'Billed']);
});

test('parseIntervals says what is wrong, and where', () => {
  const bad = (text, re) => assert.throws(() => R.parseIntervals(text, 'dmy', 'a.csv'), (e) => e instanceof R.InputError && re.test(e.message));
  bad('', /^a\.csv is empty\.$/);
  bad('Date,Time\n01/07/2025,00:00\n', /no PEAK \(KWH\), OFF PEAK \(KWH\), SUPER OFF PEAK \(KWH\) column\. Its columns are: Date, Time\./);
  bad(IH + '\n', /has a header row but no readings/);
  bad(meter('01/07/2025,00:00,,1,,Billed', 'July 1,00:30,,1,,Billed'), /line 3: "July 1" is not a date/);
  bad(meter('31/06/2025,00:00,,1,,Billed'), /line 2: "31\/06\/2025" is not a real date when read as day\/month/);
  bad(meter('13/07/2025,00:00,,1,,', '07/13/2025,00:30,,1,,'), /mix day\/month and month\/day/);
  bad(meter('01/07/2025,24:00,,1,,'), /line 2: "24:00" is not a time like 13:30/);
  bad(meter('01/07/2025,00:00,,1.2.3,,'), /line 2: "1\.2\.3" under OFF PEAK \(KWH\) is not a number of kWh/);
  bad(meter('01/07/2025,00:00,,,,'), /has no kWh readings/);
});

/* ------------------------------------------------------------ mergeIntervals */

const merge = (...texts) => R.mergeIntervals(texts.map((t, i) => R.parseIntervals(t, 'dmy', `f${i + 1}.csv`)));
const valuesAt = (m) => new Map(m.csv.trim().split('\n').slice(1).map((l) => l.split(',')).map((c) => [`${c[0]} ${c[1]}`, c[3]]));

test('mergeIntervals counts overlapping half-hours once, from the file that runs latest', () => {
  const a = meter(day('01/07/2025', 1));
  const b = meter(day('01/07/2025', 2, 'Billed', 24), day('02/07/2025', 2));
  for (const m of [merge(a, b), merge(b, a)]) {
    assert.deepEqual([m.halfHours, m.days, m.overlaps, m.differing, m.missing], [96, 2, 24, 24, 0]);
    const v = valuesAt(m);
    assert.equal(v.get('01/07/2025 11:30'), '1');
    assert.equal(v.get('01/07/2025 12:00'), '2');
    assert.match(m.notes.join(' '), /24 half-hours appear more than once across the files and are counted once\. 24 of them have different readings/);
  }
  assert.deepEqual(plain(merge(a, b).files.map((f) => [f.name, f.halfHours, f.first, f.last])),
    [['f1.csv', 48, '2025-07-01', '2025-07-01'], ['f2.csv', 72, '2025-07-01', '2025-07-02']]);
});

test('mergeIntervals keeps a billed reading over one not yet billed', () => {
  const billed = meter(day('01/07/2025', 1));
  const later = meter(day('01/07/2025', 2, 'Not billed'), day('02/07/2025', 2, 'Not billed'));
  for (const m of [merge(billed, later), merge(later, billed)]) {
    const v = valuesAt(m);
    assert.equal(v.get('01/07/2025 13:00'), '1');
    assert.equal(v.get('02/07/2025 13:00'), '2');
  }
});

test('mergeIntervals takes the later row within one file, and lists gaps', () => {
  const m = merge(meter(day('01/07/2025', 1, 'Billed', 0, 26), '01/07/2025,00:00,,5,,Billed', day('01/07/2025', 1, 'Billed', 27)));
  assert.equal(valuesAt(m).get('01/07/2025 00:00'), '5');
  assert.deepEqual([m.halfHours, m.overlaps, m.missing, m.gaps], [47, 1, 1, 1]);
  assert.match(m.notes[0], /^1 half-hour is missing between the first and last day, in 1 gap: Tue 1 Jul 2025, 13:00–13:30\./);
  assert.match(merge(meter(day('01/07/2025', 1), day('04/07/2025', 1))).notes[0], /Wed 2 Jul 2025 – Thu 3 Jul 2025 \(2 whole days\)/);
});

/* ------------------------------------------------------------ readTariffs */

const tariffs = (...rows) => [TH, ...rows].join('\n') + '\n';
const rate = (from, s, p, o, so, credit = '0') => ({
  from, supply_cents_per_day: s, peak_cents_per_kwh: p, off_peak_cents_per_kwh: o, super_off_peak_cents_per_kwh: so, credit_cents_per_day: credit,
});

test('readTariffs reads rate periods by date, with a daily credit', () => {
  const r = R.readTariffs(tariffs(
    'Midday Saver,no,2026-07-01,140,58,25,9,',
    'Home Plan,no,,119,33,33,33,',
    'midday saver,yes,1/07/2025,132.7806,55.3253,24.3431,8.8520,150.5',
    'Midday Saver,no,,120,50,22,8,0',
  ), 'tariffs.csv');
  assert.deepEqual(plain(r), {
    tariffs: [
      {tariff: 'Midday Saver', current: true, rates: [
        rate('', '120', '50', '22', '8'),
        rate('2025-07-01', '132.7806', '55.3253', '24.3431', '8.8520', '150.5'),
        rate('2026-07-01', '140', '58', '25', '9'),
      ]},
      {tariff: 'Home Plan', current: false, rates: [rate('', '119', '33', '33', '33')]},
    ],
    notes: [],
  });
});

test('readTariffs still reads the old layout, with columns in any order', () => {
  const r = R.readTariffs(`${OLD}\nSynergy Midday Saver,yes,132.7806,55.3253,24.3431,8.8520\nHome Plan,no,119.2419,33.2621,33.2621,33.2621\n`, 't.csv');
  assert.deepEqual(plain(r.tariffs.map((t) => [t.tariff, t.current, t.rates])), [
    ['Synergy Midday Saver', true, [rate('', '132.7806', '55.3253', '24.3431', '8.8520')]],
    ['Home Plan', false, [rate('', '119.2419', '33.2621', '33.2621', '33.2621')]],
  ]);
  const odd = R.readTariffs('Super_Off_Peak_Cents_Per_Kwh,TARIFF,Off_Peak_Cents_Per_Kwh,Current,Peak_Cents_Per_Kwh,Supply_Cents_Per_Day\n8,A,24,YES,55,132\n', 't.csv');
  assert.deepEqual(plain(odd.tariffs), [{tariff: 'A', current: true, rates: [rate('', '132', '55', '24', '8')]}]);
});

test('readTariffs picks one current tariff, and says so', () => {
  const none = R.readTariffs(tariffs('A,no,,1,2,3,4,', 'B,,,1,2,3,4,'), 't.csv');
  assert.deepEqual(plain(none.tariffs.map((t) => t.current)), [true, false]);
  assert.deepEqual(plain(none.notes), ['No tariff was marked current, so “A” is treated as current.']);
  const two = R.readTariffs(tariffs('A,no,,1,2,3,4,', 'B,yes,,1,2,3,4,', 'C,Yes,,1,2,3,4,'), 't.csv');
  assert.deepEqual(plain(two.tariffs.map((t) => t.current)), [false, true, false]);
  assert.deepEqual(plain(two.notes), ['More than one tariff was marked current; “B” is used.']);
});

test('readTariffs says what is wrong, and where', () => {
  const bad = (text, re) => assert.throws(() => R.readTariffs(text, 't.csv'), (e) => e instanceof R.InputError && re.test(e.message), re.source);
  bad('', /^t\.csv is empty\.$/);
  bad('tariff,current,supply_cents_per_day\nA,yes,1\n', /^t\.csv has no peak_cents_per_kwh, off_peak_cents_per_kwh, super_off_peak_cents_per_kwh column\.$/);
  bad(tariffs(',yes,,1,2,3,4,'), /^t\.csv lists no tariffs\.$/);
  bad(tariffs('A,yes,2025-02-29,1,2,3,4,'), /^t\.csv, line 2: the from date for “A” is “2025-02-29”, which isn’t a real date\.$/);
  bad(tariffs('A,yes,31/6/2025,1,2,3,4,'), /line 2: .*which isn’t a real date/);
  bad(tariffs('A,yes,01-07-2025,1,2,3,4,'), /line 2: the from date for “A” is “01-07-2025”, not a date like 2025-07-01 or 1\/07\/2025\.$/);
  bad(tariffs('A,yes,2025-07-01,1,2,3,4,', 'a,no,1/7/2025,1,2,3,4,'), /^t\.csv, line 3: “a” is listed twice for the same date, 1 Jul 2025\.$/);
  bad(`${OLD}\nA,yes,1,2,3,4\nA,no,1,2,3,4\n`, /^t\.csv, line 3: “A” is listed twice with no from date\./);
  bad(tariffs('A,yes,,1,2,3,,'), /^t\.csv, line 2: the super off-peak rate for “A” \(super_off_peak_cents_per_kwh\) is “”, not a number of cents\.$/);
  bad(tariffs(`A,yes,,${ch(0x661, 0x663, 0x662)},2,3,4,`), /line 2: the supply charge for “A”/);
  bad(tariffs('A,yes,,1,-2,3,4,'), /line 2: the peak rate for “A”/);
  bad(tariffs('A,yes,,1,2,3,4,abc'), /^t\.csv, line 2: the daily credit for “A” \(credit_cents_per_day\) is “abc”, not a number of cents\. Leave it blank for none\.$/);
});

test('tariffsToCsv writes every rate period, and reads back the same', () => {
  const r = R.readTariffs(tariffs('"Home ""Plan"", v2",no,,119,33,33,33,', 'B,yes,1/07/2025,1,2,3,4,50', 'B,no,,1,2,3,4,'), 't.csv');
  const csv = R.tariffsToCsv(r.tariffs);
  assert.equal(csv, [
    TH,
    '"Home ""Plan"", v2",no,,119,33,33,33,0',
    'B,yes,,1,2,3,4,0',
    'B,yes,2025-07-01,1,2,3,4,50',
  ].join('\n') + '\n');
  assert.deepEqual(plain(R.readTariffs(csv, 't.csv')), plain(r));
  assert.ok(R.looksLikeTariffs(csv));
  assert.ok(!R.looksLikeTariffs(meter(day('01/07/2025', 1))));
});

/* ------------------------------------------------------------ the Python copy */

// Each runs through readTariffs and `stamp_version.py --check-tariffs`. ok and
// line are what both should say: line is where the first problem is, if any.
const DEFAULTS = fs.readFileSync(path.join(PUBLIC, 'data', 'tariffs.csv'), 'utf8');
const TARIFF_CORPUS = [
  {name: 'the default tariffs', text: DEFAULTS, ok: true},
  {name: 'the old layout', text: `${OLD}\nA,yes,132.7806,55.3253,24.3431,8.8520\nB,no,119.2419,33.2621,33.2621,33.2621\n`, ok: true},
  {name: 'dated rows in both formats, with a credit', ok: true, text: tariffs(
    'A,yes,,100,50,25,10,', 'A,yes,1/07/2025,110,55,26,11,150.5', 'A,no,2026-07-01,120,60,27,12,0', 'B,no,,90,30,30,30,')},
  {name: 'columns in another order and case', ok: true,
    text: 'Super_Off_Peak_Cents_Per_Kwh,TARIFF,Off_Peak_Cents_Per_Kwh,Current,Peak_Cents_Per_Kwh,Supply_Cents_Per_Day,From\n8.8,Midday,24.3,YES,55.3,132.7,29/02/2024\n'},
  {name: 'quotes and commas in a quoted name', text: tariffs('"Home ""Plan"", v2",no,,1,2,3,4,'), ok: true},
  {name: 'a quote opening mid-field', text: tariffs('"Mid"day Saver,yes,,1,2,3,4,', 'x"y"z,no,,1,2,3,4,'), ok: true},
  {name: 'a stray quote that swallows the rest of the file', text: tariffs('Ho"me,no,,1,2,3,4,', 'Other,no,,1,2,3,4,'), ok: false, line: 2},
  {name: 'an unclosed quote on the last row', text: tariffs('A,yes,,1,2,3,4,', '"B,no,,1,2,3,4,'), ok: false, line: 3},
  {name: 'Arabic-Indic digits', text: tariffs(`A,yes,,${ch(0x661, 0x663, 0x662)},55,24,8,`), ok: false, line: 2},
  {name: 'full-width digits in the credit', text: tariffs(`A,yes,,132,55,24,8,${ch(0xff11, 0xff10)}`), ok: false, line: 2},
  {name: 'a superscript digit in a date', text: tariffs(`A,yes,2025-07-0${ch(0xb9)},1,2,3,4,`), ok: false, line: 2},
  {name: 'blank lines everywhere', text: `\n\n${TH}\n\nA,yes,,1,2,3,4,\n , ,\n\nB,no,,1,x,3,4,\n`, ok: false, line: 8},
  {name: 'a name over two lines, then a problem', text: tariffs('"Midday\nSaver",yes,,1,2,3,4,', 'B,no,,1,2,3,,'), ok: false, line: 4},
  {name: 'CRLF, with a quoted CRLF', text: `${TH}\r\n"A\r\nB",yes,,1,2,3,4,\r\nC,no,,1,2,3,-4,\r\n`, ok: false, line: 4},
  {name: 'old Mac line endings', text: `${TH}\rA,yes,,1,2,3,4,\rB,no,,1,2,3,x,\r`, ok: false, line: 3},
  {name: 'a byte order mark and non-breaking spaces', text: `${BOM}${TH}\nA,yes,, 1.5${NBSP},2,3,4,${NBSP}\n`, ok: true},
  {name: 'NEL, which JavaScript doesn’t trim', text: tariffs(`A,yes,,1.5${NEL},2,3,4,`), ok: false, line: 2},
  {name: 'the same date in both formats', text: tariffs('A,yes,2025-07-01,1,2,3,4,', 'A,yes,1/7/2025,1,2,3,4,'), ok: false, line: 3},
  {name: 'the same date twice, names in another case', text: tariffs('A,yes,2025-7-1,1,2,3,4,', 'B,no,,1,2,3,4,', 'a,no,2025-07-01,5,6,7,8,'), ok: false, line: 4},
  {name: 'two rows with no date', text: `${OLD}\nA,yes,1,2,3,4\nB,no,1,2,3,4\nA,no,1,2,3,4\n`, ok: false, line: 4},
  {name: 'no such day', text: tariffs('A,yes,29/02/2025,1,2,3,4,'), ok: false, line: 2},
  {name: 'a date in another layout', text: tariffs('A,yes,2025/07/01,1,2,3,4,'), ok: false, line: 2},
  {name: 'a missing column', text: 'tariff,current,supply_cents_per_day,peak_cents_per_kwh,off_peak_cents_per_kwh\nA,yes,1,2,3\n', ok: false},
  {name: 'an empty file', text: '\n \n,,\n', ok: false},
  {name: 'only rows with no name', text: tariffs(',yes,2025-07-01,x,x,x,x,'), ok: false},
  {name: 'extra columns and cells', text: `${TH},notes\nA,yes,,.5,2.,3,4,,hello,extra,cells\nB,no,,1,2,3,4\n`, ok: true},
  {name: 'a signed rate', text: tariffs('A,yes,,+1,2,3,4,'), ok: false, line: 2},
  {name: 'blank-named rows are skipped', text: tariffs(',yes,2025-07-01,x,x,x,x,', 'A,,,1,2,3,4,', 'B,YES,,1,2,3,4,', 'C,yes,,1,2,3,4,'), ok: true},
];

// The first problem's line and message from either side: {ok, line, message}.
function jsTariffs(text) {
  try {
    const r = R.readTariffs(text, 'tariffs.csv');
    return {ok: true, notes: plain(r.notes), tariffs: r.tariffs.length, rates: r.tariffs.reduce((n, t) => n + t.rates.length, 0)};
  } catch (e) {
    assert.ok(e instanceof R.InputError, e.stack);
    const m = /^tariffs\.csv, line (\d+): ([\s\S]*)$/.exec(e.message);
    return {ok: false, line: m ? Number(m[1]) : undefined, message: m ? m[2] : undefined};
  }
}
function pyTariffs(file) {
  const res = python(['stamp_version.py', '--check-tariffs', file]);
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /Traceback/);
  if (res.status === 0) {
    const m = /is fine: (\d+) tariffs?, (\d+) sets of rates\./.exec(res.stdout);
    const notes = res.stdout.split('\n').filter((l) => l.startsWith('note: ')).map((l) => l.slice(6));
    return {ok: true, notes, tariffs: Number(m[1]), rates: Number(m[2])};
  }
  const m = /\n {2}(?:line (\d+): )?([\s\S]*?)(?=\n {2}\S|\n$|$)/.exec(res.stdout);
  return {ok: false, line: m[1] ? Number(m[1]) : undefined, message: m[1] ? m[2] : undefined};
}

test('stamp_version.py accepts and rejects the same tariff files as the app', async (t) => {
  const dir = tmpDir(t);
  for (const [i, c] of TARIFF_CORPUS.entries()) {
    await t.test(c.name, () => {
      const file = path.join(dir, `tariffs-${i}.csv`);
      fs.writeFileSync(file, c.text, 'utf8');
      // A browser's file.text() drops a leading byte order mark, as Python's utf-8-sig does.
      const js = jsTariffs(c.text.replace(/^\uFEFF/, ''));
      assert.equal(js.ok, c.ok, `the app ${js.ok ? 'accepts' : 'rejects'} it: ${js.message || ''}`);
      assert.equal(js.line, c.line);
      assert.deepEqual(pyTariffs(file), js);
    });
  }
});

const INTERVAL_CORPUS = [
  {name: 'the sample', text: fs.readFileSync(path.join(PUBLIC, 'data', 'sample-interval-data.csv'), 'utf8'), ok: true},
  {name: 'ISO dates, times with seconds, signed and exponent kWh', ok: true,
    text: meter('2025-07-01,00:00,,+1.5,,Billed', '2025-07-01T00:30,0:30:00,1e-3,,-.2,', '1.7.25 00:00,01:00,,2.,,')},
  {name: 'a repeated header and blank lines', text: `${IH}\n\n01/07/2025,00:00,,1,,\n${IH}\n01/07/2025,00:30,,1,,\n`, ok: true},
  {name: 'dates read month first', text: meter('07/13/2025,00:00,,1,,', '07/14/2025,00:00,,1,,'), ok: true},
  {name: 'mixed date orders', text: meter('13/07/2025,00:00,,1,,', '07/13/2025,00:00,,1,,'), ok: false},
  {name: 'no such day', text: meter('01/07/2025,00:00,,1,,', '31/06/2025,00:00,,1,,'), ok: false, line: 3},
  {name: 'not a date', text: meter('01/07/2025,00:00,,1,,', `${ch(0x660, 0x661)}/07/2025,00:00,,1,,`), ok: false, line: 3},
  {name: 'not a time', text: meter('"01/07/2025",24:00,,1,,'), ok: false, line: 2},
  {name: 'not a number of kWh', text: meter('01/07/2025,00:00,,1,,', '01/07/2025,00:30,,,1.2.3,'), ok: false, line: 3},
  {name: 'a header but no readings', text: `${IH}\n`, ok: false},
  {name: 'no kWh at all', text: meter('01/07/2025,00:00,,,,'), ok: false},
  {name: 'a missing column', text: 'Date,Time,PEAK (KWH)\n01/07/2025,00:00,1\n', ok: false},
];

test('stamp_version.py checks interval files as the app does', async (t) => {
  const dir = tmpDir(t);
  for (const [i, c] of INTERVAL_CORPUS.entries()) {
    await t.test(c.name, () => {
      const file = path.join(dir, `intervals-${i}.csv`);
      fs.writeFileSync(file, c.text, 'utf8');
      let js;
      try {
        R.parseIntervals(c.text, 'dmy', file);
        js = {ok: true};
      } catch (e) {
        assert.ok(e instanceof R.InputError, e.stack);
        js = {ok: false, message: e.message};
      }
      assert.equal(js.ok, c.ok, js.message);
      if (c.line) assert.match(js.message, new RegExp(`, line ${c.line}: `));
      const res = python(['stamp_version.py', '--check-intervals', file]);
      assert.equal(res.status, c.ok ? 0 : 1, res.stdout + res.stderr);
      if (!c.ok) assert.equal(res.stdout.trim(), js.message);
    });
  }
});

/* ------------------------------------------------------------ stamping */

const TEXT = /\.(html|js|css|svg|txt|json|webmanifest|csv)$/;
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
// A copy of the project's public/ and stamp_version.py, which stamps the copy.
function copyApp(t, eol) {
  const dir = tmpDir(t);
  fs.cpSync(PUBLIC, path.join(dir, 'public'), {recursive: true});
  fs.copyFileSync(path.join(ROOT, 'stamp_version.py'), path.join(dir, 'stamp_version.py'));
  if (eol) {
    for (const file of walk(path.join(dir, 'public')).filter((f) => TEXT.test(f))) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, eol));
    }
  }
  return dir;
}
const stamp = (dir, ...args) => python(['stamp_version.py', ...args], dir);
const swOf = (dir) => fs.readFileSync(path.join(dir, 'public', 'sw.js'), 'utf8');
const versionOf = (dir) => /const VERSION = '([0-9a-f]{12})';/.exec(swOf(dir))[1];

test('CRLF and LF copies of the app stamp the same VERSION', (t) => {
  const lf = copyApp(t, '\n'), crlf = copyApp(t, '\r\n');
  // Make the script write every file it makes, to see that it writes LF even here.
  for (const dir of [lf, crlf]) {
    for (const rel of ['js/default-tariffs.js', 'js/sample-data.js']) fs.rmSync(path.join(dir, 'public', rel));
    fs.writeFileSync(path.join(dir, 'public', 'sw.js'), swOf(dir).replace(/const VERSION = '[^']*';/, "const VERSION = 'old';"));
  }
  for (const dir of [lf, crlf]) {
    const res = stamp(dir);
    assert.equal(res.status, 0, res.stderr);
    const check = stamp(dir, '--check');
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
  assert.equal(versionOf(lf), versionOf(crlf));
  for (const rel of ['sw.js', 'js/default-tariffs.js', 'js/sample-data.js']) {
    const a = fs.readFileSync(path.join(lf, 'public', rel), 'utf8');
    assert.equal(a, fs.readFileSync(path.join(crlf, 'public', rel), 'utf8'), rel);
    assert.ok(!a.includes('\r'), `${rel} has CR line endings`);
  }
});

test('odd file names still give a working sw.js', (t) => {
  const dir = copyApp(t);
  const odd = ['odd/it\'s #1 "100%" ?.js', 'odd/é [x] ^|`{}<>.txt', 'odd/back\\slash.txt', 'a:b.txt', 'help/index.html'];
  for (const rel of odd) {
    fs.mkdirSync(path.dirname(path.join(dir, 'public', rel)), {recursive: true});
    fs.writeFileSync(path.join(dir, 'public', rel), 'x');
  }
  const res = stamp(dir);
  assert.equal(res.status, 0, res.stderr);
  const sw = path.join(dir, 'public', 'sw.js');
  const syntax = spawnSync(process.execPath, ['--check', sw], {encoding: 'utf8'});
  assert.equal(syntax.status, 0, syntax.stderr);
  // FILES as the service worker sees it, and the paths a browser would fetch.
  const box = {};
  vm.runInNewContext(`${/const FILES = \[[\s\S]*?\];/.exec(swOf(dir))[0]}; this.FILES = FILES;`, box);
  const base = 'https://example.com/power/';
  const fetched = box.FILES.map((f) => decodeURIComponent(new URL(f, base).pathname.slice('/power/'.length)));
  for (const rel of odd) assert.ok(fetched.includes(rel), `${rel} isn't in FILES: ${box.FILES.join(' | ')}`);
  assert.ok(fetched.includes('js/app.js') && fetched.includes(''));
  const check = stamp(dir, '--check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('stamp_version.py explains a CSV that isn’t UTF-8, or that the app couldn’t read', (t) => {
  const dir = copyApp(t);
  const tariffsCsv = path.join(dir, 'public', 'data', 'tariffs.csv');
  fs.writeFileSync(tariffsCsv, Buffer.from(`${OLD}\nCaf\xe9 Plan,yes,1,2,3,4\n`, 'latin1'));
  let res = stamp(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tariffs\.csv isn't saved as UTF-8 text .*CSV UTF-8/);
  assert.doesNotMatch(res.stderr, /Traceback/);

  fs.writeFileSync(tariffsCsv, tariffs('A,yes,,1,2,3,4,', 'A,no,1/07/2025,1,2,3,4,', 'B,no,,1,2,3,4,x'));
  res = stamp(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /needs fixing before the app can use it:\n {2}line 4: the daily credit for “B”/);

  fs.writeFileSync(tariffsCsv, DEFAULTS);
  fs.writeFileSync(path.join(dir, 'public', 'data', 'sample-interval-data.csv'), meter('01/07/2025,00:00,,1,,', '01/07/2025,7am,,1,,'));
  res = stamp(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /sample-interval-data\.csv, line 3: "7am" is not a time like 13:30\./);
});
