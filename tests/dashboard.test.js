/*
 * dashboard.test.js - checks the dashboard's figures on the sample readings
 * (public/data/sample-interval-data.csv) and the default tariffs.
 * Run with `npm test`.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {loadApp, sampleCsv, tariffsCsv} = require('./load-app.js');

const STEPS = ['intervals', 'tariffs', 'plans', 'ranges', 'halfHours', 'dayTotals', 'daily', 'usage', 'bills',
  'periods', 'profile', 'shift', 'monthly', 'weekdays', 'usualDays', 'spikes', 'dataChecks'];

function withSample() {
  const dash = loadApp();
  dash.setSources({intervals: sampleCsv(), tariffs: tariffsCsv()});
  const rows = (id) => {
    const s = dash.data(id);
    assert.equal(s.status, 'ok', `${id}: ${s.message || s.status}`);
    return s.data;
  };
  return {dash, rows};
}
const near = (actual, expected, within, what) =>
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);

test('every data step works on the sample', () => {
  const {rows} = withSample();
  for (const id of STEPS) rows(id);
});

test('every reading in the CSV is read, and none twice', () => {
  const {rows} = withSample();
  const lines = sampleCsv().trim().split(/\r?\n/).slice(1);
  let count = 0, kWh = 0;
  for (const line of lines) {
    for (const v of line.split(',').slice(2, 5)) {
      if (v.trim() !== '') { count += 1; kWh += Number(v); }
    }
  }
  const intervals = rows('intervals');
  assert.equal(intervals.length, count);
  near(intervals.reduce((s, r) => s + r.kWh, 0), kWh, 1e-6, 'total kWh');
});

test('date ranges cover the file, its months and its billing status', () => {
  const {rows} = withSample();
  const ranges = rows('ranges');
  const all = ranges.find((r) => r.range === 'all');
  assert.deepEqual([all.from, all.to, all.days], ['2025-07-01', '2025-09-28', 90]);
  const ids = ranges.map((r) => r.range);
  for (const id of ['last7', 'last14', 'last30', 'billed', 'unbilled', 'm2025-07', 'm2025-08', 'm2025-09']) {
    assert.ok(ids.includes(id), `missing range ${id}`);
  }
  const last7 = ranges.find((r) => r.range === 'last7');
  assert.deepEqual([last7.from, last7.to, last7.days], ['2025-09-22', '2025-09-28', 7]);
});

test('bills add up on every tariff', () => {
  const {rows} = withSample();
  const plans = rows('plans');
  const usage = rows('usage').find((r) => r.range === 'all');
  const bills = rows('bills').filter((r) => r.range === 'all');
  assert.equal(bills.length, plans.length);
  for (const b of bills) {
    const p = plans.find((x) => x.tariff === b.tariff);
    near(b.total, b.energy + b.supply, 0.011, `${b.tariff} total`);
    near(b.supply, p.supplyPerDay * b.days, 0.011, `${b.tariff} supply`);
    near(b.kWh, usage.total, 0.5, `${b.tariff} kWh`);
  }
  // A flat-rate plan's energy is just kWh times its one rate.
  const flat = plans.find((p) => p.peakCents === p.offPeakCents && p.offPeakCents === p.superOffPeakCents);
  if (flat) {
    const b = bills.find((x) => x.tariff === flat.tariff);
    near(b.energy, (b.kWh * flat.peakCents) / 100, 0.25, `${flat.tariff} energy`);
  }
});

test('the cheapest tariff is ranked first, by the right margin', () => {
  const {rows} = withSample();
  const bills = rows('bills').filter((r) => r.range === 'all').sort((a, b) => a.rank - b.rank);
  assert.deepEqual(bills.map((b) => b.rank), bills.map((_, i) => i + 1));
  for (let i = 1; i < bills.length; i += 1) assert.ok(bills[i].total >= bills[i - 1].total);
  if (bills.length > 1) near(bills[0].marginToNext, bills[1].total - bills[0].total, 0.011, 'margin');
});

test('each part of the bill adds up to 100% of the cost', () => {
  const {rows} = withSample();
  const parts = rows('periods').filter((r) => r.range === 'all');
  for (const tariff of new Set(parts.map((r) => r.tariff))) {
    const mine = parts.filter((r) => r.tariff === tariff);
    near(mine.reduce((s, r) => s + r.costShare, 0), 100, 0.5, `${tariff} cost shares`);
    near(mine.filter((r) => r.kWhShare != null).reduce((s, r) => s + r.kWhShare, 0), 100, 0.5, `${tariff} kWh shares`);
  }
});

test('moving peak use saves the rate difference on the kWh moved', () => {
  const {rows} = withSample();
  const plans = rows('plans');
  const totals = rows('dayTotals');
  const shift = rows('shift').filter((r) => r.range === 'all');
  for (const p of plans) {
    const peakKWh = totals.filter((d) => d.tariff === p.tariff).reduce((s, d) => s + d.peakKWh, 0);
    const none = shift.find((r) => r.tariff === p.tariff && r.target === 'Super off-peak' && r.pct === 0);
    const every = shift.find((r) => r.tariff === p.tariff && r.target === 'Super off-peak' && r.pct === 100);
    assert.equal(none.saving, 0);
    near(every.saving, (peakKWh * (p.peakCents - p.superOffPeakCents)) / 100, 0.011, `${p.tariff} saving`);
  }
});

// The sample has these events added on purpose (see the note app.js shows with it).
test('unusual usage finds the events added to the sample', () => {
  const {rows} = withSample();
  const days = new Map(rows('usualDays').map((d) => [d.date, d]));
  const spikes = rows('spikes');
  const spikeOn = (date, from, to) => spikes.find((e) => e.date === date && e.start >= from && e.start < to);

  assert.ok(spikeOn('2025-07-15', '00:00', '06:00'), 'hot-water boost overnight, 15 Jul');
  for (const d of ['2025-07-25', '2025-07-26', '2025-07-27']) assert.equal(days.get(d).flag, 'low', `weekend away, ${d}`);
  assert.equal(days.get('2025-08-21').flag, 'high', 'electric car charging, 21 Aug');
  assert.ok(spikeOn('2025-08-21', '15:00', '21:00'), 'the car charging is at peak');
  assert.equal(days.get('2025-09-06').flag, 'high', 'heatwave, 6 Sep');
  for (const d of ['2025-09-15', '2025-09-16', '2025-09-17', '2025-09-18', '2025-09-19', '2025-09-20']) {
    assert.ok(days.get(d).baseRaised, `heater left on, ${d}`);
  }
  assert.equal(days.get('2025-09-22').flag, 'low', 'power cut, 22 Sep');
});

test('data checks find the meter dropout and the power cut', () => {
  const {rows} = withSample();
  const checks = new Map(rows('dataChecks').map((d) => [d.date, d]));
  const dropout = checks.get('2025-09-03');
  assert.equal(dropout.halfHours, 45);
  assert.equal(dropout.missing.length, 3);
  assert.equal(checks.get('2025-09-22').zeroRuns.length, 1);
  for (const [date, d] of checks) {
    if (date === '2025-09-03') continue;
    assert.equal(d.halfHours, 48, `${date} has every half-hour`);
    assert.equal(d.dupes + d.negatives + d.mismatches, 0, `${date} has no repeated, negative or mismatched readings`);
  }
});

test('a custom date range is added, kept inside the file, and the figures follow it', () => {
  const {dash, rows} = withSample();
  dash.setParams({from: '2025-08-10', to: '2025-08-01'}); // given backwards on purpose
  let custom = rows('ranges').find((r) => r.range === 'custom');
  assert.deepEqual([custom.from, custom.to, custom.days], ['2025-08-01', '2025-08-10', 10]);
  assert.equal(rows('bills').find((r) => r.range === 'custom').days, 10);

  dash.setParams({from: '2025-06-01', to: '2025-07-03'}); // starts before the file
  custom = rows('ranges').find((r) => r.range === 'custom');
  assert.deepEqual([custom.from, custom.to, custom.days], ['2025-07-01', '2025-07-03', 3]);
});

test('a file without the meter columns gives an error, not a crash', () => {
  const dash = loadApp();
  dash.setSources({intervals: 'Date,Time,Usage\n01/07/2025,00:00,1.2\n', tariffs: tariffsCsv()});
  const quiet = console.error;
  console.error = () => {};
  try {
    const s = dash.data('intervals');
    assert.equal(s.status, 'error');
    assert.match(s.message, /PEAK \(KWH\)/);
    assert.equal(dash.data('bills').status, 'error');
  } finally {
    console.error = quiet;
  }
});
