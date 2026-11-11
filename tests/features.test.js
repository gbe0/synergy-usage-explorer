/*
 * features.test.js - checks dated rates, daily credits, break-even, time of day,
 * cost concentration, peak demand, year-on-year figures, the battery and the
 * next-bill projection. Run with `npm test`.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {loadSandbox, sampleCsv, tariffsCsv} = require('./load-app.js');

const HEAD = 'tariff,current,from,supply_cents_per_day,peak_cents_per_kwh,off_peak_cents_per_kwh,super_off_peak_cents_per_kwh,credit_cents_per_day';
const near = (actual, expected, within, what) =>
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);

function open(tariffs, intervals = sampleCsv()) {
  const sb = loadSandbox();
  sb.dash.setSources({intervals, tariffs});
  const rows = (id, range) => {
    const s = sb.dash.data(id, range);
    assert.equal(s.status, 'ok', `${id}: ${s.message || s.status}`);
    return s.data;
  };
  return {sb, dash: sb.dash, rows};
}

// Readings for `days` days from `start`: 1 kWh every half-hour, 2 kWh at peak.
function flatReadings(start, days) {
  const lines = ['Date,Time,PEAK (KWH),OFF PEAK (KWH),SUPER OFF PEAK (KWH),Billing Status'];
  const t0 = Date.parse(start + 'T00:00:00Z');
  for (let d = 0; d < days; d += 1) {
    const t = new Date(t0 + d * 86400000);
    const date = `${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${t.getUTCFullYear()}`;
    for (let s = 0; s < 48; s += 1) {
      const h = Math.floor(s / 2);
      const time = `${String(h).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;
      const cells = ['', '', ''];
      if (h >= 15 && h < 21) cells[0] = '2';
      else if (h >= 9 && h < 15) cells[2] = '1';
      else cells[1] = '1';
      lines.push([date, time, ...cells, 'Billed'].join(','));
    }
  }
  return lines.join('\n');
}

test('each day is priced at the rates in force on its date', () => {
  const tariffs = [HEAD,
    'Dated,yes,,100,50,20,10,0',
    'Dated,yes,2025-08-01,200,60,30,15,0'].join('\n');
  const {rows} = open(tariffs);
  const days = rows('dayTotals');
  const jul = days.find((d) => d.date === '2025-07-31'), aug = days.find((d) => d.date === '2025-08-01');
  assert.equal(jul.supply, 1);
  assert.equal(aug.supply, 2);
  near(jul.peakCost, (jul.peakKWh * 50) / 100, 0.01, 'July peak cost at 50c');
  near(aug.peakCost, (aug.peakKWh * 60) / 100, 0.01, 'August peak cost at 60c');
  // The periods table averages a rate that changed within the dates, weighted by kWh.
  const peak = rows('periods').find((r) => r.part === 'Peak');
  assert.equal(peak.varies, true);
  assert.ok(peak.rate > 50 && peak.rate < 60, `averaged peak rate ${peak.rate}`);
  // And the savings from moving peak use use each day's own rate difference.
  const shift = rows('shift').find((r) => r.target === 'Super off-peak' && r.pct === 100);
  const want = days.reduce((s, d) => s + (d.peakKWh * (d.rates.peakCents - d.rates.superOffPeakCents)) / 100, 0);
  near(shift.saving, want, 0.01, 'saving at each day’s rates');
});

test('days before a tariff’s first rates use those first rates', () => {
  const tariffs = [HEAD, 'Later,yes,2025-09-01,100,50,20,10,0'].join('\n');
  const {sb, rows} = open(tariffs);
  const p = rows('plans')[0];
  assert.equal(p.firstFrom, '2025-09-01');
  assert.equal(sb.ratesOn(p, '2025-07-01').peakCents, 50);
});

test('a daily credit comes off every day’s cost', () => {
  const tariffs = [HEAD, 'With credit,yes,,100,50,20,10,40', 'Without,no,,100,50,20,10,0'].join('\n');
  const {rows} = open(tariffs);
  const bills = rows('bills');
  const a = bills.find((b) => b.tariff === 'With credit'), b = bills.find((x) => x.tariff === 'Without');
  near(a.credit, 0.4 * a.days, 0.01, 'credit');
  near(a.total, a.energy + a.supply - a.credit, 0.011, 'total less credit');
  near(b.total - a.total, 0.4 * a.days, 0.011, 'difference is the credit');
  assert.ok(rows('periods').some((r) => r.tariff === 'With credit' && r.part === 'Daily credit' && r.cost < 0));
});

test('break-even points are where the two tariffs cost the same', () => {
  const {sb, rows} = open(tariffsCsv());
  const plans = rows('plans');
  for (const r of rows('breakEven')) {
    // Break-even uses the rates in force on the last chosen day.
    const A = sb.ratesOn(plans.find((p) => p.tariff === r.tariff), r.ratesOn);
    const B = sb.ratesOn(plans.find((p) => p.tariff === r.other), r.ratesOn);
    // Rebuild the simple model and check both break-even points give equal costs.
    const day = (x, share, k, wO) => x.supplyPerDay - x.creditPerDay
      + k * (share * x.peakCents + (1 - share) * (wO * x.offPeakCents + (1 - wO) * x.superOffPeakCents)) / 100;
    const totals = rows('periods').filter((x) => x.tariff === r.tariff);
    const kWh = (part) => totals.find((x) => x.part === part).kWh;
    const wO = kWh('Off-peak') / (kWh('Off-peak') + kWh('Super off-peak'));
    near(day(A, r.peakShareNow / 100, r.kWhPerDayNow, wO) - day(B, r.peakShareNow / 100, r.kWhPerDayNow, wO), r.diffPerDay, 0.05, 'difference now');
    if (r.breakEvenPeakShare != null) near(day(A, r.breakEvenPeakShare / 100, r.kWhPerDayNow, wO), day(B, r.breakEvenPeakShare / 100, r.kWhPerDayNow, wO), 0.05, 'same cost at the peak share');
    if (r.breakEvenKWh != null) near(day(A, r.peakShareNow / 100, r.breakEvenKWh, wO), day(B, r.peakShareNow / 100, r.breakEvenKWh, wO), 0.05, 'same cost at the daily use');
  }
  const ms = rows('breakEven').find((r) => r.tariff === 'Synergy Midday Saver' && r.other === 'Home Plan');
  assert.ok(ms.diffPerDay < 0, 'Midday Saver is cheaper for the sample');
  assert.equal(ms.cheaperWhenPeak, 'below');
});

test('the parts of the day add up to the whole day', () => {
  const {rows} = open(tariffsCsv());
  const usage = rows('usage')[0];
  for (const tariff of new Set(rows('blocks').map((r) => r.tariff))) {
    const mine = rows('blocks').filter((r) => r.tariff === tariff);
    assert.equal(mine.length, 5);
    near(mine.reduce((s, r) => s + r.kWhShare, 0), 100, 0.3, 'kWh shares');
    near(mine.reduce((s, r) => s + r.costShare, 0), 100, 0.3, 'cost shares');
    near(mine.reduce((s, r) => s + r.kWhPerDay, 0), usage.avgPerDay, 0.1, 'kWh a day');
  }
});

test('cost concentration rises from 0% to 100%, dearest first', () => {
  const {rows} = open(tariffsCsv());
  for (const r of rows('concentration')) {
    assert.equal(r.curve.length, 101);
    assert.equal(r.curve[0], 0);
    near(r.curve[100], 100, 0.01, 'all half-hours, all the cost');
    for (let i = 1; i < r.curve.length; i += 1) assert.ok(r.curve[i] >= r.curve[i - 1]);
    // Dearest first, so the first 10% carry at least 10% of the cost.
    assert.ok(r.tops.find((x) => x.pct === 10).costShare >= 10);
  }
});

test('peak demand finds the car charging on 21 August', () => {
  const {rows} = open(tariffsCsv());
  const top = rows('demand').reduce((m, d) => (d.peakKW > m.peakKW ? d : m));
  assert.equal(top.date, '2025-08-21');
  assert.equal(top.period, 'Peak');
  assert.ok(top.peakKW > 8);
});

test('long files get financial years, the last 12 months and year-on-year figures', () => {
  const flat = [HEAD, 'Flat,yes,,100,30,30,30,0'].join('\n');
  const {rows} = open(flat, flatReadings('2023-07-01', 760));
  const ids = rows('ranges').map((r) => r.range);
  for (const id of ['fy2023', 'fy2024', 'fy2025', 'last365', 'last90']) assert.ok(ids.includes(id), `missing ${id}`);
  const ly = rows('lastYear', 'last365')[0];
  assert.equal(ly.kWhChange, 0, 'the same use every day, so no change');
  const month = rows('monthly', 'all').find((m) => m.month === '2024-08');
  assert.equal(month.kWhChange, 0);
  // The sample has no year-earlier readings.
  assert.equal(open(tariffsCsv()).rows('lastYear').length, 0);
});

test('a battery saves on time-of-use rates and nothing on a flat rate', () => {
  const {sb, rows} = open(tariffsCsv());
  const plans = rows('plans');
  const sorted = (t) => rows('halfHours').filter((r) => r.tariff === t);
  const tou = plans.find((p) => p.peakCents !== p.superOffPeakCents), flat = plans.find((p) => p.peakCents === p.superOffPeakCents);
  const a = sb.simulateBattery(sorted(tou.tariff), tou, {size: 10, power: 5, efficiency: 90});
  assert.ok(a.saving > 0);
  assert.ok(a.usedPerDay <= 10 + 1e-9, 'never more than its size a day');
  near(a.chargedPerDay * 0.9, a.usedPerDay, 0.2, 'losses on charging');
  const none = sb.simulateBattery(sorted(tou.tariff), tou, {size: 0, power: 5, efficiency: 90});
  assert.equal(none.saving, 0);
  const b = sb.simulateBattery(sorted(flat.tariff), flat, {size: 10, power: 5, efficiency: 90});
  assert.equal(b.saving, 0);
});

test('the next bill adds up known days and estimates the rest', () => {
  const {sb, rows} = open(tariffsCsv());
  const p = rows('plans').find((x) => x.current);
  const days = rows('dayTotals').filter((d) => d.tariff === p.tariff);
  // A period wholly inside the readings is just their total.
  const past = sb.projectBill(days, p, '2025-08-01', '2025-08-31');
  assert.equal(past.estDays, 0);
  const aug = rows('bills', 'm2025-08').find((b) => b.tariff === p.tariff);
  near(past.total, aug.total, 0.01, 'August bill');
  // One that runs past the readings estimates the days to come.
  const next = sb.projectBill(days, p, '2025-09-11', '2025-11-10');
  assert.equal(next.days, 61);
  assert.equal(next.knownDays, 18);
  assert.equal(next.futureDays, 43);
  assert.ok(next.low <= next.total && next.total <= next.high);
  near(next.total, next.sofar + next.estimate, 0.001, 'total');
  near(next.cumulative.at(-1).total, next.total, 0.001, 'running total ends at the total');
});

test('a step is only worked out for the range asked for', () => {
  const {dash, rows} = open(tariffsCsv());
  // Array.from: arrays made inside the sandbox have its own Array prototype.
  const field = (list, f) => Array.from(list, (r) => r[f]);
  const n = rows('plans').length;
  assert.deepEqual(field(rows('bills'), 'range'), Array(n).fill('all'));
  assert.deepEqual(field(rows('bills', 'm2025-08'), 'range'), Array(n).fill('m2025-08'));
  dash.setParams({range: 'last7'});
  assert.deepEqual(field(rows('bills'), 'days'), Array(n).fill(7));
});

test('the default tariffs price the sample (July–September 2025) at the 2025–26 rates', () => {
  const {sb, rows} = open(tariffsCsv());
  const plans = rows('plans');
  const plan = (name) => plans.find((p) => p.tariff === name);
  const ms = sb.ratesOn(plan('Synergy Midday Saver'), '2025-08-01');
  assert.deepEqual([ms.peakCents, ms.offPeakCents, ms.superOffPeakCents], [53.8446, 23.6916, 8.6151]);
  near(ms.supplyPerDay, 1.292269, 1e-9, 'supply, dollars a day');
  assert.equal(sb.ratesOn(plan('Home Plan'), '2025-08-01').peakCents, 32.3719);
  // The concession versions cost the same less the Energy Assistance Payment, $342.85 a year in 2025–26.
  const bills = rows('bills');
  for (const base of ['Synergy Midday Saver', 'Home Plan']) {
    const a = bills.find((b) => b.tariff === base), b = bills.find((x) => x.tariff === `${base} with EAP concession`);
    near(a.total - b.total, (342.85 / 365) * a.days, 0.02, `${base}: the EAP credit`);
  }
});
