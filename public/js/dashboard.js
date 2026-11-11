/*
 * dashboard.js - the dashboard itself: the data steps (dash.loader, dash.calc)
 * that turn the meter readings and tariffs into figures, and the drawings
 * (dash.draw) for every number and chart. d3 does the drawing; runtime.js
 * runs it all.
 */
/* ---------- Where the numbers come from ---------- */
dash.loader('intervals', {
  description: 'Turns the CSV into one row per half-hour: date (YYYY-MM-DD), start time, rate period (the kWh column that holds the reading), kWh and billing status.',
  fn: ({answer}) => {
    const lines = String(answer).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    const head = lines[0].split(',').map((h) => h.trim().toUpperCase());
    const col = (name) => head.indexOf(name);
    const iDate = col('DATE'), iTime = col('TIME'), iStatus = col('BILLING STATUS');
    const periods = [['OFF PEAK (KWH)', 'Off-peak'], ['SUPER OFF PEAK (KWH)', 'Super off-peak'], ['PEAK (KWH)', 'Peak']].map(([name, period]) => [col(name), period]);
    if (iDate < 0 || iTime < 0 || periods.some(([i]) => i < 0)) throw new Error('The file needs Date, Time, PEAK (KWH), OFF PEAK (KWH) and SUPER OFF PEAK (KWH) columns.');
    const rows = [];
    for (const line of lines.slice(1)) {
      const c = line.split(',');
      const [d, m, y] = (c[iDate] || '').trim().split('/');
      if (!y) continue;
      const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      for (const [i, period] of periods) {
        const v = (c[i] || '').trim();
        if (v !== '') rows.push({date, time: c[iTime].trim(), period, kWh: Number(v), status: iStatus >= 0 ? (c[iStatus] || '').trim() : ''});
      }
    }
    return {columns: ['date', 'time', 'period', 'kWh', 'status'], rows};
  },
});

dash.calc('plans', {
  inputs: ['tariffs'],
  title: 'Tariffs as numbers',
  description: 'Each tariff from the tariff list, with every set of rates it has had: the date each set starts (blank for the first), the supply charge and any daily credit in dollars a day, and each period’s rate in cents per kWh. The newest rates are repeated at the top level.',
  fn: (tariffs) => {
    const by = new Map();
    for (const t of tariffs) {
      const name = String(t.tariff || '').trim();
      if (!name) continue;
      if (!by.has(name)) by.set(name, {tariff: name, current: false, rates: []});
      const p = by.get(name);
      if (String(t.current || '').trim().toLowerCase() === 'yes') p.current = true;
      p.rates.push({
        from: String(t.from || '').trim(),
        supplyPerDay: Number(t.supply_cents_per_day) / 100,
        creditPerDay: Number(t.credit_cents_per_day || 0) / 100,
        peakCents: Number(t.peak_cents_per_kwh),
        offPeakCents: Number(t.off_peak_cents_per_kwh),
        superOffPeakCents: Number(t.super_off_peak_cents_per_kwh),
      });
    }
    return [...by.values()].map((p) => {
      p.rates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));   // a blank `from` sorts first
      const latest = p.rates[p.rates.length - 1];
      return {
        tariff: p.tariff, current: p.current, rates: p.rates,
        firstFrom: p.rates[0].from, latestFrom: latest.from,
        supplyPerDay: latest.supplyPerDay, creditPerDay: latest.creditPerDay,
        peakCents: latest.peakCents, offPeakCents: latest.offPeakCents, superOffPeakCents: latest.superOffPeakCents,
      };
    });
  },
});

// The rates a plan charged on a date: the last set starting on or before it. Days
// before its first set (say, before the plan existed) use the first set.
const ratesMemo = new WeakMap();
function ratesOn(p, date) {
  let byDate = ratesMemo.get(p);
  if (!byDate) ratesMemo.set(p, (byDate = new Map()));
  let r = byDate.get(date);
  if (!r) {
    r = p.rates[0];
    for (const x of p.rates) { if (!x.from || x.from <= date) r = x; else break; }
    byDate.set(date, r);
  }
  return r;
}
const RATE_KEY = {'Peak': 'peakCents', 'Off-peak': 'offPeakCents', 'Super off-peak': 'superOffPeakCents'};

dash.calc('ranges', {
  inputs: ['intervals'],
  title: 'Date ranges',
  description: 'The date choices: all days, the last 7, 14 and 30 days, billed and not-yet-billed readings, each calendar month and each Monday-to-Sunday week, with their first and last day.',
  fn: (intervals) => {
    const dates = [...new Set(intervals.map((r) => r.date))].sort();
    if (!dates.length) return [];
    const open = new Set(intervals.filter((r) => r.status !== 'Billed').map((r) => r.date));
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const short = (d) => `${Number(d.slice(8, 10))} ${mon[Number(d.slice(5, 7)) - 1]}`;
    const span = (list) => (list.length === 1 ? short(list[0]) : `${short(list[0])} – ${short(list[list.length - 1])}`);
    const out = [];
    const add = (range, group, label, list) => {
      if (list.length) out.push({range, group, label, from: list[0], to: list[list.length - 1], days: list.length});
    };
    add('all', 'All', `All days, ${span(dates)}`, dates);
    // "Last n days" counts calendar days back from the last reading, so gaps don't stretch it.
    const back = (n) => {
      const t = new Date(dates[dates.length - 1] + 'T00:00:00Z');
      t.setUTCDate(t.getUTCDate() - n + 1);
      return t.toISOString().slice(0, 10);
    };
    for (const n of [7, 14, 30, 90]) {
      const list = dates.filter((d) => d >= back(n));
      if (dates[0] < back(n)) add(`last${n}`, 'Recent', `Last ${n} days, ${span(list)}`, list);
    }
    if (dates[0] < back(365)) add('last365', 'Recent', `Last 12 months, ${span(dates.filter((d) => d >= back(365)))}`, dates.filter((d) => d >= back(365)));
    // Financial years, 1 July to 30 June: WA prices usually change on 1 July.
    const fys = new Map();
    for (const d of dates) {
      const y = Number(d.slice(0, 4)) - (d.slice(5, 7) < '07' ? 1 : 0);
      if (!fys.has(y)) fys.set(y, []);
      fys.get(y).push(d);
    }
    if (fys.size > 1 || dates.length > 300) {
      for (const [y, list] of fys) add(`fy${y}`, 'Financial years', `July ${y} – June ${y + 1}${list.length < 365 ? `, ${list.length} days` : ''}`, list);
    }
    const billed = dates.filter((d) => !open.has(d));
    const unbilled = dates.filter((d) => open.has(d));
    if (billed.length && unbilled.length) {
      add('billed', 'Billing', `Billed, ${span(billed)}`, billed);
      add('unbilled', 'Billing', `Not yet billed, ${span(unbilled)}`, unbilled);
    }
    const months = new Map();
    for (const d of dates) {
      const k = d.slice(0, 7);
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(d);
    }
    for (const [k, list] of months) {
      const inMonth = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0)).getUTCDate();
      add(`m${k}`, 'Months', `${monthName[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}${list.length < inMonth ? `, ${list.length} days` : ''}`, list);
    }
    const weeks = new Map();
    for (const d of dates) {
      const t = new Date(d + 'T00:00:00Z');
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      const k = t.toISOString().slice(0, 10);
      if (!weeks.has(k)) weeks.set(k, []);
      weeks.get(k).push(d);
    }
    for (const [k, list] of weeks) add(`w${k}`, 'Weeks', span(list), list);
    return out;
  },
});

dash.calc('usage', {
  inputs: ['intervals', 'ranges'],
  title: 'Usage figures',
  description: 'For each date range: kWh total and daily average, the peak period’s share, weekday and weekend averages, readings not yet billed, and the last 7 days up to the range’s end against the 7 before.',
  fn: (intervals, ranges) => {
    const r0 = (x) => (x == null ? null : Math.round(x));
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const byDay = new Map();
    for (const r of intervals) {
      const d = byDay.get(r.date) || {date: r.date, kWh: 0, peak: 0, billed: true};
      d.kWh += r.kWh;
      if (r.period === 'Peak') d.peak += r.kWh;
      if (r.status !== 'Billed') d.billed = false;
      byDay.set(r.date, d);
    }
    const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const mean = (list) => (list.length ? list.reduce((s, d) => s + d.kWh, 0) / list.length : null);
    const isWeekend = (d) => [0, 6].includes(new Date(d.date + 'T00:00:00Z').getUTCDay());
    return ranges.map((g) => {
      const list = days.filter((d) => d.date >= g.from && d.date <= g.to);
      const total = list.reduce((s, d) => s + d.kWh, 0);
      const peak = list.reduce((s, d) => s + d.peak, 0);
      const end = days.findIndex((d) => d.date === g.to);
      const last7 = end < 0 ? [] : days.slice(Math.max(0, end - 6), end + 1);
      const prev7 = end >= 13 ? days.slice(end - 13, end - 6) : [];
      const unbilled = list.filter((d) => !d.billed);
      return {
        range: g.range,
        firstDay: list.length ? list[0].date : null,
        lastDay: list.length ? list[list.length - 1].date : null,
        days: list.length,
        total: r0(total),
        avgPerDay: list.length ? r1(total / list.length) : null,
        peakShare: total ? r1((peak / total) * 100) : null,
        last7From: last7.length ? last7[0].date : null,
        last7To: last7.length ? last7[last7.length - 1].date : null,
        last7Avg: r1(mean(last7)),
        prev7From: prev7.length ? prev7[0].date : null,
        prev7To: prev7.length ? prev7[prev7.length - 1].date : null,
        unbilledKWh: r0(unbilled.reduce((s, d) => s + d.kWh, 0)),
        unbilledDays: unbilled.length,
        unbilledFrom: unbilled.length ? unbilled[0].date : null,
        weekdayAvg: r1(mean(list.filter((d) => !isWeekend(d)))),
        weekendAvg: r1(mean(list.filter(isWeekend))),
      };
    });
  },
});

dash.calc('halfHours', {
  inputs: ['intervals', 'plans'],
  title: 'Half-hours priced on each tariff',
  description: 'Every half-hour reading once per tariff, with its energy cost in dollars: kWh times the rate that tariff charged for the period on that date, divided by 100.',
  fn: (intervals, plans) => {
    const rows = [];
    for (const p of plans) {
      for (const r of intervals) {
        const rate = ratesOn(p, r.date)[RATE_KEY[r.period]];
        rows.push({
          tariff: p.tariff,
          date: r.date,
          time: r.time,
          period: r.period,
          kWh: r.kWh,
          cost: Number.isFinite(rate) ? Math.round(r.kWh * rate * 100) / 10000 : null,
          status: r.status,
        });
      }
    }
    return rows;
  },
});

dash.calc('daily', {
  inputs: ['halfHours', 'plans'],
  title: 'Daily totals on each tariff',
  description: 'For each tariff and day: kWh and energy cost in each rate period, the supply charge and any daily credit on that date, the day’s total cost (energy plus supply, less the credit), 7-day averages and billing status. kWh to 0.1, dollars to the cent.',
  fn: (halfHours, plans) => {
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const by = new Map();
    for (const r of halfHours) {
      const k = `${r.tariff}|${r.date}`;
      let d = by.get(k);
      if (!d) {
        d = {tariff: r.tariff, date: r.date, offPeak: 0, superOffPeak: 0, peak: 0, total: 0, offPeakCost: 0, superOffPeakCost: 0, peakCost: 0, energy: 0, status: r.status};
        by.set(k, d);
      }
      const key = r.period === 'Peak' ? 'peak' : r.period === 'Super off-peak' ? 'superOffPeak' : 'offPeak';
      d[key] += r.kWh;
      d.total += r.kWh;
      d[key + 'Cost'] += r.cost || 0;
      d.energy += r.cost || 0;
      if (r.status !== 'Billed') d.status = r.status;
    }
    const out = [];
    const fixed = (p, d) => {
      const r = ratesOn(p, d.date);
      return (r.supplyPerDay || 0) - (r.creditPerDay || 0);
    };
    for (const p of plans) {
      const days = [...by.values()].filter((d) => d.tariff === p.tariff).sort((a, b) => (a.date < b.date ? -1 : 1));
      days.forEach((d) => { d.net = d.energy + fixed(p, d); });
      days.forEach((d, i) => {
        const week = days.slice(Math.max(0, i - 6), i + 1);
        const full = week.length === 7;
        const r = ratesOn(p, d.date);
        out.push({
          tariff: d.tariff,
          date: d.date,
          offPeak: r1(d.offPeak),
          superOffPeak: r1(d.superOffPeak),
          peak: r1(d.peak),
          total: r1(d.total),
          avg7: full ? r1(week.reduce((s, w) => s + w.total, 0) / 7) : null,
          offPeakCost: r2(d.offPeakCost),
          superOffPeakCost: r2(d.superOffPeakCost),
          peakCost: r2(d.peakCost),
          supply: r2(r.supplyPerDay || 0),
          credit: r2(r.creditPerDay || 0),
          supplyNet: r2(Math.max(0, (r.supplyPerDay || 0) - (r.creditPerDay || 0))),
          cost: r2(d.net),
          avg7Cost: full ? r2(week.reduce((s, w) => s + w.net, 0) / 7) : null,
          status: d.status,
        });
      });
    }
    return out;
  },
});

dash.calc('dayTotals', {
  inputs: ['halfHours', 'plans'],
  title: 'Day totals, unrounded',
  description: 'For each tariff and day, unrounded: kWh and energy cost in each rate period and in all, the supply charge and daily credit, the rates in force, and whether every reading was billed. The figures below add these up over each date range.',
  fn: (halfHours, plans) => {
    const plan = new Map(plans.map((p) => [p.tariff, p]));
    const by = new Map();
    for (const r of halfHours) {
      const k = `${r.tariff}|${r.date}`;
      let d = by.get(k);
      if (!d) {
        const rates = ratesOn(plan.get(r.tariff), r.date);
        d = {
          tariff: r.tariff, date: r.date, kWh: 0, energy: 0, supply: rates.supplyPerDay || 0, credit: rates.creditPerDay || 0, rates, billed: true,
          offPeakKWh: 0, superOffPeakKWh: 0, peakKWh: 0, offPeakCost: 0, superOffPeakCost: 0, peakCost: 0,
        };
        by.set(k, d);
      }
      const key = r.period === 'Peak' ? 'peak' : r.period === 'Super off-peak' ? 'superOffPeak' : 'offPeak';
      d[key + 'KWh'] += r.kWh;
      d[key + 'Cost'] += r.cost || 0;
      d.kWh += r.kWh;
      d.energy += r.cost || 0;
      if (r.status !== 'Billed') d.billed = false;
    }
    return [...by.values()].sort((a, b) => (a.tariff === b.tariff ? (a.date < b.date ? -1 : 1) : a.tariff < b.tariff ? -1 : 1));
  },
});

dash.calc('bills', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'Bill estimate on each tariff',
  description: 'For each date range and tariff: energy, supply, any daily credit and total cost (energy plus supply, less credit), per day and per 30 days, average cents per kWh with supply, the last 7 days up to the range’s end against the 7 before, unbilled days, the dearest and cheapest day, and how it compares with the current tariff.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const isWeekend = (d) => [0, 6].includes(new Date(d.date + 'T00:00:00Z').getUTCDay());
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const sum = (xs) => xs.reduce((s, x) => s + x, 0);
    const dayCost = (d) => d.energy + d.supply - d.credit;
    const byTariff = new Map();
    for (const d of dayTotals) {
      if (!byTariff.has(d.tariff)) byTariff.set(d.tariff, []);
      byTariff.get(d.tariff).push(d);
    }
    for (const list of byTariff.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const out = [];
    for (const g of ranges) {
      const group = plans.map((p) => {
        const all = byTariff.get(p.tariff) || [];
        const list = all.filter((d) => d.date >= g.from && d.date <= g.to);
        const n = list.length;
        const kWh = sum(list.map((d) => d.kWh));
        const energy = sum(list.map((d) => d.energy));
        const supply = sum(list.map((d) => d.supply));
        const credit = sum(list.map((d) => d.credit));
        const total = energy + supply - credit;
        const end = all.findIndex((d) => d.date === g.to);
        const last7 = end < 0 ? [] : all.slice(Math.max(0, end - 6), end + 1);
        const prev7 = end >= 13 ? all.slice(end - 13, end - 6) : [];
        const a = mean(last7.map(dayCost)), b = mean(prev7.map(dayCost));
        const unbilled = list.filter((d) => !d.billed);
        const dear = list.reduce((m, d) => (m && dayCost(m) >= dayCost(d) ? m : d), null);
        const cheap = list.reduce((m, d) => (m && dayCost(m) <= dayCost(d) ? m : d), null);
        return {p, list, total, row: {
          range: g.range,
          tariff: p.tariff,
          current: p.current,
          days: n,
          kWh: r1(kWh),
          energy: r2(energy),
          supply: r2(supply),
          credit: r2(credit),
          total: r2(total),
          perDay: n ? r2(total / n) : null,
          per30: n ? r2((total / n) * 30) : null,
          avgCents: kWh ? r1((total * 100) / kWh) : null,
          peakCostShare: total ? r1((sum(list.map((d) => d.peakCost)) / total) * 100) : null,
          last7Cost: r2(a),
          prev7Cost: r2(b),
          change7Cost: b ? r1(((a - b) / b) * 100) : null,
          unbilledCost: r2(sum(unbilled.map(dayCost))),
          highDay: dear ? dear.date : null,
          highCost: dear ? r2(dayCost(dear)) : null,
          lowDay: cheap ? cheap.date : null,
          lowCost: cheap ? r2(dayCost(cheap)) : null,
          weekdayCost: r2(mean(list.filter((d) => !isWeekend(d)).map(dayCost))),
          weekendCost: r2(mean(list.filter(isWeekend).map(dayCost))),
        }};
      });
      const cur = group.find((x) => x.p.current);
      const curByDate = cur ? new Map(cur.list.map((d) => [d.date, dayCost(d)])) : null;
      const ranked = [...group].sort((x, y) => x.total - y.total);
      for (const x of group) {
        const rank = ranked.indexOf(x) + 1;
        const next = ranked[rank];
        out.push({
          ...x.row,
          vsCurrent: cur && x !== cur ? r2(x.total - cur.total) : null,
          cheaperDays: cur && x !== cur ? x.list.filter((d) => dayCost(d) < curByDate.get(d.date)).length : null,
          rank,
          marginToNext: rank === 1 && next ? r2(next.total - x.total) : null,
        });
      }
    }
    return out;
  },
});

dash.calc('periods', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'Bill by part, each tariff',
  description: 'For each date range and tariff: each rate period’s rate, kWh and energy cost, plus the supply charge and any daily credit, with each part’s share of kWh and of the charges (before credit). When a rate changed within the dates, the rate shown is the average weighted by kWh (or by day for supply) and `varies` is true.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    const sum = (xs) => xs.reduce((s, x) => s + x, 0);
    const hours = {'Off-peak': '9 pm–9 am', 'Super off-peak': '9 am–3 pm', 'Peak': '3 pm–9 pm'};
    const key = {'Peak': 'peak', 'Off-peak': 'offPeak', 'Super off-peak': 'superOffPeak'};
    const out = [];
    for (const g of ranges) {
      for (const p of plans) {
        const list = dayTotals.filter((d) => d.tariff === p.tariff && d.date >= g.from && d.date <= g.to);
        const n = list.length;
        const kWh = sum(list.map((d) => d.kWh));
        const supply = sum(list.map((d) => d.supply));
        const credit = sum(list.map((d) => d.credit));
        const charges = sum(list.map((d) => d.energy)) + supply;
        const parts = Object.keys(key)
          .map((period) => {
            const k = key[period], rk = RATE_KEY[period];
            const pk = sum(list.map((d) => d[k + 'KWh']));
            const seen = new Set(list.map((d) => d.rates[rk]));
            let rate = n ? list[0].rates[rk] : p[rk];
            if (seen.size > 1) rate = pk ? sum(list.map((d) => d[k + 'KWh'] * d.rates[rk])) / pk : sum(list.map((d) => d.rates[rk])) / n;
            return {period, rate, varies: seen.size > 1, kWh: pk, cost: sum(list.map((d) => d[k + 'Cost']))};
          })
          .sort((a, b) => b.rate - a.rate);
        for (const x of parts) {
          out.push({
            range: g.range, tariff: p.tariff, part: x.period, hours: hours[x.period],
            rate: r4(x.rate), varies: x.varies, unit: 'per kWh',
            kWh: r1(x.kWh), kWhShare: kWh ? r1((x.kWh / kWh) * 100) : null,
            cost: r2(x.cost), costShare: charges ? r1((x.cost / charges) * 100) : null,
          });
        }
        const perDay = (field, fallback) => (n ? (sum(list.map((d) => d[field])) / n) * 100 : fallback * 100);
        out.push({
          range: g.range, tariff: p.tariff, part: 'Supply charge', hours: 'Every day',
          rate: r4(perDay('supply', p.supplyPerDay || 0)), varies: new Set(list.map((d) => d.supply)).size > 1, unit: 'per day',
          kWh: null, kWhShare: null, cost: r2(supply), costShare: charges ? r1((supply / charges) * 100) : null,
        });
        if (credit > 0) {
          out.push({
            range: g.range, tariff: p.tariff, part: 'Daily credit', hours: 'Every day',
            rate: r4(perDay('credit', 0)), varies: new Set(list.map((d) => d.credit)).size > 1, unit: 'per day',
            kWh: null, kWhShare: null, cost: -r2(credit), costShare: null,
          });
        }
      }
    }
    return out;
  },
});

dash.calc('profile', {
  inputs: ['halfHours', 'ranges'],
  title: 'Average day on each tariff',
  description: 'For each date range and tariff: average kWh and energy cost in each half-hour of the day, for weekdays, weekends and all days.',
  fn: (halfHours, ranges) => {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    const weekendOf = new Map();
    for (const r of halfHours) if (!weekendOf.has(r.date)) weekendOf.set(r.date, [0, 6].includes(new Date(r.date + 'T00:00:00Z').getUTCDay()));
    const out = [];
    for (const g of ranges) {
      const slots = new Map();
      for (const r of halfHours) {
        if (r.date < g.from || r.date > g.to) continue;
        const k = `${r.tariff}|${r.time}`;
        let s = slots.get(k);
        if (!s) slots.set(k, (s = {tariff: r.tariff, time: r.time, period: r.period, wd: 0, wdCost: 0, wdN: 0, we: 0, weCost: 0, weN: 0}));
        if (weekendOf.get(r.date)) { s.we += r.kWh; s.weCost += r.cost || 0; s.weN += 1; }
        else { s.wd += r.kWh; s.wdCost += r.cost || 0; s.wdN += 1; }
      }
      const sorted = [...slots.values()].sort((a, b) => (a.tariff === b.tariff ? (a.time < b.time ? -1 : 1) : a.tariff < b.tariff ? -1 : 1));
      for (const s of sorted) {
        const n = s.wdN + s.weN;
        out.push({
          range: g.range,
          tariff: s.tariff,
          time: s.time,
          period: s.period,
          weekday: s.wdN ? r3(s.wd / s.wdN) : null,
          weekend: s.weN ? r3(s.we / s.weN) : null,
          all: r3((s.wd + s.we) / n),
          weekdayCost: s.wdN ? r4(s.wdCost / s.wdN) : null,
          weekendCost: s.weN ? r4(s.weCost / s.weN) : null,
          allCost: r4((s.wdCost + s.weCost) / n),
        });
      }
    }
    return out;
  },
});

dash.calc('shift', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'Savings from moving peak use',
  description: 'For each date range and tariff, and for moving 0% to 100% of peak kWh to super off-peak or off-peak: kWh moved per day, and the saving over the range, per day and per 30 days, at the difference between the two rates on each day.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    const rows = [];
    for (const g of ranges) {
      for (const p of plans) {
        const list = dayTotals.filter((d) => d.tariff === p.tariff && d.date >= g.from && d.date <= g.to);
        const days = list.length || 1;
        const peakKWh = list.reduce((s, d) => s + d.peakKWh, 0);
        for (const target of ['Super off-peak', 'Off-peak']) {
          const rk = RATE_KEY[target];
          // Dollars saved by moving all of every day's peak kWh, at that day's rates.
          const all = list.reduce((s, d) => s + (d.peakKWh * ((d.rates.peakCents || 0) - (d.rates[rk] || 0))) / 100, 0);
          for (let pct = 0; pct <= 100; pct += 10) {
            const saving = (all * pct) / 100;
            rows.push({
              range: g.range,
              tariff: p.tariff,
              target,
              pct,
              kWhPerDay: r1((peakKWh * pct) / 100 / days),
              saving: r2(saving),
              savingPerDay: r2(saving / days),
              savingPer30: r2((saving / days) * 30),
            });
          }
        }
      }
    }
    return rows;
  },
});

dash.calc('monthly', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'Month by month on each tariff',
  description: 'For each date range and tariff, and each calendar month the range touches: days, kWh, energy cost, supply charge, any credit and total, and the totals per day. Only days inside the range count. Where the file has at least 7 days of the same month a year earlier, that month’s kWh and cost a day, and the change in kWh a day.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    const months = (list) => {
      const by = new Map();
      for (const d of list) {
        const month = d.date.slice(0, 7);
        const m = by.get(month) || {month, n: 0, kWh: 0, energy: 0, supply: 0, credit: 0};
        m.n += 1;
        m.kWh += d.kWh;
        m.energy += d.energy;
        m.supply += d.supply;
        m.credit += d.credit;
        by.set(month, m);
      }
      return by;
    };
    const out = [];
    for (const g of ranges) {
      for (const p of plans) {
        const mine = dayTotals.filter((d) => d.tariff === p.tariff);
        const every = months(mine);
        const inRange = months(mine.filter((d) => d.date >= g.from && d.date <= g.to));
        for (const m of [...inRange.values()].sort((a, b) => (a.month < b.month ? -1 : 1))) {
          const prev = every.get(`${Number(m.month.slice(0, 4)) - 1}${m.month.slice(4)}`);
          const ok = !!prev && prev.n >= 7;
          const cost = m.energy + m.supply - m.credit;
          out.push({
            range: g.range,
            tariff: p.tariff,
            month: m.month,
            days: m.n,
            kWh: r1(m.kWh),
            kWhPerDay: r1(m.kWh / m.n),
            energy: r2(m.energy),
            supply: r2(m.supply),
            credit: r2(m.credit),
            cost: r2(cost),
            costPerDay: r2(cost / m.n),
            kWhPerDayLastYear: ok ? r1(prev.kWh / prev.n) : null,
            costPerDayLastYear: ok ? r2((prev.energy + prev.supply - prev.credit) / prev.n) : null,
            kWhChange: ok && prev.kWh ? r1(((m.kWh / m.n) / (prev.kWh / prev.n) - 1) * 100) : null,
          });
        }
      }
    }
    return out;
  },
});

dash.calc('weekdays', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'By day of the week on each tariff',
  description: 'For each date range and tariff: average kWh and cost (with supply) per day for each day of the week, and how many of that day the range holds.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const out = [];
    for (const g of ranges) {
      for (const p of plans) {
        const acc = names.map((day) => ({day, n: 0, kWh: 0, cost: 0}));
        for (const d of dayTotals) {
          if (d.tariff !== p.tariff || d.date < g.from || d.date > g.to) continue;
          const a = acc[(new Date(d.date + 'T00:00:00Z').getUTCDay() + 6) % 7];
          a.n += 1;
          a.kWh += d.kWh;
          a.cost += d.energy + d.supply - d.credit;
        }
        for (const a of acc) out.push({range: g.range, tariff: p.tariff, day: a.day, days: a.n, kWh: a.n ? r1(a.kWh / a.n) : null, cost: a.n ? r2(a.cost / a.n) : null});
      }
    }
    return out;
  },
});

dash.calc('breakEven', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'Where each pair of tariffs breaks even',
  description: 'For each date range and each pair of tariffs, at the rates in force on the range’s last day: the difference in cost per day now, the share of use at peak at which the two would cost the same (keeping total kWh, and the split of the rest between off-peak and super off-peak, as they were), and the kWh a day at which they would cost the same (keeping the split between periods as it was). `cheaperWhenPeak` and `cheaperWhenUse` say which side of the break-even point the first tariff is cheaper on.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const out = [];
    for (const g of ranges) {
      if (!plans.length) continue;
      // Use is the same on every tariff, so any one tariff's days give it.
      const list = dayTotals.filter((d) => d.tariff === plans[0].tariff && d.date >= g.from && d.date <= g.to);
      const n = list.length;
      const P = list.reduce((s, d) => s + d.peakKWh, 0);
      const O = list.reduce((s, d) => s + d.offPeakKWh, 0);
      const S = list.reduce((s, d) => s + d.superOffPeakKWh, 0);
      const K = P + O + S;
      if (!n || K <= 0) continue;
      const share = P / K, perDay = K / n, wO = O + S ? O / (O + S) : 0.5;
      const model = new Map(plans.map((p) => {
        const r = ratesOn(p, g.to);
        const peak = r.peakCents / 100, rest = (wO * r.offPeakCents + (1 - wO) * r.superOffPeakCents) / 100;
        return [p.tariff, {fixed: (r.supplyPerDay || 0) - (r.creditPerDay || 0), peak, rest, blend: share * peak + (1 - share) * rest, from: r.from}];
      }));
      for (const a of plans) {
        for (const b of plans) {
          if (a === b) continue;
          const A = model.get(a.tariff), B = model.get(b.tariff);
          // Cost a day at peak share s: fixed + perDay × (s × peak + (1 − s) × rest). Difference A − B:
          const slope = perDay * ((A.peak - A.rest) - (B.peak - B.rest));
          const base = (A.fixed - B.fixed) + perDay * (A.rest - B.rest);
          const s = slope ? -base / slope : null;
          const peakOk = s != null && s > 0 && s < 1;
          // Cost a day at k kWh a day, same mix: fixed + k × blend.
          const k = A.blend !== B.blend ? (B.fixed - A.fixed) / (A.blend - B.blend) : null;
          const useOk = k != null && k > 0;
          out.push({
            range: g.range, tariff: a.tariff, other: b.tariff, ratesOn: g.to,
            peakShareNow: r1(share * 100), kWhPerDayNow: r1(perDay),
            diffPerDay: r2(base + slope * share),
            breakEvenPeakShare: peakOk ? r1(s * 100) : null,
            cheaperWhenPeak: peakOk ? (slope > 0 ? 'below' : 'above') : null,
            breakEvenKWh: useOk ? r1(k) : null,
            cheaperWhenUse: useOk ? (A.blend < B.blend ? 'above' : 'below') : null,
          });
        }
      }
    }
    return out;
  },
});

// Parts of the day, finer than the three rate periods: off-peak splits into overnight, morning and late evening.
const BLOCKS = [
  {block: 'Overnight', hours: '12 am–6 am', from: '00:00', to: '06:00', period: 'Off-peak'},
  {block: 'Morning', hours: '6 am–9 am', from: '06:00', to: '09:00', period: 'Off-peak'},
  {block: 'Daytime', hours: '9 am–3 pm', from: '09:00', to: '15:00', period: 'Super off-peak'},
  {block: 'Early evening', hours: '3 pm–9 pm', from: '15:00', to: '21:00', period: 'Peak'},
  {block: 'Late evening', hours: '9 pm–12 am', from: '21:00', to: '24:00', period: 'Off-peak'},
];
const blockOf = (time) => BLOCKS.find((b) => time >= b.from && time < b.to) || BLOCKS[0];

dash.calc('blocks', {
  inputs: ['halfHours', 'plans', 'ranges'],
  title: 'Use by time of day',
  description: 'For each date range and tariff, and each part of the day (overnight 12–6 am, morning 6–9 am, daytime 9 am–3 pm, early evening 3–9 pm, late evening 9 pm–12 am): kWh and energy cost a day, each part’s share of the day’s kWh and energy cost, and the average power drawn in it in kW.',
  fn: (halfHours, plans, ranges) => {
    const r2 = (x) => Math.round(x * 100) / 100;
    const r1 = (x) => Math.round(x * 10) / 10;
    const out = [];
    for (const g of ranges) {
      for (const p of plans) {
        const acc = new Map(BLOCKS.map((b) => [b.block, {kWh: 0, cost: 0, n: 0}]));
        const dates = new Set();
        let kWh = 0, cost = 0;
        for (const r of halfHours) {
          if (r.tariff !== p.tariff || r.date < g.from || r.date > g.to) continue;
          const a = acc.get(blockOf(r.time).block);
          a.kWh += r.kWh; a.cost += r.cost || 0; a.n += 1;
          kWh += r.kWh; cost += r.cost || 0;
          dates.add(r.date);
        }
        const days = dates.size;
        if (!days) continue;
        for (const b of BLOCKS) {
          const a = acc.get(b.block);
          out.push({
            range: g.range, tariff: p.tariff, block: b.block, hours: b.hours, period: b.period, days,
            kWhPerDay: r2(a.kWh / days), kWhShare: kWh ? r1((a.kWh / kWh) * 100) : null,
            costPerDay: r2(a.cost / days), costShare: cost ? r1((a.cost / cost) * 100) : null,
            avgKW: a.n ? r2(a.kWh / (a.n * 0.5)) : null,
          });
        }
      }
    }
    return out;
  },
});

dash.calc('concentration', {
  inputs: ['halfHours', 'plans', 'ranges'],
  title: 'Where the cost concentrates',
  description: 'For each date range and tariff, with the half-hours sorted from dearest to cheapest energy cost: the share of the energy cost in the dearest 1%, 5%, 10%, 25% and 50% of half-hours (and their share of kWh), the cumulative share at every 1% (`curve`), and, for the dearest 10%, how they split between rate periods and the hours they most often start in.',
  fn: (halfHours, plans, ranges) => {
    const r1 = (x) => Math.round(x * 10) / 10;
    const out = [];
    for (const g of ranges) {
      for (const p of plans) {
        const rows = halfHours.filter((r) => r.tariff === p.tariff && r.date >= g.from && r.date <= g.to && r.cost != null);
        const N = rows.length;
        const totalCost = rows.reduce((s, r) => s + r.cost, 0), totalKWh = rows.reduce((s, r) => s + r.kWh, 0);
        if (!N || totalCost <= 0) continue;
        rows.sort((a, b) => b.cost - a.cost);
        const cumCost = [0], cumKWh = [0];
        for (const r of rows) { cumCost.push(cumCost[cumCost.length - 1] + r.cost); cumKWh.push(cumKWh[cumKWh.length - 1] + r.kWh); }
        const at = (pct) => Math.max(1, Math.round((N * pct) / 100));
        const curve = d3.range(0, 101).map((pct) => (pct ? r1((cumCost[Math.round((N * pct) / 100)] / totalCost) * 100) : 0));
        const tops = [1, 5, 10, 25, 50].map((pct) => {
          const k = at(pct);
          return {pct, halfHours: k, costShare: r1((cumCost[k] / totalCost) * 100), kWhShare: totalKWh ? r1((cumKWh[k] / totalKWh) * 100) : null, cost: cumCost[k]};
        });
        const top = rows.slice(0, at(10));
        const periodShare = {};
        for (const per of ['Peak', 'Off-peak', 'Super off-peak']) periodShare[per] = r1((top.filter((r) => r.period === per).length / top.length) * 100);
        const hours = d3.rollups(top, (v) => v.length, (r) => Number(r.time.slice(0, 2))).sort((a, b) => b[1] - a[1]).slice(0, 3);
        out.push({range: g.range, tariff: p.tariff, halfHours: N, totalCost, totalKWh, curve, tops, periodShare, topHours: hours.map(([h, c]) => ({hour: h, count: c}))});
      }
    }
    return out;
  },
});

// The same day a year earlier (29 Feb becomes 28 Feb).
const yearBefore = (iso) => {
  const y = Number(iso.slice(0, 4)) - 1;
  const md = iso.slice(5) === '02-29' ? '02-28' : iso.slice(5);
  return `${y}-${md}`;
};

dash.calc('lastYear', {
  inputs: ['dayTotals', 'plans', 'ranges'],
  title: 'Against the same dates a year earlier',
  description: 'For each date range and tariff: kWh and cost a day (each day at its own rates, with supply, less credit) over the range and over the same dates a year earlier, and the change. Only given when the file has readings for at least 80% as many days a year earlier, and at least 7.',
  fn: (dayTotals, plans, ranges) => {
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    const out = [];
    for (const g of ranges) {
      const pf = yearBefore(g.from), pt = yearBefore(g.to);
      for (const p of plans) {
        const mine = dayTotals.filter((d) => d.tariff === p.tariff);
        const cur = mine.filter((d) => d.date >= g.from && d.date <= g.to);
        const prev = mine.filter((d) => d.date >= pf && d.date <= pt);
        if (!cur.length || prev.length < 7 || prev.length < 0.8 * cur.length) continue;
        const per = (list, f) => list.reduce((s, d) => s + f(d), 0) / list.length;
        const kWh = per(cur, (d) => d.kWh), kWhPrev = per(prev, (d) => d.kWh);
        const cost = per(cur, (d) => d.energy + d.supply - d.credit), costPrev = per(prev, (d) => d.energy + d.supply - d.credit);
        out.push({
          range: g.range, tariff: p.tariff, days: cur.length, prevDays: prev.length, prevFrom: prev[0].date, prevTo: prev[prev.length - 1].date,
          kWhPerDay: r1(kWh), prevKWhPerDay: r1(kWhPrev), kWhChange: kWhPrev ? r1((kWh / kWhPrev - 1) * 100) : null,
          costPerDay: r2(cost), prevCostPerDay: r2(costPrev), costChange: costPrev ? r1((cost / costPrev - 1) * 100) : null,
        });
      }
    }
    return out;
  },
});

dash.calc('demand', {
  inputs: ['intervals'],
  title: 'Peak demand each day',
  description: 'For each day: its busiest half-hour (start time and rate period) and the average power drawn in it in kW (kWh × 2), and the average power over the whole day. Half-hour averages hide shorter bursts, such as a kettle.',
  fn: (intervals) => {
    const byDay = new Map();
    for (const r of intervals) {
      if (!byDay.has(r.date)) byDay.set(r.date, new Map());
      const slots = byDay.get(r.date);
      const s = slots.get(r.time) || {kWh: 0, period: r.period};
      s.kWh += r.kWh;
      slots.set(r.time, s);
    }
    const out = [];
    for (const [date, slots] of byDay) {
      let top = null, total = 0;
      for (const [time, s] of slots) {
        total += s.kWh;
        if (!top || s.kWh > top.kWh) top = {time, kWh: s.kWh, period: s.period};
      }
      out.push({
        date, time: top.time, period: top.period, peakKW: Math.round(top.kWh * 2 * 100) / 100,
        avgKW: Math.round((total / (slots.size * 0.5)) * 100) / 100, halfHours: slots.size,
      });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  },
});

/* ---------- Battery what-if ---------- */
// Simulates a home battery, half-hour by half-hour, on one tariff's priced readings
// (rows sorted by date and time). It charges from the grid in the day's cheapest
// rate period, up to its size and power, and powers the home whenever the rate is
// high enough to beat what the charge cost after losses. It never sends power to
// the grid. Losses are all taken when charging.
function simulateBattery(rows, plan, opts) {
  const size = Math.max(0, Number(opts.size) || 0);
  const perSlot = Math.max(0, Number(opts.power) || 0) * 0.5;
  const eff = Math.min(1, Math.max(0.5, (Number(opts.efficiency) || 90) / 100));
  let stored = 0, paidPerKWh = 0;   // energy in the battery, and what it cost per kWh delivered
  let gridBefore = 0, gridAfter = 0, costBefore = 0, costAfter = 0, charged = 0, used = 0;
  const days = new Set();
  const avgBefore = new Map(), avgAfter = new Map();
  for (const r of rows) {
    days.add(r.date);
    const rates = ratesOn(plan, r.date);
    const price = rates[RATE_KEY[r.period]] / 100;
    const cheapest = Math.min(rates.peakCents, rates.offPeakCents, rates.superOffPeakCents) / 100;
    const dearest = Math.max(rates.peakCents, rates.offPeakCents, rates.superOffPeakCents) / 100;
    let grid = r.kWh;
    // Charging only pays when a dearer period can use the energy after losses (never on a flat rate).
    if (price <= cheapest && dearest * eff > cheapest && size > 0 && stored < size) {
      // Cheapest period: charge. Grid kWh = stored kWh / efficiency.
      const add = Math.min(size - stored, perSlot);
      if (add > 0) {
        paidPerKWh = (stored * paidPerKWh + (add / eff) * price) / (stored + add);
        stored += add;
        charged += add / eff;
        grid += add / eff;
      }
    } else if (stored > 0 && price > paidPerKWh) {
      const give = Math.min(stored, perSlot, Math.max(0, r.kWh));
      stored -= give;
      used += give;
      grid -= give;
    }
    gridBefore += r.kWh;
    gridAfter += grid;
    costBefore += r.kWh * price;
    costAfter += grid * price;
    avgBefore.set(r.time, (avgBefore.get(r.time) || 0) + r.kWh);
    avgAfter.set(r.time, (avgAfter.get(r.time) || 0) + grid);
  }
  const n = days.size || 1;
  const saving = costBefore - costAfter;
  return {
    days: days.size, saving, savingPerDay: saving / n, savingPerYear: (saving / n) * 365,
    usedPerDay: used / n, chargedPerDay: charged / n, costBefore, costAfter,
    extraKWh: gridAfter - gridBefore,
    profile: DAY_SLOTS.map((time) => ({time, before: (avgBefore.get(time) || 0) / n, after: (avgAfter.get(time) || 0) / n})),
  };
}

/* ---------- Next bill ---------- */
// Adds up a billing period on one tariff: the days with readings at what they cost,
// and the rest (days still to come, or missing) estimated from the average day over
// the last 28 days of readings, kWh by rate period, priced at each day's rates. The
// likely range uses the 10th and 90th percentile of those days' kWh instead.
function projectBill(dayRows, plan, from, to) {
  if (!dayRows.length || from > to) return null;
  const inBill = new Map(dayRows.filter((d) => d.date >= from && d.date <= to).map((d) => [d.date, d]));
  // The 28 days of readings up to the end of the bill (or the first 28, for a bill before the readings).
  let recent = dayRows.filter((d) => d.date <= to).slice(-28);
  if (!recent.length) recent = dayRows.slice(0, 28);
  const sumOf = (f) => recent.reduce((s, d) => s + f(d), 0) / recent.length;
  const avg = {peak: sumOf((d) => d.peakKWh), offPeak: sumOf((d) => d.offPeakKWh), superOffPeak: sumOf((d) => d.superOffPeakKWh)};
  const totals = recent.map((d) => d.kWh).sort(d3.ascending);
  const avgKWh = avg.peak + avg.offPeak + avg.superOffPeak || 1;
  const scaleLow = d3.quantileSorted(totals, 0.1) / avgKWh, scaleHigh = d3.quantileSorted(totals, 0.9) / avgKWh;
  const sofar = [...inBill.values()].reduce((s, d) => s + d.energy + d.supply - d.credit, 0);
  let est = 0, estLow = 0, estHigh = 0, estDays = 0, futureDays = 0;
  const last = dayRows[dayRows.length - 1].date;
  const cumulative = [];
  let run = 0, runLow = 0, runHigh = 0;
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const d = inBill.get(date);
    if (d) {
      const c = d.energy + d.supply - d.credit;
      run += c; runLow += c; runHigh += c;
      cumulative.push({date, total: run, low: runLow, high: runHigh, actual: true});
      continue;
    }
    const r = ratesOn(plan, date);
    const energy = (avg.peak * r.peakCents + avg.offPeak * r.offPeakCents + avg.superOffPeak * r.superOffPeakCents) / 100;
    const fixed = (r.supplyPerDay || 0) - (r.creditPerDay || 0);
    est += energy + fixed;
    estLow += energy * scaleLow + fixed;
    estHigh += energy * scaleHigh + fixed;
    estDays += 1;
    if (date > last) futureDays += 1;
    run += energy + fixed;
    runLow += energy * scaleLow + fixed;
    runHigh += energy * scaleHigh + fixed;
    cumulative.push({date, total: run, low: runLow, high: runHigh, actual: false});
  }
  return {
    from, to, days: cumulative.length, knownDays: inBill.size, estDays, futureDays, missingDays: estDays - futureDays,
    sofar, estimate: est, total: sofar + est, low: sofar + estLow, high: sofar + estHigh,
    avgDay: est && estDays ? est / estDays : null, basisFrom: recent[0].date, basisTo: recent[recent.length - 1].date, cumulative,
  };
}

/* ---------- Unusual usage ---------- */
// Days on either side used to decide what is usual, and the fewest that will do.
const NEAR_DAYS = 14, MIN_NEAR = 10;
// The days around index i of a sorted list, without i itself.
const nearby = (list, i) => list.slice(Math.max(0, i - NEAR_DAYS), i).concat(list.slice(i + 1, i + 1 + NEAR_DAYS));
const ratePeriod = (time) => {
  const h = Number(time.slice(0, 2));
  return h >= 15 && h < 21 ? 'Peak' : h >= 9 && h < 15 ? 'Super off-peak' : 'Off-peak';
};
const DAY_SLOTS = Array.from({length: 48}, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

dash.calc('usualDays', {
  inputs: ['intervals'],
  title: 'Each day against the usual',
  description: 'For each day: kWh, whether it had every half-hour, and, compared with up to 14 complete days either side, the usual kWh (middle value), the usual range (10th to 90th percentile) and whether the day was much higher or lower. Also always-on use (the average of the four lowest half-hours, in watts), its usual level, and whether it was raised for 3 days or more in a row.',
  fn: (intervals) => {
    const byDay = new Map();
    for (const r of intervals) {
      let d = byDay.get(r.date);
      if (!d) { d = {date: r.date, kWh: 0, slots: new Map()}; byDay.set(r.date, d); }
      d.kWh += r.kWh;
      d.slots.set(r.time, (d.slots.get(r.time) || 0) + r.kWh);
    }
    const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!days.length) return [];
    const freq = d3.rollup(days, (v) => v.length, (d) => d.slots.size);
    const full = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    for (const d of days) {
      d.complete = d.slots.size >= full;
      const low = [...d.slots.values()].sort((a, b) => a - b).slice(0, 4);
      d.baseW = d.complete && low.length ? (d3.mean(low) * 2000) : null;
    }
    const ok = days.filter((d) => d.complete);
    ok.forEach((d, i) => {
      const near = nearby(ok, i);
      if (near.length < MIN_NEAR) return;
      const use = near.map((n) => n.kWh).sort(d3.ascending);
      d.usual = d3.quantileSorted(use, 0.5);
      d.low = d3.quantileSorted(use, 0.1);
      d.high = d3.quantileSorted(use, 0.9);
      d.flag = d.kWh > d.high && d.kWh >= 1.25 * d.usual ? 'high' : d.kWh < d.low && d.kWh <= 0.75 * d.usual ? 'low' : '';
      d.usualW = d3.median(near, (n) => n.baseW);
      d.baseHigh = d.baseW >= 1.4 * d.usualW && d.baseW - d.usualW >= 150;
    });
    // Raised always-on use only counts for 3 or more days in a row.
    let run = [];
    const close = () => { if (run.length >= 3) run.forEach((d) => { d.baseRaised = true; }); run = []; };
    for (const d of ok) {
      if (d.baseHigh && run.length && dayGap(run[run.length - 1].date, d.date) === 1) run.push(d);
      else { close(); if (d.baseHigh) run.push(d); }
    }
    close();
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    return days.map((d) => ({
      date: d.date, kWh: r2(d.kWh), complete: d.complete, judged: d.usual != null,
      usual: r2(d.usual), low: r2(d.low), high: r2(d.high), flag: d.flag || '',
      baseW: d.baseW == null ? null : Math.round(d.baseW), usualW: d.usualW == null ? null : Math.round(d.usualW),
      baseRaised: !!d.baseRaised,
    }));
  },
});

dash.calc('spikes', {
  inputs: ['intervals'],
  title: 'Spikes',
  description: 'Runs of half-hours that used far more than that time of day usually reaches: at least 0.75 kWh and 1.5 times the 90th percentile of the same half-hour on up to 14 days either side. For each run: day, start and end, kWh used, the usual kWh (middle values) and the difference in each rate period.',
  fn: (intervals) => {
    const bySlot = new Map();
    for (const r of intervals) {
      if (!bySlot.has(r.time)) bySlot.set(r.time, new Map());
      const m = bySlot.get(r.time);
      const v = m.get(r.date) || {date: r.date, kWh: 0, period: r.period};
      v.kWh += r.kWh;
      m.set(r.date, v);
    }
    const hits = [];
    for (const [time, m] of bySlot) {
      const list = [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      list.forEach((v, i) => {
        const near = nearby(list, i);
        if (near.length < MIN_NEAR) return;
        const use = near.map((n) => n.kWh).sort(d3.ascending);
        const p90 = d3.quantileSorted(use, 0.9);
        if (v.kWh - p90 >= 0.75 && v.kWh >= 1.5 * p90) hits.push({date: v.date, time, kWh: v.kWh, usual: d3.quantileSorted(use, 0.5), period: v.period});
      });
    }
    hits.sort((a, b) => (a.date === b.date ? (a.time < b.time ? -1 : 1) : a.date < b.date ? -1 : 1));
    const events = [];
    for (const h of hits) {
      const last = events[events.length - 1];
      if (!last || last.date !== h.date || last.end !== h.time) {
        events.push({date: h.date, start: h.time, end: endOf(h.time), halfHours: 0, kWh: 0, usual: 0, extra: 0, peakKW: 0, extraPeak: 0, extraOffPeak: 0, extraSuperOffPeak: 0});
      }
      const e = events[events.length - 1];
      const extra = h.kWh - h.usual;
      e.end = endOf(h.time);
      e.halfHours += 1;
      e.kWh += h.kWh;
      e.usual += h.usual;
      e.extra += extra;
      e.peakKW = Math.max(e.peakKW, h.kWh * 2);
      e[h.period === 'Peak' ? 'extraPeak' : h.period === 'Super off-peak' ? 'extraSuperOffPeak' : 'extraOffPeak'] += extra;
    }
    return events;
  },
});

dash.calc('dataChecks', {
  inputs: ['intervals'],
  title: 'Data checks',
  description: 'For each day: how many half-hours have readings and which of the 48 are missing, repeated times, negative readings, readings in a rate-period column that does not match their time, and runs of 2 hours or more reading zero or of 4 hours or more with the same reading.',
  fn: (intervals) => {
    const byDay = new Map();
    for (const r of intervals) {
      if (!byDay.has(r.date)) byDay.set(r.date, []);
      byDay.get(r.date).push(r);
    }
    const out = [];
    for (const [date, rows] of byDay) {
      const slots = new Map();
      let negatives = 0, mismatches = 0, mismatchExample = '';
      for (const r of rows) {
        slots.set(r.time, (slots.get(r.time) || 0) + 1);
        if (r.kWh < 0) negatives += 1;
        if (r.period !== ratePeriod(r.time)) {
          mismatches += 1;
          if (!mismatchExample) mismatchExample = `${r.period.toLowerCase()} reading at ${r.time}`;
        }
      }
      const dupes = [...slots.values()].filter((n) => n > 1).length;
      // Runs over consecutive half-hours (one value per time).
      const seq = d3.rollups(rows, (v) => d3.sum(v, (r) => r.kWh), (r) => r.time).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const zeroRuns = [], sameRuns = [];
      let i = 0;
      while (i < seq.length) {
        let j = i;
        while (j + 1 < seq.length && endOf(seq[j][0]) === seq[j + 1][0] && seq[j + 1][1] === seq[i][1]) j += 1;
        const n = j - i + 1;
        const span = `${seq[i][0]}–${endOf(seq[j][0])}`;
        if (seq[i][1] === 0 && n >= 4) zeroRuns.push(span);
        else if (seq[i][1] !== 0 && n >= 8) sameRuns.push(span);
        i = j + 1;
      }
      const missing = DAY_SLOTS.filter((t) => !slots.has(t));
      out.push({date, halfHours: slots.size, missing, dupes, negatives, mismatches, mismatchExample, zeroRuns, sameRuns});
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    const freq = d3.rollup(out, (v) => v.length, (d) => d.halfHours);
    const full = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || 48;
    return out.map((d) => Object.assign(d, {expected: full}));
  },
});

/* ---------- Shared helpers ---------- */
const C = Array.isArray(dash.colors) ? dash.colors : [];
document.querySelectorAll('.eu').forEach((el) => {
  if (C[0]) el.style.setProperty('--eu-off', C[0]);
  if (C[1]) el.style.setProperty('--eu-super', C[1]);
  if (C[2]) el.style.setProperty('--eu-peak', C[2]);
});

const PERIODS = [
  {key: 'peak', costKey: 'peakCost', name: 'Peak', color: 'var(--eu-peak)'},
  {key: 'superOffPeak', costKey: 'superOffPeakCost', name: 'Super off-peak', color: 'var(--eu-super)'},
  {key: 'offPeak', costKey: 'offPeakCost', name: 'Off-peak', color: 'var(--eu-off)'},
];
const COLOR = {'Peak': 'var(--eu-peak)', 'Super off-peak': 'var(--eu-super)', 'Off-peak': 'var(--eu-off)', 'Supply charge': 'var(--eu-supply)', 'Daily credit': 'var(--color-ok)'};
const DAY_ORDER = ['Off-peak', 'Super off-peak', 'Peak'];

const parseDay = d3.utcParse('%Y-%m-%d');
const fmtShort = d3.utcFormat('%-d %b');
const fmtDay = d3.utcFormat('%a %-d %b');
const fmtFull = d3.utcFormat('%a %-d %b %Y');
const fmtLong = d3.utcFormat('%A %-d %B %Y');
const fmtMonth = d3.utcFormat('%b %Y');
const asDate = (s, f = fmtShort) => {
  const d = s ? parseDay(s) : null;
  return d ? f(d) : '—';
};
const f0 = d3.format(',.0f');
const f1 = d3.format(',.1f');
const f2 = d3.format(',.2f');
const f4 = d3.format('.4f');
const fSigned = d3.format('+.1f');
const money = d3.format('$,.2f');
const money0 = d3.format('$,.0f');
const moneySigned = d3.format('+$,.2f');
const kwh = (v, f = f1) => (v == null ? '—' : `${f(v)} kWh`);
const usd = (v) => (v == null ? '—' : money(v));
const both = (k, c, fk = f1) => `${kwh(k, fk)} · ${usd(c)}`;
const pct = (v) => (v == null ? '—' : `${f1(v)}%`);
const enc = (v) => String(v).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
const encKey = (v) => enc(v).replace(/,/g, '%2C');

const isCost = () => (dash.params() || {}).measure !== 'kWh';
function axisFmt(ticks, cost) {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  const p = d3.precisionFixed(step);
  return d3.format(cost ? `$,.${p}f` : `,.${p}f`);
}

const rowsOf = (id) => {
  const s = dash.data(id);
  return s.status === 'ok' && Array.isArray(s.data) ? s.data : [];
};
const selPlan = () => {
  const plans = rowsOf('plans');
  const want = (dash.params() || {}).tariff;
  return plans.find((p) => p.tariff === want) || plans.find((p) => p.current) || plans[0] || null;
};
const selTariff = () => {
  const p = selPlan();
  return p ? p.tariff : null;
};
const isFlat = (p) => !!p && p.peakCents === p.offPeakCents && p.offPeakCents === p.superOffPeakCents;
// The chosen tariff's rates on the last chosen day (its newest rates if no dates are chosen).
const selRates = () => {
  const p = selPlan(), g = selRangeRow();
  return p ? (g ? ratesOn(p, g.to) : p) : null;
};
// Remembers fn()'s result under key until the data changes; for work several drawings share.
const memo = (() => {
  const m = new Map();
  return (key, fn) => {
    const k = `${dash.gen()}|${key}`;
    if (!m.has(k)) {
      if (m.size > 60) m.clear();
      m.set(k, fn());
    }
    return m.get(k);
  };
})();
const tariffColor = (name) => {
  const i = rowsOf('plans').findIndex((p) => p.tariff === name);
  return C[3 + i] || (i === 0 ? 'var(--color-fg)' : 'var(--color-fg-muted)');
};
const selRangeRow = () => {
  const ranges = rowsOf('ranges');
  const want = (dash.params() || {}).range;
  return ranges.find((r) => r.range === want) || ranges.find((r) => r.range === 'all') || ranges[0] || null;
};
const selRange = () => {
  const g = selRangeRow();
  return g ? g.range : null;
};
// Rows of an all-days source for the chosen tariff, inside the chosen dates.
const forTariff = (id) => {
  const t = selTariff(), g = selRangeRow();
  return rowsOf(id).filter((r) => r.tariff === t && (!g || (r.date >= g.from && r.date <= g.to)));
};
// Rows of a per-range source for the chosen tariff and dates.
const forView = (id) => {
  const t = selTariff(), g = selRange();
  return rowsOf(id).filter((r) => r.tariff === t && r.range === g);
};
const viewWhere = () => `range=${enc(selRange())}&tariff=${enc(selTariff())}`;
const pickDate = (dates) => {
  const p = (dash.params() || {}).day;
  return dates.includes(p) ? p : dates[dates.length - 1];
};
const selectedDay = (days) => {
  const d = pickDate(days.map((r) => r.date));
  return days.find((r) => r.date === d) || null;
};
const endOf = (t) => {
  const [h, m] = t.split(':').map(Number);
  const e = h * 60 + m + 30;
  return `${String(Math.floor(e / 60) % 24).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
};
const shiftChoice = () => {
  const p = dash.params() || {};
  const n = Number(p.shiftPct);
  return {
    target: p.shiftTo === 'Off-peak' ? 'Off-peak' : 'Super off-peak',
    pct: p.shiftPct === undefined || p.shiftPct === null || p.shiftPct === '' || !Number.isFinite(n) ? 30 : Math.max(0, Math.min(100, Math.round(n / 10) * 10)),
  };
};

function settle(el, s) {
  el.classList.toggle('dash-skeleton', s.status === 'loading');
}
function putMark(el, source, fieldName, where, text) {
  const m = document.createElement('span');
  m.dataset.source = source;
  m.dataset.field = fieldName;
  if (where) m.dataset.where = where;
  m.textContent = text;
  el.replaceChildren(m);
}
// Returns true when the chart can't be drawn yet, after drawing the right placeholder.
function placeholder(el, s) {
  settle(el, s);
  if (s.status === 'ok') return false;
  if (s.status === 'loading') { el.replaceChildren(); return true; }
  const p = document.createElement('p');
  p.className = 'eu-empty';
  p.textContent = s.status === 'connect' ? '' : 'Failed to load';
  el.replaceChildren(p);
  return true;
}
const firstNotOk = (...ids) => {
  const all = ids.map((id) => dash.data(id));
  return all.find((s) => s.status !== 'ok') || all[0];
};
function chartBox(el, H, label) {
  el.replaceChildren();
  const W = Math.max(280, Math.floor(el.clientWidth || 600));
  const svg = d3.select(el).append('svg')
    .attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', H)
    .attr('role', 'img').attr('aria-label', label);
  return {svg, W};
}
function textWidth(svg, strings, cls = 'eu-axis') {
  const g = svg.append('g').attr('class', cls).attr('visibility', 'hidden');
  let w = 0;
  for (const s of strings) w = Math.max(w, g.append('text').text(s).node().getComputedTextLength());
  g.remove();
  return w;
}
function yAxis(svg, y, ticks, fmt, x1, x2, unit) {
  svg.append('g').attr('class', 'eu-grid').selectAll('line').data(ticks).join('line')
    .attr('x1', x1).attr('x2', x2).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const g = svg.append('g').attr('class', 'eu-axis');
  g.selectAll('text').data(ticks).join('text')
    .attr('x', x1 - 8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(fmt);
  g.append('text').attr('x', 0).attr('y', 11).text(unit);
  svg.append('line').attr('class', 'eu-base').attr('x1', x1).attr('x2', x2).attr('y1', y(0)).attr('y2', y(0));
}
function xLabels(svg, ticks, xOf, y, W, fmt) {
  const texts = svg.append('g').attr('class', 'eu-axis').selectAll('text').data(ticks).join('text')
    .attr('x', xOf).attr('y', y)
    .attr('text-anchor', (d) => (xOf(d) < 28 ? 'start' : xOf(d) > W - 28 ? 'end' : 'middle'))
    .text(fmt);
  // Drop any label that would touch the one before it.
  let right = -Infinity;
  texts.each(function () {
    const b = this.getBBox();
    if (b.width && b.x < right + 6) this.remove();
    else right = b.x + b.width;
  });
}
// Day labels far enough apart to read: every day, every other day, or Mondays.
function dateTicks(dates, step) {
  const every = [1, 2, 7, 14, 28].find((n) => n * step >= 54) || 28;
  if (every < 7) return dates.filter((d, i) => i % every === 0);
  return dates.filter((d) => parseDay(d).getUTCDay() === 1).filter((d, i) => i % (every / 7) === 0);
}
function makeTip(el) {
  const t = document.createElement('div');
  t.className = 'eu-tip';
  t.hidden = true;
  el.append(t);
  return {
    show(event, title, rows, foot) {
      const parts = [];
      const head = document.createElement('div');
      head.className = 'eu-tip-title';
      head.textContent = title;
      parts.push(head);
      for (const r of rows) {
        const line = document.createElement('div');
        line.className = 'eu-tip-row' + (r.strong ? ' eu-tip-strong' : '');
        const lab = document.createElement('span');
        if (r.swatch) {
          const sw = document.createElement('i');
          sw.className = 'eu-sw';
          sw.style.background = r.swatch;
          lab.append(sw);
        }
        if (r.line) {
          const ln = document.createElement('i');
          ln.className = 'eu-ln' + (r.line === 'dash' ? ' eu-ln-dash' : '');
          if (r.color) ln.style.borderTopColor = r.color;
          lab.append(ln);
        }
        lab.append(r.label);
        const val = document.createElement('b');
        val.textContent = r.value;
        line.append(lab, val);
        parts.push(line);
      }
      if (foot) {
        const f = document.createElement('div');
        f.className = 'eu-tip-foot';
        f.textContent = foot;
        parts.push(f);
      }
      t.replaceChildren(...parts);
      t.hidden = false;
      const [px, py] = d3.pointer(event, el);
      const w = t.offsetWidth, h = t.offsetHeight, W = el.clientWidth;
      let left = px + 14;
      if (left + w > W) left = px - 14 - w;
      if (left < 0) left = Math.max(0, Math.min(W - w, px - w / 2));
      let top = py - h - 12;
      if (top < 0) top = py + 18;
      t.style.left = `${left}px`;
      t.style.top = `${top}px`;
    },
    hide() {
      t.hidden = true;
    },
  };
}
function ring(svg, w, h) {
  const g = svg.append('g').attr('visibility', 'hidden').attr('pointer-events', 'none');
  g.append('rect').attr('class', 'eu-ring-o').attr('width', w).attr('height', h);
  g.append('rect').attr('class', 'eu-ring-i').attr('width', w).attr('height', h);
  return g;
}
function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}
function nameCell(name, chip, swatch) {
  const td = document.createElement('td');
  const wrap = document.createElement('span');
  wrap.className = 'eu-cellsw';
  if (swatch) {
    const sw = document.createElement('i');
    sw.className = 'eu-sw';
    sw.style.background = swatch;
    wrap.append(sw);
  }
  wrap.append(name);
  td.append(wrap);
  if (chip) {
    const c = document.createElement('span');
    c.className = 'eu-chip';
    c.textContent = chip;
    td.append(c);
  }
  return td;
}

/* ---------- Controls ---------- */
dash.draw('tariff-pick', (sel) => {
  const plans = rowsOf('plans');
  const cur = selTariff();
  sel.replaceChildren(...plans.map((p) => new Option(p.current ? `${p.tariff} (current)` : p.tariff, p.tariff)));
  if (cur) sel.value = cur;
  sel.disabled = !plans.length;
  sel.onchange = () => dash.setParams({tariff: sel.value});
});
dash.draw('range-pick', (sel) => {
  const ranges = rowsOf('ranges');
  const cur = selRange();
  const groups = new Map();
  for (const r of ranges) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  sel.replaceChildren(...[...groups].map(([name, list]) => {
    const og = document.createElement('optgroup');
    og.label = name;
    og.append(...list.map((r) => new Option(r.label, r.range)));
    return og;
  }));
  if (cur) sel.value = cur;
  sel.disabled = !ranges.length;
  sel.onchange = () => dash.setParams({range: sel.value, day: ''});
});
document.querySelectorAll('[data-measure]').forEach((b) => {
  b.addEventListener('click', () => dash.setParams({measure: b.dataset.measure}));
});
document.querySelectorAll('.eu-btn[data-step]').forEach((b) => {
  b.addEventListener('click', () => {
    const days = forTariff('daily');
    const cur = selectedDay(days);
    if (!cur) return;
    const i = days.indexOf(cur) + Number(b.dataset.step);
    if (i >= 0 && i < days.length) dash.setParams({day: days[i].date});
  });
});
document.querySelectorAll('#shift-pct').forEach((el) => {
  el.addEventListener('input', () => dash.setParams({shiftPct: Number(el.value)}));
});
document.querySelectorAll('#shift-to').forEach((el) => {
  el.addEventListener('change', () => dash.setParams({shiftTo: el.value}));
});
dash.onData(() => {
  const cost = isCost();
  const m = cost ? 'cost' : 'kWh';
  document.querySelectorAll('[data-measure]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.measure === m)));
  document.querySelectorAll('[data-when="cost"]').forEach((el) => { el.hidden = !cost; });
  const flat = isFlat(selRates());
  const credit = rowsOf('bills').some((r) => r.range === selRange() && r.credit > 0);
  document.querySelectorAll('[data-when="credit"]').forEach((el) => { el.hidden = !credit; });
  syncInputs();
  document.querySelectorAll('[data-when="tou"]').forEach((el) => { el.hidden = flat; });
  document.querySelectorAll('[data-when="flat"]').forEach((el) => { el.hidden = !flat; });
  const multi = rowsOf('bills').filter((r) => r.range === selRange()).length > 1;
  document.querySelectorAll('[data-when="multi"]').forEach((el) => { el.hidden = !multi; });
  const days = forTariff('daily');
  const cur = selectedDay(days);
  const i = cur ? days.indexOf(cur) : -1;
  document.querySelectorAll('.eu-btn[data-step]').forEach((b) => {
    const j = i + Number(b.dataset.step);
    b.disabled = i < 0 || j < 0 || j >= days.length;
  });
  const {target, pct: share} = shiftChoice();
  document.querySelectorAll('#shift-pct').forEach((el) => {
    if (document.activeElement !== el) el.value = String(share);
  });
  document.querySelectorAll('#shift-to').forEach((el) => {
    el.value = target;
  });
});

/* ---------- Numbers in the text ---------- */
// Usage figures depend on the chosen dates only.
function drawUsage(name, key, show) {
  dash.draw(name, (el) => {
    const s = firstNotOk('usage', 'ranges');
    settle(el, s);
    const g = selRange();
    const row = rowsOf('usage').find((r) => r.range === g);
    if (!row || row[key] == null) { el.textContent = '—'; return; }
    putMark(el, 'usage', key, `range=${enc(g)}`, show(row[key], row));
  });
}
drawUsage('first-day', 'firstDay', (v) => asDate(v));
drawUsage('last-day', 'lastDay', (v) => asDate(v));
drawUsage('total', 'total', f0);
drawUsage('peak-share', 'peakShare', pct);
drawUsage('days', 'days', f0);
drawUsage('last7', 'last7Avg', f1);
drawUsage('last7-range', 'last7From', (v, r) => `${asDate(r.last7From)} – ${asDate(r.last7To)}`);
drawUsage('prev7-range', 'prev7From', (v, r) => `${asDate(r.prev7From)} – ${asDate(r.prev7To)}`);
drawUsage('unbilled', 'unbilledKWh', f0);
drawUsage('unbilled-days', 'unbilledDays', f0);
drawUsage('unbilled-from', 'unbilledFrom', (v) => asDate(v));
drawUsage('wd-avg', 'weekdayAvg', f1);
drawUsage('we-avg', 'weekendAvg', f1);

// Bill figures belong to the chosen tariff's row.
function drawBill(name, key, show) {
  dash.draw(name, (el) => {
    const s = firstNotOk('bills', 'plans', 'ranges');
    settle(el, s);
    const row = forView('bills')[0];
    if (!row || row[key] == null) { el.textContent = '—'; return; }
    putMark(el, 'bills', key, viewWhere(), show(row[key]));
  });
}
drawBill('tariff-name', 'tariff', (v) => v);
drawBill('bill-total', 'total', money);
drawBill('bill-day', 'perDay', money);
drawBill('bill-energy', 'energy', money);
drawBill('bill-supply', 'supply', money);
drawBill('bill-last7', 'last7Cost', money);
drawBill('bill-unbilled', 'unbilledCost', money);
drawBill('bill-cents', 'avgCents', f1);
drawBill('peak-cost-share', 'peakCostShare', pct);
drawBill('high-day', 'highDay', (v) => asDate(v, fmtDay));
drawBill('high-cost', 'highCost', money);
drawBill('low-day', 'lowDay', (v) => asDate(v, fmtDay));
drawBill('low-cost', 'lowCost', money);
drawBill('wd-cost', 'weekdayCost', money);
drawBill('we-cost', 'weekendCost', money);

dash.draw('chg7', (el) => {
  const s = firstNotOk('bills', 'plans');
  settle(el, s);
  const row = forView('bills')[0];
  const v = row ? row.change7Cost : null;
  el.classList.toggle('eu-good', v != null && v < 0);
  el.classList.toggle('eu-bad', v != null && v > 0);
  if (v == null) { el.textContent = '—'; return; }
  putMark(el, 'bills', 'change7Cost', viewWhere(), `${fSigned(v)}%`);
});

function drawCheapest(name, key, show) {
  dash.draw(name, (el) => {
    const s = dash.data('bills');
    settle(el, s);
    const g = selRange();
    const row = rowsOf('bills').find((r) => r.range === g && r.rank === 1);
    if (!row || row[key] == null) { el.textContent = '—'; return; }
    putMark(el, 'bills', key, `range=${enc(g)}&tariff=${enc(row.tariff)}`, show(row[key]));
  });
}
drawCheapest('cheapest-name', 'tariff', (v) => v);
drawCheapest('cheapest-margin', 'marginToNext', money);

/* ---------- Compare tariffs ---------- */
dash.draw('compare-bars', (el) => {
  if (placeholder(el, firstNotOk('bills', 'plans'))) return;
  const rows = rowsOf('bills').filter((r) => r.range === selRange());
  if (!rows.length) { el.replaceChildren(); return; }
  const chosen = selTariff();
  const rowH = 46;
  const H = rows.length * rowH;
  const {svg, W} = chartBox(el, H, `Bars comparing the total cost of the same use on each tariff, split into supply charge and energy.`);
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r.total) || 1], [0, W - 2]);
  const tip = makeTip(el);
  rows.forEach((r, i) => {
    const y0 = i * rowH;
    const g = svg.append('g');
    g.append('text').attr('class', `eu-name${r.tariff === chosen ? ' eu-name-on' : ''}`).attr('x', 0).attr('y', y0 + 14)
      .text(r.current ? `${r.tariff} (current)` : r.tariff);
    g.append('text').attr('class', 'eu-vlab').attr('x', W - 2).attr('y', y0 + 14).attr('text-anchor', 'end').text(money(r.total));
    const by = y0 + 22, bh = 16;
    const fixed = Math.max(0, r.supply - (r.credit || 0));
    g.append('rect').attr('x', 0).attr('y', by).attr('height', bh).attr('width', Math.max(0, x(fixed) - 1)).style('fill', 'var(--eu-supply)');
    g.append('rect').attr('x', x(fixed)).attr('y', by).attr('height', bh).attr('width', Math.max(0, x(r.total) - x(fixed))).style('fill', tariffColor(r.tariff));
    g.append('rect').attr('x', 0).attr('y', y0).attr('width', W).attr('height', rowH - 4).attr('fill', 'transparent')
      .on('pointerenter pointermove', (event) => tip.show(event, r.tariff, [
        {label: 'Supply charge', value: usd(r.supply), swatch: 'var(--eu-supply)'},
        {label: 'Energy', value: usd(r.energy), swatch: tariffColor(r.tariff)},
        ...(r.credit ? [{label: 'Daily credits', value: `−${usd(r.credit)}`}] : []),
        {label: 'Total', value: usd(r.total), strong: true},
        {label: 'Per 30 days', value: usd(r.per30)},
      ], r.vsCurrent == null ? (r.current ? 'Current tariff' : '') : `${moneySigned(r.vsCurrent)} vs current`))
      .on('pointerleave', () => tip.hide());
  });
}, {deps: ['range', 'tariff']});

dash.draw('compare-rows', (tbody) => {
  const rows = rowsOf('bills').filter((r) => r.range === selRange());
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.dataset.key = `${encKey(r.range)},${encKey(r.tariff)}`;
    const diff = cell(r.vsCurrent == null ? '—' : moneySigned(r.vsCurrent), 'eu-num');
    if (r.vsCurrent != null) diff.classList.add(r.vsCurrent > 0 ? 'eu-bad' : 'eu-good');
    tr.append(
      nameCell(r.tariff, r.current ? 'Current' : r.rank === 1 ? 'Cheapest' : null, tariffColor(r.tariff)),
      cell(money(r.supply), 'eu-num'),
      cell(money(r.energy), 'eu-num'),
      Object.assign(cell(r.credit ? `−${money(r.credit)}` : '—', 'eu-num'), {hidden: !rows.some((x) => x.credit > 0)}),
      cell(money(r.total), 'eu-num eu-strong'),
      cell(money(r.per30), 'eu-num'),
      cell(f1(r.avgCents), 'eu-num'),
      diff,
      cell(r.cheaperDays == null ? '—' : f0(r.cheaperDays), 'eu-num'),
    );
    return tr;
  }));
});

dash.draw('compare-legend', (el) => {
  const plans = rowsOf('plans');
  el.replaceChildren(...plans.map((p) => {
    const s = document.createElement('span');
    const ln = document.createElement('i');
    ln.className = 'eu-ln';
    ln.style.borderTopColor = tariffColor(p.tariff);
    s.append(ln, p.current ? `${p.tariff} (current)` : p.tariff);
    return s;
  }));
});

dash.draw('compare-lines', (el) => {
  if (placeholder(el, firstNotOk('daily', 'plans'))) return;
  const plans = rowsOf('plans');
  const g = selRangeRow();
  const all = rowsOf('daily').filter((r) => !g || (r.date >= g.from && r.date <= g.to));
  const dates = [...new Set(all.map((r) => r.date))].sort();
  if (!dates.length || !plans.length) { el.replaceChildren(); return; }
  const series = plans.map((p) => ({
    tariff: p.tariff,
    color: tariffColor(p.tariff),
    byDate: new Map(all.filter((r) => r.tariff === p.tariff).map((r) => [r.date, r])),
  }));
  const H = el.clientWidth < 560 ? 230 : 270;
  const top = 24, bottom = H - 24;
  const {svg, W} = chartBox(el, H, `Line chart of the cost of each day on each tariff, with the supply charge, from ${asDate(dates[0])} to ${asDate(dates[dates.length - 1])}.`);
  const y = d3.scaleLinear().domain([0, d3.max(all, (r) => r.cost) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, true);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const x = d3.scaleBand(dates, [ml, W - mr]);
  const cx = (d) => x(d) + x.bandwidth() / 2;
  yAxis(svg, y, yt, fmt, ml, W - mr, 'Cost per day, with supply');
  for (const s of series) {
    const line = d3.line().defined((d) => s.byDate.has(d)).x(cx).y((d) => y(s.byDate.get(d).cost));
    svg.append('path').datum(dates).attr('class', 'eu-halo').attr('d', line).style('stroke-width', 4);
    svg.append('path').datum(dates).attr('class', 'eu-tline').attr('d', line).style('stroke', s.color);
  }
  xLabels(svg, dateTicks(dates, x.step()), cx, H - 6, W, (d) => asDate(d));
  const rule = svg.append('line').attr('class', 'eu-rule').attr('y1', top).attr('y2', bottom).attr('visibility', 'hidden');
  const dots = series.map((s) => svg.append('circle').attr('r', 3.5).attr('visibility', 'hidden')
    .style('fill', s.color).style('stroke', 'var(--color-bg)').style('stroke-width', 1.5));
  const tip = makeTip(el);
  svg.append('rect').attr('class', 'eu-hit')
    .attr('x', ml).attr('y', 0).attr('width', Math.max(0, W - mr - ml)).attr('height', bottom)
    .attr('fill', 'transparent')
    .on('pointerenter pointermove', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const i = Math.max(0, Math.min(dates.length - 1, Math.floor((px - ml) / x.step())));
      const d = dates[i];
      rule.attr('x1', cx(d)).attr('x2', cx(d)).attr('visibility', 'visible');
      const rows = [];
      series.forEach((s, k) => {
        const r = s.byDate.get(d);
        if (r) dots[k].attr('cx', cx(d)).attr('cy', y(r.cost)).attr('visibility', 'visible');
        rows.push({label: s.tariff, value: r ? usd(r.cost) : '—', line: 'solid', color: s.color});
      });
      tip.show(event, asDate(d, fmtFull), rows, '');
    })
    .on('pointerleave', () => {
      rule.attr('visibility', 'hidden');
      dots.forEach((dot) => dot.attr('visibility', 'hidden'));
      tip.hide();
    })
    .on('click', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const i = Math.max(0, Math.min(dates.length - 1, Math.floor((px - ml) / x.step())));
      dash.setParams({day: dates[i]});
    });
}, {deps: ['range', 'tariff']});

dash.draw('rate-rows', (tbody) => {
  const g = selRangeRow();
  const cents = (v) => (v == null || Number.isNaN(v) ? '—' : f4(v * 100));
  const rows = [];
  for (const p of rowsOf('plans')) {
    p.rates.forEach((r, i) => {
      const next = p.rates[i + 1];
      // In force during the chosen dates: starts by their end, and the next set starts after their start.
      if (g && ((r.from && r.from > g.to) || (next && next.from <= g.from))) return;
      rows.push({p, r});
    });
  }
  tbody.replaceChildren(...rows.map(({p, r}, i) => {
    const tr = document.createElement('tr');
    tr.dataset.key = `${encKey(p.tariff)},${r.from}`;
    const first = i === 0 || rows[i - 1].p !== p;
    tr.append(
      first ? nameCell(p.tariff, p.current ? 'Current' : null, null) : cell(''),
      withSort(cell(r.from ? asDate(r.from, fmtFull) : 'The start'), r.from),
      cell(cents(r.supplyPerDay), 'eu-num'),
      cell(cents(r.peakCents / 100), 'eu-num'),
      cell(cents(r.offPeakCents / 100), 'eu-num'),
      cell(cents(r.superOffPeakCents / 100), 'eu-num'),
      cell(r.creditPerDay ? cents(r.creditPerDay) : '—', 'eu-num'),
    );
    return tr;
  }));
});

/* ---------- Where the money goes ---------- */
dash.draw('period-bars', (el) => {
  if (placeholder(el, firstNotOk('periods', 'plans'))) return;
  const mine = forView('periods');
  const rows = [...DAY_ORDER, 'Supply charge'].map((p) => mine.find((r) => r.part === p)).filter(Boolean);
  if (!rows.length) { el.replaceChildren(); return; }
  const bars = [{label: 'Electricity used', key: 'kWhShare'}, {label: 'Cost', key: 'costShare'}];
  const barH = 28, gap = 14, H = bars.length * barH + (bars.length - 1) * gap + 4;
  const {svg, W} = chartBox(el, H, 'Two bars comparing each rate period’s share of the electricity used with its share of the cost, including the supply charge.');
  const ml = Math.ceil(textWidth(svg, bars.map((b) => b.label))) + 12, mr = 2;
  const x = d3.scaleLinear([0, 100], [ml, W - mr]);
  const tip = makeTip(el);
  bars.forEach((b, i) => {
    const y0 = 2 + i * (barH + gap);
    svg.append('g').attr('class', 'eu-axis').append('text').attr('x', 0).attr('y', y0 + barH / 2).attr('dy', '0.32em').text(b.label);
    const parts = rows.filter((r) => r[b.key] != null);
    const total = d3.sum(parts, (r) => r[b.key]) || 100;
    let acc = 0;
    for (const r of parts) {
      const w = (r[b.key] / total) * 100;
      const g = svg.append('g');
      g.append('rect').attr('x', x(acc)).attr('y', y0).attr('width', Math.max(0, x(acc + w) - x(acc) - 1)).attr('height', barH)
        .style('fill', COLOR[r.part] || 'var(--color-fg-muted)')
        .on('pointerenter pointermove', (event) => tip.show(event, `${r.part}, ${r.hours}`, [
          {label: 'Share of kWh', value: pct(r.kWhShare)},
          {label: 'Share of cost', value: pct(r.costShare)},
          {label: 'kWh', value: r.kWh == null ? '—' : kwh(r.kWh, f0)},
          {label: 'Cost', value: usd(r.cost)},
        ], `${f4(r.rate)}¢ ${r.unit}`))
        .on('pointerleave', () => tip.hide());
      const lab = g.append('text').attr('class', `eu-seglab${r.part === 'Supply charge' ? ' eu-seglab-dark' : ''}`)
        .attr('x', x(acc) + 6).attr('y', y0 + barH / 2).attr('dy', '0.32em').text(`${f0(r[b.key])}%`);
      if (lab.node().getComputedTextLength() > x(acc + w) - x(acc) - 10) lab.remove();
      acc += w;
    }
  });
}, {deps: ['range', 'tariff']});

dash.draw('period-rows', (tbody) => {
  const rows = forView('periods');
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.dataset.key = `${encKey(r.range)},${encKey(r.tariff)},${encKey(r.part)}`;
    tr.append(
      nameCell(r.part, null, COLOR[r.part] || 'var(--color-fg-muted)'),
      cell(r.hours),
      cell(`${r.varies ? 'avg ' : ''}${f4(r.rate)} ${r.unit}`, 'eu-num'),
      cell(r.kWh == null ? '—' : f1(r.kWh), 'eu-num'),
      cell(pct(r.kWhShare), 'eu-num'),
      cell(r.cost < 0 ? `−${money(-r.cost)}` : money(r.cost), 'eu-num'),
      cell(pct(r.costShare), 'eu-num'),
    );
    return tr;
  }));
});

/* ---------- Selected day ---------- */
function dayField(name, key, show) {
  dash.draw(name, (el) => {
    const s = firstNotOk('daily', 'plans');
    settle(el, s);
    const d = selectedDay(forTariff('daily'));
    if (!d || d[key] == null) { el.textContent = '—'; return; }
    putMark(el, 'daily', key, `tariff=${enc(d.tariff)}&date=${d.date}`, show(d[key]));
  });
}
dayField('day-total', 'total', f1);
dayField('day-off', 'offPeak', f1);
dayField('day-super', 'superOffPeak', f1);
dayField('day-peak', 'peak', f1);
dayField('day-cost', 'cost', money);
dayField('day-off-cost', 'offPeakCost', money);
dayField('day-super-cost', 'superOffPeakCost', money);
dayField('day-peak-cost', 'peakCost', money);
dayField('day-supply', 'supply', money);
dayField('day-status', 'status', (v) => v);

dash.draw('day-pick', (sel) => {
  const days = forTariff('daily');
  const cur = selectedDay(days);
  sel.replaceChildren(...days.map((d) => new Option(asDate(d.date, fmtFull), d.date)));
  if (cur) sel.value = cur.date;
  sel.disabled = !days.length;
  sel.onchange = () => dash.setParams({day: sel.value});
});

/* ---------- Use per day ---------- */
dash.draw('daily-chart', (el) => {
  if (placeholder(el, firstNotOk('daily', 'plans'))) return;
  const days = forTariff('daily');
  if (!days.length) { el.replaceChildren(); return; }
  const cost = isCost();
  const totalKey = cost ? 'cost' : 'total', avgKey = cost ? 'avg7Cost' : 'avg7';
  const stack = cost
    ? [{k: 'supplyNet', color: 'var(--eu-supply)'}, ...[...PERIODS].reverse().map((p) => ({k: p.costKey, color: p.color}))]
    : [...PERIODS].reverse().map((p) => ({k: p.key, color: p.color}));
  const H = el.clientWidth < 560 ? 250 : 310;
  const top = 28, bottom = H - 24;
  const {svg, W} = chartBox(el, H,
    `Bar chart of ${cost ? 'cost, with supply,' : 'kWh used'} each day from ${asDate(days[0].date)} to ${asDate(days[days.length - 1].date)}, split by rate period, with a 7-day average line.`);
  const y = d3.scaleLinear().domain([0, d3.max(days, (d) => d[totalKey]) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(H < 280 ? 4 : 5);
  const fmt = axisFmt(yt, cost);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 4;
  const x = d3.scaleBand(days.map((d) => d.date), [ml, W - mr]).paddingInner(0.18);
  const slot = (date) => x(date) - (x.step() - x.bandwidth()) / 2;
  const cx = (date) => x(date) + x.bandwidth() / 2;

  yAxis(svg, y, yt, fmt, ml, W - mr, cost ? 'Cost per day' : 'kWh per day');

  const sel = selectedDay(days);
  if (sel) svg.append('rect').attr('class', 'eu-sel').attr('x', slot(sel.date)).attr('width', x.step()).attr('y', top - 6).attr('height', bottom - top + 6);
  const hover = svg.append('rect').attr('class', 'eu-hov').attr('width', x.step()).attr('y', top - 6).attr('height', bottom - top + 6).attr('visibility', 'hidden');

  const bars = svg.append('g');
  for (const d of days) {
    let acc = 0;
    for (const p of stack) {
      const v = d[p.k] || 0;
      bars.append('rect')
        .attr('x', x(d.date)).attr('width', x.bandwidth())
        .attr('y', y(acc + v)).attr('height', Math.max(0, y(acc) - y(acc + v)))
        .style('fill', p.color);
      acc += v;
    }
  }

  const firstOpen = days.findIndex((d) => d.status && d.status !== 'Billed');
  if (firstOpen > 0) {
    const bx = slot(days[firstOpen].date);
    svg.append('line').attr('class', 'eu-ref').attr('x1', bx).attr('x2', bx).attr('y1', top - 12).attr('y2', bottom);
    const lab = svg.append('text').attr('class', 'eu-reflab').attr('x', bx + 5).attr('y', top - 14).text('Not yet billed →');
    if (bx + 5 + lab.node().getComputedTextLength() > W - mr) lab.attr('x', W - mr).attr('text-anchor', 'end');
  }

  const avgLine = d3.line().defined((d) => d[avgKey] != null).x((d) => cx(d.date)).y((d) => y(d[avgKey]));
  svg.append('path').datum(days).attr('class', 'eu-halo').attr('d', avgLine);
  svg.append('path').datum(days).attr('class', 'eu-avg').attr('d', avgLine);
  const lastAvg = [...days].reverse().find((d) => d[avgKey] != null);
  if (lastAvg) svg.append('circle').attr('class', 'eu-avgdot').attr('cx', cx(lastAvg.date)).attr('cy', y(lastAvg[avgKey])).attr('r', 3.5);

  xLabels(svg, dateTicks(days.map((d) => d.date), x.step()), cx, H - 6, W, (d) => asDate(d));

  const tip = makeTip(el);
  svg.append('g').selectAll('rect').data(days).join('rect')
    .attr('class', 'eu-hit')
    .attr('x', (d) => slot(d.date)).attr('width', x.step()).attr('y', 0).attr('height', bottom)
    .attr('fill', 'transparent')
    .on('pointerenter pointermove', (event, d) => {
      hover.attr('x', slot(d.date)).attr('visibility', 'visible');
      const rows = PERIODS.map((p) => ({label: p.name, value: both(d[p.key], d[p.costKey]), swatch: p.color}));
      rows.push({label: 'Supply charge', value: usd(d.supply), swatch: 'var(--eu-supply)'});
      if (d.credit) rows.push({label: 'Daily credit', value: `−${usd(d.credit)}`});
      rows.push({label: 'Total', value: both(d.total, d.cost), strong: true});
      if (d.avg7 != null) rows.push({label: '7-day average', value: both(d.avg7, d.avg7Cost), line: 'solid'});
      tip.show(event, asDate(d.date, fmtFull), rows, d.status);
    })
    .on('pointerleave', () => {
      hover.attr('visibility', 'hidden');
      tip.hide();
    })
    .on('click', (event, d) => dash.setParams({day: d.date}));
}, {deps: ['range', 'tariff', 'measure', 'day']});

/* ---------- Half-hour by half-hour ---------- */
dash.draw('day-chart', (el) => {
  if (placeholder(el, firstNotOk('halfHours', 'profile', 'plans'))) return;
  const all = forTariff('halfHours');
  if (!all.length) { el.replaceChildren(); return; }
  const cost = isCost();
  const key = cost ? 'cost' : 'kWh';
  const date = pickDate([...new Set(all.map((r) => r.date))].sort());
  const rows = all.filter((r) => r.date === date).sort((a, b) => (a.time < b.time ? -1 : 1));
  const avg = new Map(forView('profile').map((r) => [r.time, r]));
  const avgOf = (t) => {
    const a = avg.get(t);
    return a ? a[cost ? 'allCost' : 'all'] : null;
  };
  const H = el.clientWidth < 560 ? 230 : 270;
  const top = 24, bottom = H - 24;
  const {svg, W} = chartBox(el, H,
    `Bar chart of ${cost ? 'energy cost' : 'kWh used'} in each half-hour on ${asDate(date, fmtLong)}, by rate period, with the average for each half-hour across all days as a dashed line.`);
  const y = d3.scaleLinear().domain([0, d3.max(all, (r) => r[key]) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, cost);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 4;
  const times = rows.map((r) => r.time);
  const x = d3.scaleBand(times, [ml, W - mr]).paddingInner(0.15);
  const cx = (t) => x(t) + x.bandwidth() / 2;
  const slot = (t) => x(t) - (x.step() - x.bandwidth()) / 2;

  yAxis(svg, y, yt, fmt, ml, W - mr, cost ? 'Energy cost per half-hour' : 'kWh per half-hour');
  const hover = svg.append('rect').attr('class', 'eu-hov').attr('width', x.step()).attr('y', top).attr('height', bottom - top).attr('visibility', 'hidden');

  svg.append('g').selectAll('rect').data(rows).join('rect')
    .attr('x', (r) => x(r.time)).attr('width', x.bandwidth())
    .attr('y', (r) => y(r[key] || 0)).attr('height', (r) => Math.max(0, y(0) - y(r[key] || 0)))
    .style('fill', (r) => COLOR[r.period] || 'var(--color-fg-muted)');

  const avgLine = d3.line().defined((t) => avgOf(t) != null).x(cx).y((t) => y(avgOf(t)));
  svg.append('path').datum(times).attr('class', 'eu-halo').attr('d', avgLine).style('stroke-width', 3.5);
  svg.append('path').datum(times).attr('class', 'eu-avgdash').attr('d', avgLine);

  const every = W < 560 ? 6 : 3;
  const ticks = times.filter((t) => t.endsWith(':00') && Number(t.slice(0, 2)) % every === 0);
  xLabels(svg, ticks, slot, H - 6, W, (t) => t);

  const tip = makeTip(el);
  svg.append('g').selectAll('rect').data(rows).join('rect')
    .attr('x', (r) => slot(r.time)).attr('width', x.step()).attr('y', 0).attr('height', bottom)
    .attr('fill', 'transparent')
    .on('pointerenter pointermove', (event, r) => {
      hover.attr('x', slot(r.time)).attr('visibility', 'visible');
      const a = avg.get(r.time);
      tip.show(event, `${r.time}–${endOf(r.time)}`, [
        {label: r.period, value: both(r.kWh, r.cost, f2), swatch: COLOR[r.period]},
        {label: 'Average, all days', value: a ? both(a.all, a.allCost, f2) : '—', line: 'dash'},
      ], asDate(r.date, fmtDay));
    })
    .on('pointerleave', () => {
      hover.attr('visibility', 'hidden');
      tip.hide();
    });
}, {deps: ['range', 'tariff', 'measure', 'day']});

/* ---------- Every half-hour ---------- */
dash.draw('heatmap', (el) => {
  if (placeholder(el, firstNotOk('halfHours', 'plans'))) return;
  const rows = forTariff('halfHours');
  if (!rows.length) { el.replaceChildren(); return; }
  const cost = isCost();
  const key = cost ? 'cost' : 'kWh';
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const times = [...new Set(rows.map((r) => r.time))].sort();
  const periodAt = new Map();
  for (const r of rows) if (!periodAt.has(r.time)) periodAt.set(r.time, r.period);
  const byCell = new Map(rows.map((r) => [`${r.date} ${r.time}`, r]));
  const size = el.clientWidth < 560 ? 5 : 6;
  const top = 8, plotH = times.length * size, H = top + plotH + 28;
  const {svg, W} = chartBox(el, H,
    `Heat map of ${cost ? 'energy cost' : 'kWh'} in every half-hour from ${asDate(dates[0])} to ${asDate(dates[dates.length - 1])}: one column per day, one row per half-hour, midnight at the top.`);
  const yl = times.filter((t) => /^(00|06|12|18):00$/.test(t));
  const ml = Math.ceil(textWidth(svg, yl)) + 22, mr = 4;
  const x = d3.scaleBand(dates, [ml, W - mr]);
  const y = d3.scaleBand(times, [top, top + plotH]);
  const hi = d3.max(rows, (r) => r[key]) || 1;
  const op = d3.scaleLinear().domain([0, hi]).range([0.05, 1]);

  svg.append('g').selectAll('rect').data(times).join('rect')
    .attr('x', ml - 10).attr('width', 6).attr('y', (t) => y(t)).attr('height', y.bandwidth() + 0.5)
    .attr('shape-rendering', 'crispEdges')
    .style('fill', (t) => COLOR[periodAt.get(t)] || 'var(--color-fg-muted)');
  svg.append('g').attr('class', 'eu-axis').selectAll('text').data(yl).join('text')
    .attr('x', ml - 16).attr('y', (t) => y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').text((t) => t);

  svg.append('g').attr('shape-rendering', 'crispEdges').style('fill', 'var(--color-fg)')
    .selectAll('rect').data(rows).join('rect')
    .attr('x', (r) => x(r.date)).attr('y', (r) => y(r.time))
    .attr('width', x.bandwidth() + 0.5).attr('height', y.bandwidth() + 0.5)
    .attr('fill-opacity', (r) => op(r[key] || 0));

  const sel = pickDate(dates);
  ring(svg, x.bandwidth() + 2, plotH + 2).attr('visibility', 'visible').attr('transform', `translate(${x(sel) - 1},${top - 1})`);
  const hl = ring(svg, x.bandwidth() + 2, y.bandwidth() + 2);

  xLabels(svg, dateTicks(dates, x.step()), (d) => x(d) + x.bandwidth() / 2, H - 6, W, (d) => asDate(d));

  const tip = makeTip(el);
  const find = (event) => {
    const [px, py] = d3.pointer(event, svg.node());
    const i = Math.floor((px - ml) / x.step()), j = Math.floor((py - top) / y.step());
    if (i < 0 || i >= dates.length || j < 0 || j >= times.length) return null;
    return byCell.get(`${dates[i]} ${times[j]}`) || null;
  };
  svg.append('rect').attr('class', 'eu-hit')
    .attr('x', ml).attr('y', top).attr('width', Math.max(0, W - mr - ml)).attr('height', plotH)
    .attr('fill', 'transparent')
    .on('pointerenter pointermove', (event) => {
      const r = find(event);
      if (!r) { hl.attr('visibility', 'hidden'); tip.hide(); return; }
      hl.attr('transform', `translate(${x(r.date) - 1},${y(r.time) - 1})`).attr('visibility', 'visible');
      tip.show(event, `${asDate(r.date, fmtDay)}, ${r.time}–${endOf(r.time)}`, [
        {label: r.period, value: both(r.kWh, r.cost, f2), swatch: COLOR[r.period]},
      ], r.status);
    })
    .on('pointerleave', () => {
      hl.attr('visibility', 'hidden');
      tip.hide();
    })
    .on('click', (event) => {
      const r = find(event);
      if (r) dash.setParams({day: r.date});
    });

  const leg = document.createElement('div');
  leg.className = 'eu-heatleg';
  const lab = document.createElement('span');
  lab.textContent = cost ? 'Energy cost per half-hour: $0' : 'kWh per half-hour: 0';
  const ramp = document.createElement('span');
  ramp.className = 'eu-ramp';
  for (let k = 0; k < 6; k += 1) {
    const sw = document.createElement('i');
    sw.style.opacity = String(op((hi * k) / 5));
    ramp.append(sw);
  }
  const max = document.createElement('span');
  max.textContent = cost ? money(hi) : f2(hi);
  leg.append(lab, ramp, max);
  el.append(leg);
}, {deps: ['range', 'tariff', 'measure', 'day']});

/* ---------- An average day ---------- */
dash.draw('profile-chart', (el) => {
  if (placeholder(el, firstNotOk('profile', 'plans'))) return;
  const rows = forView('profile');
  if (!rows.length) { el.replaceChildren(); return; }
  const cost = isCost();
  const wdKey = cost ? 'weekdayCost' : 'weekday', weKey = cost ? 'weekendCost' : 'weekend';
  const H = el.clientWidth < 560 ? 240 : 280;
  const top = 44, bottom = H - 24;
  const {svg, W} = chartBox(el, H,
    `Line chart of average ${cost ? 'energy cost' : 'kWh'} in each half-hour of the day for weekdays and weekends, with the off-peak, super off-peak and peak hours shaded.`);
  const yMax = d3.max(rows, (r) => Math.max(r[wdKey] ?? 0, r[weKey] ?? 0)) || 1;
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, cost);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 8;
  const x = d3.scaleLinear([0, rows.length], [ml, W - mr]);
  const cx = (i) => x(i + 0.5);

  const runs = [];
  rows.forEach((r, i) => {
    const last = runs[runs.length - 1];
    if (last && last.period === r.period) last.end = i + 1;
    else runs.push({period: r.period, start: i, end: i + 1});
  });
  svg.append('g').selectAll('rect').data(runs).join('rect')
    .attr('x', (r) => x(r.start)).attr('width', (r) => x(r.end) - x(r.start))
    .attr('y', top - 22).attr('height', bottom - top + 22)
    .style('fill', (r) => COLOR[r.period] || 'var(--color-fg-muted)').attr('fill-opacity', 0.14);
  const bl = svg.append('g').attr('class', 'eu-axis');
  for (const r of runs) {
    const t = bl.append('text').attr('x', x(r.start) + 6).attr('y', top - 8).text(r.period);
    if (t.node().getComputedTextLength() > x(r.end) - x(r.start) - 10) t.remove();
  }

  yAxis(svg, y, yt, fmt, ml, W - mr, cost ? 'Energy cost per half-hour' : 'kWh per half-hour');

  const line = (k) => d3.line().defined((r) => r[k] != null).x((r, i) => cx(i)).y((r) => y(r[k]));
  svg.append('path').datum(rows).attr('class', 'eu-halo').attr('d', line(weKey));
  svg.append('path').datum(rows).attr('class', 'eu-we').attr('d', line(weKey));
  svg.append('path').datum(rows).attr('class', 'eu-halo').attr('d', line(wdKey));
  svg.append('path').datum(rows).attr('class', 'eu-wd').attr('d', line(wdKey));

  const step = W < 560 ? 12 : 6;
  const xt = d3.range(0, rows.length + 1, step);
  xLabels(svg, xt, (i) => x(i), H - 6, W, (i) => (i >= rows.length ? '24:00' : rows[i].time));

  const rule = svg.append('line').attr('class', 'eu-rule').attr('y1', top - 22).attr('y2', bottom).attr('visibility', 'hidden');
  const dotWd = svg.append('circle').attr('class', 'eu-dot').attr('r', 3.5).attr('visibility', 'hidden');
  const dotWe = svg.append('circle').attr('class', 'eu-dot eu-dot-we').attr('r', 3.5).attr('visibility', 'hidden');
  const tip = makeTip(el);
  svg.append('rect').attr('class', 'eu-hit')
    .attr('x', ml).attr('y', 0).attr('width', Math.max(0, W - mr - ml)).attr('height', bottom)
    .attr('fill', 'transparent')
    .on('pointerenter pointermove', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const i = Math.max(0, Math.min(rows.length - 1, Math.floor(x.invert(px))));
      const r = rows[i];
      rule.attr('x1', cx(i)).attr('x2', cx(i)).attr('visibility', 'visible');
      if (r[wdKey] != null) dotWd.attr('cx', cx(i)).attr('cy', y(r[wdKey])).attr('visibility', 'visible');
      if (r[weKey] != null) dotWe.attr('cx', cx(i)).attr('cy', y(r[weKey])).attr('visibility', 'visible');
      tip.show(event, `${r.time}–${endOf(r.time)}`, [
        {label: 'Weekdays', value: both(r.weekday, r.weekdayCost, f2), line: 'solid'},
        {label: 'Weekends', value: both(r.weekend, r.weekendCost, f2), line: 'dash'},
      ], r.period);
    })
    .on('pointerleave', () => {
      rule.attr('visibility', 'hidden');
      dotWd.attr('visibility', 'hidden');
      dotWe.attr('visibility', 'hidden');
      tip.hide();
    });
}, {deps: ['range', 'tariff', 'measure']});

/* ---------- What moving peak use would save ---------- */
function shiftField(name, key, show) {
  dash.draw(name, (el) => {
    const s = firstNotOk('shift', 'plans');
    settle(el, s);
    const {target, pct: share} = shiftChoice();
    const r = forView('shift').find((x) => x.target === target && x.pct === share);
    if (!r || r[key] == null) { el.textContent = '—'; return; }
    putMark(el, 'shift', key, `${viewWhere()}&target=${enc(target)}&pct=${share}`, show(r[key]));
  });
}
shiftField('shift-pct', 'pct', (v) => `${v}%`);
shiftField('shift-kwh', 'kWhPerDay', f1);
shiftField('shift-saving', 'saving', money);
shiftField('shift-day', 'savingPerDay', money);
shiftField('shift-30', 'savingPer30', money);

/* ---------- Month by month ---------- */
dash.draw('month-rows', (tbody) => {
  const rows = forView('monthly');
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.dataset.key = `${encKey(r.range)},${encKey(r.tariff)},${r.month}`;
    tr.append(
      withSort(cell(asDate(`${r.month}-01`, fmtMonth)), r.month),
      cell(f0(r.days), 'eu-num'),
      cell(f1(r.kWh), 'eu-num'),
      cell(f1(r.kWhPerDay), 'eu-num'),
      cell(money(r.energy), 'eu-num'),
      cell(money(r.supply), 'eu-num'),
      cell(money(r.cost), 'eu-num eu-strong'),
      cell(money(r.costPerDay), 'eu-num'),
      cell(r.kWhPerDayLastYear == null ? '—' : f1(r.kWhPerDayLastYear), 'eu-num'),
      changeCell(r.kWhChange),
    );
    return tr;
  }));
});
// A percentage change, red when use went up and green when it went down.
function changeCell(v) {
  const td = cell(v == null ? '—' : `${fSigned(v)}%`, 'eu-num');
  if (v != null && v !== 0) td.classList.add(v > 0 ? 'eu-bad' : 'eu-good');
  return td;
}

/* ---------- By day of the week ---------- */
dash.draw('weekday-chart', (el) => {
  if (placeholder(el, firstNotOk('weekdays', 'plans'))) return;
  const rows = forView('weekdays').filter((r) => r.days > 0);
  if (!rows.length) { el.replaceChildren(); return; }
  const cost = isCost();
  const key = cost ? 'cost' : 'kWh';
  const H = 220, top = 30, bottom = H - 24;
  const {svg, W} = chartBox(el, H, `Bar chart of the average ${cost ? 'cost, with supply,' : 'kWh'} per day for each day of the week.`);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => r[key]) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, cost);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 4;
  const x = d3.scaleBand(rows.map((r) => r.day), [ml, W - mr]).paddingInner(0.3).paddingOuter(0.1);
  yAxis(svg, y, yt, fmt, ml, W - mr, cost ? 'Cost per day' : 'kWh per day');

  let vfmt = cost ? money : f1;
  if (textWidth(svg, rows.map((r) => vfmt(r[key])), 'eu-vlab') > x.step() - 4) vfmt = cost ? money0 : f0;
  const tip = makeTip(el);
  const full = {Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays'};
  const g = svg.append('g');
  for (const r of rows) {
    g.append('rect').attr('class', r.day === 'Sat' || r.day === 'Sun' ? 'eu-wkbar eu-wkbar-on' : 'eu-wkbar')
      .attr('x', x(r.day)).attr('width', x.bandwidth())
      .attr('y', y(r[key])).attr('height', Math.max(0, y(0) - y(r[key])))
      .on('pointerenter pointermove', (event) => tip.show(event, full[r.day] || r.day, [
        {label: 'Average kWh', value: kwh(r.kWh)},
        {label: 'Average cost', value: usd(r.cost)},
      ], `${r.days} in the file`))
      .on('pointerleave', () => tip.hide());
    g.append('text').attr('class', 'eu-vlab').attr('x', x(r.day) + x.bandwidth() / 2).attr('y', y(r[key]) - 6)
      .attr('text-anchor', 'middle').text(vfmt(r[key]));
  }
  xLabels(svg, rows.map((r) => r.day), (d) => x(d) + x.bandwidth() / 2, H - 6, W, (d) => d);
}, {deps: ['range', 'tariff', 'measure']});

/* ---------- Unusual usage ---------- */
const ANOM_SHOWN = 12;
const plural = (n, one, many = `${one}s`) => `${f0(n)} ${n === 1 ? one : many}`;
const listOf = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const duration = (halfHours) => {
  const m = halfHours * 30, h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};
const signedKWh = (v, f = f1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))} kWh`;
const signedUsd = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v))}`;
// The tariff's price per kWh averaged over the day, weighting each rate by its hours.
const dayRate = (p) => (6 * p.peakCents + 6 * p.superOffPeakCents + 12 * p.offPeakCents) / 24 / 100;
const inChosen = (rows) => {
  const g = selRangeRow();
  return g ? rows.filter((r) => r.date >= g.from && r.date <= g.to) : [];
};

// Everything that stood out in the chosen dates, with its cost on the chosen tariff.
function findings() {
  const p = selPlan(), g = selRangeRow();
  if (!p) return null;
  return memo(`findings|${p.tariff}|${g ? `${g.from}|${g.to}` : ''}`, () => findingsFor(p));
}
function findingsFor(p) {
  const now = selRates();
  const days = inChosen(rowsOf('usualDays'));
  const totals = new Map(forTariff('dayTotals').map((d) => [d.date, d]));
  const list = [];
  for (const d of days) {
    if (!d.flag) continue;
    const t = totals.get(d.date);
    const extra = d.kWh - d.usual;
    list.push({
      kind: d.flag, date: d.date, when: asDate(d.date, fmtDay), sortWhen: d.date,
      usedN: d.kWh, usualN: d.usual, diffN: extra,
      what: d.flag === 'high' ? 'High-use day' : 'Low-use day',
      used: kwh(d.kWh), usual: kwh(d.usual), diff: signedKWh(extra),
      cost: t && t.kWh ? extra * (t.energy / t.kWh) : null,
    });
  }
  const spikes = inChosen(rowsOf('spikes'));
  for (const e of spikes) {
    list.push({
      kind: 'spike', date: e.date, when: `${asDate(e.date, fmtDay)}, ${e.start}–${e.end}`, sortWhen: `${e.date} ${e.start}`,
      usedN: e.kWh, usualN: e.usual, diffN: e.extra,
      what: `Spike for ${duration(e.halfHours)}, up to ${f1(e.peakKW)} kW`,
      used: kwh(e.kWh, f2), usual: kwh(e.usual, f2), diff: signedKWh(e.extra, f2),
      cost: (() => {
        const r = ratesOn(p, e.date);
        return (e.extraPeak * r.peakCents + e.extraOffPeak * r.offPeakCents + e.extraSuperOffPeak * r.superOffPeakCents) / 100;
      })(),
    });
  }
  const runs = [];
  for (const d of days) {
    if (!d.baseRaised) continue;
    const last = runs[runs.length - 1];
    if (last && dayGap(last[last.length - 1].date, d.date) === 1) last.push(d);
    else runs.push([d]);
  }
  // A stretch of raised always-on use: the always-on part of use, its watts kept up for 24 hours
  // a day, against the usual watts. Other use can rise or fall at the same time, so the note
  // gives what all use on those days came to against usual.
  for (const run of runs) {
    const used = d3.sum(run, (d) => (d.baseW * 24) / 1000), usual = d3.sum(run, (d) => (d.usualW * 24) / 1000);
    const allDiff = d3.sum(run, (d) => d.kWh - d.usual);
    const a = run[0].date, b = run[run.length - 1].date;
    list.push({
      kind: 'base', date: a, when: a === b ? asDate(a, fmtDay) : `${asDate(a, fmtDay)} – ${asDate(b, fmtDay)}`, sortWhen: a,
      what: `Always-on use ${f0(d3.mean(run, (d) => d.baseW))} W for ${plural(run.length, 'day')}, usually ${f0(d3.mean(run, (d) => d.usualW))} W`,
      note: `All use on those days: ${signedKWh(allDiff)} against usual`,
      used: kwh(used), usual: kwh(usual), diff: signedKWh(used - usual),
      usedN: used, usualN: usual, diffN: used - usual, cost: (used - usual) * dayRate(now),
    });
  }
  list.sort((x, y) => Math.abs(y.cost || 0) - Math.abs(x.cost || 0) || (x.date < y.date ? -1 : 1));
  const flagged = days.filter((d) => d.flag);
  return {
    list, days, plan: p, rates: now,
    judged: days.filter((d) => d.judged).length,
    high: flagged.filter((d) => d.flag === 'high').length,
    low: flagged.filter((d) => d.flag === 'low').length,
    spikes: spikes.length, runs: runs.length,
    baseW: d3.median(days, (d) => d.baseW),
  };
}

const anomParts = (f) => {
  const parts = [];
  if (f.high + f.low) parts.push(plural(f.high + f.low, 'unusual day'));
  if (f.spikes) parts.push(plural(f.spikes, 'spike'));
  if (f.runs) parts.push(plural(f.runs, 'stretch', 'stretches') + ' of raised always-on use');
  return parts;
};

dash.draw('anom-lede', (el) => {
  settle(el, firstNotOk('usualDays', 'spikes', 'ranges'));
  const f = findings();
  if (!f || !f.days.length) { el.textContent = '—'; return; }
  const b = (t) => { const x = document.createElement('b'); x.textContent = t; return x; };
  if (!f.judged) {
    el.replaceChildren('There aren’t enough complete days around these dates to say what’s usual. It takes at least ', b(`${MIN_NEAR + 1} days`), ' of readings.');
    return;
  }
  if (!f.list.length) {
    el.replaceChildren('Nothing stood out in these dates: every day, every half-hour and the always-on use stayed within what’s usual for the weeks around them.');
    return;
  }
  const bits = [];
  if (f.high) bits.push([b(plural(f.high, 'day')), ' used much more than usual']);
  if (f.low) bits.push(f.high ? [b(f0(f.low)), ' used much less'] : [b(plural(f.low, 'day')), ' used much less than usual']);
  if (f.spikes) bits.push([b(plural(f.spikes, 'spike')), ' went far above what that time of day usually reaches']);
  if (f.runs) bits.push(['always-on use was raised for ', b(plural(f.runs, 'stretch', 'stretches')), ' of 3 days or more']);
  const top = f.list[0];
  const nodes = ['Compared with the weeks around them, '];
  bits.forEach((bit, i) => {
    if (i) nodes.push(i === bits.length - 1 ? ' and ' : ', ');
    nodes.push(...bit);
  });
  nodes.push('. The biggest difference was ', b(top.when), ` (${top.what.charAt(0).toLowerCase()}${top.what.slice(1)})`);
  if (top.cost != null) nodes.push(': ', b(signedUsd(top.cost)), ' against usual');
  nodes.push('.');
  el.replaceChildren(...nodes);
});

dash.draw('anom-base', (el) => {
  settle(el, firstNotOk('usualDays', 'plans', 'ranges'));
  const f = findings();
  if (!f || f.baseW == null) { el.replaceChildren(); return; }
  const yearKWh = (f.baseW * 24 * 365) / 1000;
  const b = (t) => { const x = document.createElement('b'); x.textContent = t; return x; };
  el.replaceChildren('Always-on use, the least the home draws at any time of day, was usually about ', b(`${f0(f.baseW)} W`),
    '. Kept up all year that is ', b(`${f0(yearKWh)} kWh`), ', or about ', b(money0(yearKWh * dayRate(f.rates))),
    ` on ${f.plan.tariff}: fridges, standby, pumps and anything else that never turns off.`);
});

dash.draw('anom-count', (el) => {
  settle(el, firstNotOk('usualDays', 'spikes', 'ranges'));
  const f = findings();
  el.textContent = !f || !f.judged ? '—' : f.list.length ? f0(f.list.length) : 'None';
});
dash.draw('anom-unit', (el) => {
  const f = findings();
  el.textContent = f && f.judged && f.list.length ? (f.list.length === 1 ? ' thing stood out' : ' things stood out') : '';
});
dash.draw('anom-sub', (el) => {
  const f = findings();
  if (!f || !f.judged) { el.textContent = 'Needs more days of readings.'; return; }
  const parts = anomParts(f);
  el.textContent = parts.length ? `${listOf(parts)}.` : 'Nothing out of the ordinary in these dates.';
});

dash.draw('anom-rows', (tbody) => {
  const f = findings();
  if (!f) { tbody.replaceChildren(); return; }
  const all = !!(dash.params() || {}).anomAll;
  const spec = sortSpec('anom-table');
  const keys = [(r) => r.sortWhen, (r) => r.what.toLowerCase(), (r) => r.usedN, (r) => r.usualN, (r) => r.diffN, (r) => r.cost];
  const list = spec && keys[spec.col] ? sortBy(f.list, keys[spec.col], spec.dir) : f.list;
  const shown = all ? list : list.slice(0, ANOM_SHOWN);
  if (!shown.length) {
    const tr = document.createElement('tr');
    const td = cell(f.judged ? 'Nothing stood out in these dates.' : 'Not enough days to tell yet.', 'eu-muted');
    td.colSpan = 6;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren(...shown.map((r) => {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eu-daylink';
    btn.textContent = r.when;
    btn.setAttribute('aria-label', `${r.when}: show this day’s half-hours`);
    btn.addEventListener('click', () => {
      dash.setParams({day: r.date});
      const target = document.getElementById('day');
      if (target) target.scrollIntoView({behavior: 'smooth', block: 'start'});
    });
    when.append(btn);
    const what = document.createElement('td');
    const k = document.createElement('span');
    k.className = `eu-kind eu-kind-${r.kind}`;
    k.append(document.createElement('i'), r.what);
    what.append(k);
    if (r.note) {
      const note = document.createElement('span');
      note.className = 'eu-subnote';
      note.textContent = r.note;
      what.append(note);
    }
    tr.append(when, what, cell(r.used, 'eu-num'), cell(r.usual, 'eu-num'), cell(r.diff, 'eu-num'),
      cell(r.cost == null ? '—' : signedUsd(r.cost), 'eu-num eu-strong'));
    return tr;
  }));
});

dash.draw('anom-more', (el) => {
  const f = findings();
  const n = f ? f.list.length : 0;
  if (n <= ANOM_SHOWN) { el.replaceChildren(); return; }
  const all = !!(dash.params() || {}).anomAll;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'eu-btn eu-more';
  btn.textContent = all ? `Show the ${sortSpec('anom-table') ? 'first' : 'biggest'} ${ANOM_SHOWN}` : `Show all ${f0(n)}`;
  btn.setAttribute('aria-controls', 'anom-table');
  btn.addEventListener('click', () => dash.setParams({anomAll: !all}));
  el.replaceChildren(btn);
});

function anomAxisX(svg, days, W, ml, mr) {
  const x = d3.scaleBand(days.map((d) => d.date), [ml, W - mr]).paddingInner(0.2);
  return {x, cx: (date) => x(date) + x.bandwidth() / 2};
}
function anomHits(svg, el, days, x, top, bottom, tipFor) {
  const hover = svg.insert('rect', ':first-child').attr('class', 'eu-hov').attr('width', x.step()).attr('y', top - 6).attr('height', bottom - top + 6).attr('visibility', 'hidden');
  const slot = (date) => x(date) - (x.step() - x.bandwidth()) / 2;
  const sel = selectedDay(days);
  if (sel) svg.insert('rect', ':first-child').attr('class', 'eu-sel').attr('x', slot(sel.date)).attr('width', x.step()).attr('y', top - 6).attr('height', bottom - top + 6);
  const tip = makeTip(el);
  svg.append('g').selectAll('rect').data(days).join('rect')
    .attr('class', 'eu-hit').attr('fill', 'transparent')
    .attr('x', (d) => slot(d.date)).attr('width', x.step()).attr('y', 0).attr('height', bottom)
    .on('pointerenter pointermove', (event, d) => {
      hover.attr('x', slot(d.date)).attr('visibility', 'visible');
      const [rows, foot] = tipFor(d);
      tip.show(event, asDate(d.date, fmtFull), rows, foot);
    })
    .on('pointerleave', () => { hover.attr('visibility', 'hidden'); tip.hide(); })
    .on('click', (event, d) => dash.setParams({day: d.date}));
}

dash.draw('anom-days-chart', (el) => {
  if (placeholder(el, firstNotOk('usualDays', 'ranges'))) return;
  const days = inChosen(rowsOf('usualDays'));
  if (!days.length) { el.replaceChildren(); return; }
  const H = el.clientWidth < 560 ? 220 : 250;
  const top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H,
    `Dot chart of kWh used each day from ${asDate(days[0].date)} to ${asDate(days[days.length - 1].date)}, against a shaded usual range and a dashed usual line from the weeks around each day; much higher days are red and much lower days green.`);
  const y = d3.scaleLinear().domain([0, d3.max(days, (d) => Math.max(d.kWh, d.high || 0)) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = d3.format(',.0f');
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const {x, cx} = anomAxisX(svg, days, W, ml, mr);
  yAxis(svg, y, yt, fmt, ml, W - mr, 'kWh per day');
  const judged = (d) => d.judged;
  svg.append('path').datum(days).attr('class', 'eu-band')
    .attr('d', d3.area().defined(judged).x((d) => cx(d.date)).y0((d) => y(d.low)).y1((d) => y(d.high)).curve(d3.curveMonotoneX));
  svg.append('path').datum(days).attr('class', 'eu-usual')
    .attr('d', d3.line().defined(judged).x((d) => cx(d.date)).y((d) => y(d.usual)).curve(d3.curveMonotoneX));
  const r = Math.max(2, Math.min(3.2, x.step() / 3));
  svg.append('g').selectAll('circle').data(days).join('circle')
    .attr('class', (d) => (d.flag === 'high' ? 'eu-adot-high' : d.flag === 'low' ? 'eu-adot-low' : d.complete ? 'eu-adot' : 'eu-adot-part'))
    .attr('cx', (d) => cx(d.date)).attr('cy', (d) => y(d.kWh)).attr('r', (d) => (d.flag ? r + 2 : r));
  xLabels(svg, dateTicks(days.map((d) => d.date), x.step()), cx, H - 6, W, (d) => asDate(d));
  anomHits(svg, el, days, x, top, bottom, (d) => {
    const rows = [{label: 'Used', value: kwh(d.kWh), strong: true}];
    if (d.judged) {
      rows.push({label: 'Usual', value: kwh(d.usual), line: 'dash'});
      rows.push({label: 'Usual range', value: `${f1(d.low)}–${f1(d.high)} kWh`});
    }
    const foot = d.flag === 'high' ? 'Much more than usual' : d.flag === 'low' ? 'Much less than usual'
      : !d.complete ? 'Some half-hours missing, so not compared' : !d.judged ? 'Not enough days around it to compare' : 'Within the usual range';
    return [rows, foot];
  });
}, {deps: ['range', 'day']});

dash.draw('anom-base-chart', (el) => {
  if (placeholder(el, firstNotOk('usualDays', 'ranges'))) return;
  const days = inChosen(rowsOf('usualDays'));
  if (!days.some((d) => d.baseW != null)) { el.replaceChildren(); return; }
  const H = el.clientWidth < 560 ? 220 : 250;
  const top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H,
    `Line chart of always-on use in watts each day from ${asDate(days[0].date)} to ${asDate(days[days.length - 1].date)}, with a dashed usual line; stretches of 3 days or more well above usual are shaded red.`);
  const y = d3.scaleLinear().domain([0, d3.max(days, (d) => Math.max(d.baseW || 0, d.usualW || 0)) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = d3.format(',.0f');
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const {x, cx} = anomAxisX(svg, days, W, ml, mr);
  const slot = (date) => x(date) - (x.step() - x.bandwidth()) / 2;
  svg.append('g').selectAll('rect').data(days.filter((d) => d.baseRaised)).join('rect')
    .attr('class', 'eu-raised').attr('x', (d) => slot(d.date)).attr('width', x.step() + 0.5).attr('y', top).attr('height', bottom - top);
  yAxis(svg, y, yt, fmt, ml, W - mr, 'Watts');
  svg.append('path').datum(days).attr('class', 'eu-usual')
    .attr('d', d3.line().defined((d) => d.usualW != null).x((d) => cx(d.date)).y((d) => y(d.usualW)).curve(d3.curveMonotoneX));
  svg.append('path').datum(days).attr('class', 'eu-halo')
    .attr('d', d3.line().defined((d) => d.baseW != null).x((d) => cx(d.date)).y((d) => y(d.baseW)));
  svg.append('path').datum(days).attr('class', 'eu-aline')
    .attr('d', d3.line().defined((d) => d.baseW != null).x((d) => cx(d.date)).y((d) => y(d.baseW)));
  svg.append('g').selectAll('circle').data(days.filter((d) => d.baseRaised)).join('circle')
    .attr('class', 'eu-adot-high').attr('cx', (d) => cx(d.date)).attr('cy', (d) => y(d.baseW)).attr('r', 3.5);
  xLabels(svg, dateTicks(days.map((d) => d.date), x.step()), cx, H - 6, W, (d) => asDate(d));
  anomHits(svg, el, days, x, top, bottom, (d) => {
    if (d.baseW == null) return [[], 'Some half-hours missing, so not measured'];
    const rows = [{label: 'Always-on use', value: `${f0(d.baseW)} W`, strong: true, line: 'solid'}];
    if (d.usualW != null) rows.push({label: 'Usual', value: `${f0(d.usualW)} W`, line: 'dash'});
    return [rows, d.baseRaised ? 'Raised for 3 days or more in a row' : ''];
  });
}, {deps: ['range', 'day']});

dash.draw('data-checks', (ul) => {
  if (placeholder(ul, firstNotOk('dataChecks', 'ranges'))) return;
  const g = selRangeRow();
  const rows = inChosen(rowsOf('dataChecks'));
  if (!g || !rows.length) { ul.replaceChildren(); return; }
  const some = (list, fmt) => list.slice(0, 3).map(fmt).join(', ') + (list.length > 3 ? ' …' : '');
  const checks = [];
  const add = (ok, okText, problem) => checks.push({ok, text: ok ? okText : problem});

  // Every half-hour from 00:00 on the first chosen day to 23:30 on the last, in runs of missing ones.
  const byDate = new Map(rows.map((r) => [r.date, new Set(r.missing)]));
  const gaps = [];
  let run = null;
  for (let t = Date.parse(g.from); t <= Date.parse(g.to); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const miss = byDate.get(date);
    for (const time of DAY_SLOTS) {
      if (miss && !miss.has(time)) { run = null; continue; }
      if (run) { run.toDate = date; run.toTime = time; run.n += 1; }
      else { run = {fromDate: date, fromTime: time, toDate: date, toTime: time, n: 1}; gaps.push(run); }
    }
  }
  const gapText = (x) => {
    const whole = x.fromTime === '00:00' && x.toTime === '23:30';
    if (whole && x.fromDate === x.toDate) return `${asDate(x.fromDate, fmtFull)} (the whole day)`;
    if (whole) return `${asDate(x.fromDate, fmtFull)} – ${asDate(x.toDate, fmtFull)} (${f0(x.n / 48)} whole days)`;
    if (x.fromDate === x.toDate) return `${asDate(x.fromDate, fmtFull)}, ${x.fromTime}–${endOf(x.toTime)}`;
    return `${asDate(x.fromDate, fmtFull)} ${x.fromTime} – ${asDate(x.toDate, fmtFull)} ${endOf(x.toTime)}`;
  };
  const nMissing = d3.sum(gaps, (x) => x.n);
  add(!gaps.length, 'Every half-hour has a reading: none of the 48 a day is missing.',
    `${plural(nMissing, 'half-hour')} ${nMissing === 1 ? 'is' : 'are'} missing, in ${plural(gaps.length, 'gap')}: `
    + `${gaps.slice(0, 6).map(gapText).join('; ')}${gaps.length > 6 ? `; and ${f0(gaps.length - 6)} more` : ''}. `
    + 'Nothing is counted for those times, so use and costs are understated, and days with gaps are left out of the comparisons above.');

  const zero = rows.flatMap((r) => r.zeroRuns.map((s) => `${asDate(r.date)} ${s}`));
  add(!zero.length, 'No stretches of zero use.',
    `${plural(zero.length, 'stretch', 'stretches')} of 2 hours or more ${zero.length === 1 ? 'reads' : 'read'} zero (${some(zero, (s) => s)}). With always-on use that usually means a power cut, a meter or communications fault, or the main switch off.`);

  const same = rows.flatMap((r) => r.sameRuns.map((s) => `${asDate(r.date)} ${s}`));
  add(!same.length, 'No long runs of identical readings.',
    `${plural(same.length, 'run')} of 4 hours or more ${same.length === 1 ? 'shows' : 'show'} exactly the same reading every half-hour (${some(same, (s) => s)}). Readings like that are often estimates rather than real meter reads.`);

  const mism = rows.filter((r) => r.mismatches);
  const nMism = d3.sum(mism, (r) => r.mismatches);
  add(!nMism, 'Every reading is in the rate-period column that matches its time.',
    `${plural(nMism, 'reading')} ${nMism === 1 ? 'is' : 'are'} in a column that doesn’t match the time (such as a ${mism[0] ? mism[0].mismatchExample : ''} on ${mism[0] ? asDate(mism[0].date) : ''}). The tariff’s hours may differ from 3 pm–9 pm peak and 9 am–3 pm super off-peak, and costs here assume the columns are right.`);

  const neg = d3.sum(rows, (r) => r.negatives);
  add(!neg, 'No negative readings.', `${plural(neg, 'reading')} ${neg === 1 ? 'is' : 'are'} negative, on ${some(rows.filter((r) => r.negatives), (r) => asDate(r.date))}. ${neg === 1 ? 'It reduces' : 'They reduce'} the totals.`);

  ul.replaceChildren(...checks.map((c) => {
    const li = document.createElement('li');
    li.className = c.ok ? 'eu-check-ok' : 'eu-check-warn';
    const icon = document.createElement('span');
    icon.className = 'eu-check-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = c.ok ? '✓' : '!';
    const text = document.createElement('span');
    text.className = 'eu-check-text';
    const sr = document.createElement('span');
    sr.className = 'eu-sr';
    sr.textContent = c.ok ? 'Passed: ' : 'Check: ';
    text.append(sr, c.text);
    li.append(icon, text);
    return li;
  }));
});

/* ---------- Rates note ---------- */
dash.draw('rates-note', (el) => {
  const g = selRangeRow();
  const plans = rowsOf('plans');
  if (!g || !plans.length) { el.textContent = ''; return; }
  const notes = [];
  const early = plans.filter((p) => p.firstFrom && g.from < p.firstFrom);
  if (early.length) {
    notes.push(`The tariff list has no rates for ${listOf(early.map((p) => `${p.tariff} before ${asDate(p.firstFrom, fmtFull)}`))}, so ${early.length === 1 ? 'its' : 'their'} first rates are used for earlier days.`);
  }
  const changes = [...new Set(plans.flatMap((p) => p.rates.map((r) => r.from).filter((f) => f && f > g.from && f <= g.to)))].sort();
  if (changes.length) notes.push(`Rates changed on ${listOf(changes.map((d) => asDate(d, fmtFull)))} within these dates.`);
  el.textContent = notes.join(' ');
});

/* ---------- Your next bill ---------- */
const addDays = (iso, n) => {
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const addMonths = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
};
// The billing period: the one chosen, else two months (Synergy bills every two) from the first day not yet billed.
function billPeriod() {
  const p = dash.params() || {};
  if (p.billFrom && p.billTo && p.billFrom <= p.billTo) return {from: p.billFrom, to: p.billTo, chosen: true};
  const all = rowsOf('ranges').find((r) => r.range === 'all');
  if (!all) return null;
  const u = dash.data('usage', 'all');
  const first = (u.status === 'ok' && u.data[0] && u.data[0].unbilledFrom) || addDays(all.to, 1);
  return {from: first, to: addDays(addMonths(first, 2), -1), chosen: false};
}
function nextBill() {
  const p = selPlan(), b = billPeriod();
  if (!p || !b) return null;
  return memo(`bill|${p.tariff}|${b.from}|${b.to}`, () => {
    const r = projectBill(rowsOf('dayTotals').filter((d) => d.tariff === p.tariff), p, b.from, b.to);
    return r && Object.assign(r, {chosen: b.chosen, tariff: p.tariff});
  });
}
const span2 = (a, b) => `${asDate(a, fmtFull)} – ${asDate(b, fmtFull)}`;

dash.draw('nb-total', (el) => {
  settle(el, firstNotOk('dayTotals', 'plans'));
  const r = nextBill();
  el.textContent = r ? money(r.total) : '—';
});
dash.draw('nb-period', (el) => {
  const r = nextBill();
  if (!r) { el.textContent = '—'; return; }
  el.textContent = `${asDate(r.from)} – ${asDate(r.to)}${r.futureDays ? `, ${plural(r.futureDays, 'day')} to go.` : '.'}`;
});
dash.draw('nb-lede', (el) => {
  const r = nextBill();
  if (!r) { el.textContent = 'Open some readings to see this.'; return; }
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  const nodes = [];
  if (!r.estDays) {
    nodes.push('Every day from ', b(span2(r.from, r.to)), ' has readings: on ', b(r.tariff), ' that came to ', b(money(r.total)), ' with the supply charge.');
  } else {
    nodes.push('For ', b(span2(r.from, r.to)), ' on ', b(r.tariff), ': ');
    if (r.knownDays) nodes.push(b(money(r.sofar)), ` over the ${plural(r.knownDays, 'day')} with readings, and about `);
    else nodes.push('about ');
    nodes.push(b(money(r.estimate)), ` for the ${r.knownDays ? 'other ' : ''}${plural(r.estDays, 'day')}${r.missingDays ? ` (${f0(r.missingDays)} of them missing from the readings)` : ''}, going by the average day from ${span2(r.basisFrom, r.basisTo)}. That makes about `,
      b(money(r.total)), ', likely between ', b(money(r.low)), ' and ', b(money(r.high)), '.');
  }
  if (!r.chosen) nodes.push(' The period starts on the first day not yet billed and runs for two months, as Synergy bills; set the dates from your last bill to match it exactly.');
  el.replaceChildren(...nodes);
});
dash.draw('nb-facts', (dl) => {
  const r = nextBill();
  if (!r) { dl.replaceChildren(); return; }
  const fact = (label, value, sub) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.append(value);
    if (sub) dd.append(Object.assign(document.createElement('small'), {textContent: sub}));
    div.append(dt, dd);
    return div;
  };
  dl.replaceChildren(
    fact('Projected bill', money(r.total), `${plural(r.days, 'day')}`),
    fact('So far', money(r.sofar), `${plural(r.knownDays, 'day')} with readings`),
    fact('Still to come', money(r.estimate), `${plural(r.estDays, 'day')}, estimated`),
    fact('Likely range', `${money0(r.low)}–${money0(r.high)}`, ''),
  );
});
dash.draw('nb-chart', (el) => {
  if (placeholder(el, firstNotOk('dayTotals', 'plans'))) return;
  const r = nextBill();
  if (!r || !r.cumulative.length) { el.replaceChildren(); return; }
  const pts = r.cumulative;
  const H = 220, top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H, `Line chart of the running total of the bill from ${asDate(r.from, fmtFull)} to ${asDate(r.to, fmtFull)}: solid where there are readings, dashed where it is estimated, with the likely range shaded.`);
  const y = d3.scaleLinear().domain([0, d3.max(pts, (d) => d.high) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, true);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const x = d3.scaleBand(pts.map((d) => d.date), [ml, W - mr]);
  const cx = (d) => x(d) + x.bandwidth() / 2;
  yAxis(svg, y, yt, fmt, ml, W - mr, 'Bill so far');
  svg.append('path').datum(pts).attr('class', 'eu-band')
    .attr('d', d3.area().x((d) => cx(d.date)).y0((d) => y(d.low)).y1((d) => y(d.high)));
  svg.append('path').datum(pts).attr('class', 'eu-avgdash').attr('d', d3.line().x((d) => cx(d.date)).y((d) => y(d.total)));
  svg.append('path').datum(pts).attr('class', 'eu-avg').attr('d', d3.line().defined((d) => d.actual).x((d) => cx(d.date)).y((d) => y(d.total)));
  xLabels(svg, dateTicks(pts.map((d) => d.date), x.step()), cx, H - 6, W, (d) => asDate(d));
  const rule = svg.append('line').attr('class', 'eu-rule').attr('y1', top).attr('y2', bottom).attr('visibility', 'hidden');
  const tip = makeTip(el);
  svg.append('rect').attr('class', 'eu-hit').attr('fill', 'transparent')
    .attr('x', ml).attr('y', 0).attr('width', Math.max(0, W - mr - ml)).attr('height', bottom)
    .on('pointerenter pointermove', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const d = pts[Math.max(0, Math.min(pts.length - 1, Math.floor((px - ml) / x.step())))];
      rule.attr('x1', cx(d.date)).attr('x2', cx(d.date)).attr('visibility', 'visible');
      tip.show(event, asDate(d.date, fmtFull), [
        {label: 'Bill so far', value: money(d.total), strong: true, line: d.actual ? 'solid' : 'dash'},
        ...(d.actual ? [] : [{label: 'Likely range', value: `${money0(d.low)}–${money0(d.high)}`}]),
      ], d.actual ? 'From the readings' : 'Estimated');
    })
    .on('pointerleave', () => { rule.attr('visibility', 'hidden'); tip.hide(); });
}, {deps: ['tariff', 'billFrom', 'billTo']});

/* ---------- Break-even ---------- */
// The break-even rows for each other tariff against the chosen one.
const breakEvens = () => {
  const t = selTariff();
  return rowsOf('breakEven').filter((r) => r.range === selRange() && r.other === t);
};
const beWhen = (r, field, side, fmt) => {
  if (r[field] == null) return r.diffPerDay > 0 ? 'Always dearer' : 'Always cheaper';
  return `Cheaper ${r[side]} ${fmt(r[field])}`;
};
dash.draw('be-lede', (el) => {
  const rows = breakEvens();
  if (!rows.length) { el.textContent = ''; return; }
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  const r0 = rows[0];
  const nodes = [`At the rates in force on ${asDate(r0.ratesOn, fmtFull)}, with ${f1(r0.peakShareNow)}% of your use at peak and ${f1(r0.kWhPerDayNow)} kWh a day: `];
  rows.slice(0, 3).forEach((r, i) => {
    if (i) nodes.push(' ');
    const dearer = r.diffPerDay > 0;
    nodes.push(b(r.tariff), ` costs ${money(Math.abs(r.diffPerDay))} a day ${dearer ? 'more' : 'less'}`);
    const turns = [];
    if (r.breakEvenPeakShare != null) turns.push(`if ${r.cheaperWhenPeak === 'above' ? 'more than' : 'less than'} ${f1(r.breakEvenPeakShare)}% of your use were at peak`);
    if (r.breakEvenKWh != null) turns.push(`if you used ${r.cheaperWhenUse === 'above' ? 'more than' : 'less than'} ${f1(r.breakEvenKWh)} kWh a day`);
    nodes.push(turns.length ? `, and would be ${dearer ? 'cheaper' : 'dearer'} ${turns.join(', or ')}.` : ` however your use is split.`);
  });
  el.replaceChildren(...nodes);
});
dash.draw('be-rows', (tbody) => {
  const rows = breakEvens();
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    const diff = cell(`${moneySigned(r.diffPerDay)} a day`, 'eu-num');
    diff.classList.add(r.diffPerDay > 0 ? 'eu-bad' : 'eu-good');
    tr.append(
      nameCell(r.tariff, null, tariffColor(r.tariff)),
      diff,
      cell(beWhen(r, 'breakEvenPeakShare', 'cheaperWhenPeak', (v) => `${f1(v)}% at peak`), 'eu-num'),
      cell(beWhen(r, 'breakEvenKWh', 'cheaperWhenUse', (v) => `${f1(v)} kWh a day`), 'eu-num'),
    );
    return tr;
  }));
});

/* ---------- Battery ---------- */
function batteryChoice() {
  const p = dash.params() || {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return v === '' || v == null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n));
  };
  const price = Number(p.batPrice);
  return {
    size: num(p.batSize, 10, 1, 30), power: num(p.batPower, 5, 0.5, 30), efficiency: num(p.batEff, 90, 50, 100),
    price: p.batPrice === '' || p.batPrice == null || !Number.isFinite(price) || price <= 0 ? null : price,
  };
}
function battery(p) {
  const g = selRangeRow(), c = batteryChoice();
  if (!p || !g) return null;
  return memo(`bat|${p.tariff}|${g.from}|${g.to}|${c.size}|${c.power}|${c.efficiency}`, () => {
    const rows = rowsOf('halfHours').filter((r) => r.tariff === p.tariff && r.date >= g.from && r.date <= g.to)
      .sort((a, b) => (a.date === b.date ? (a.time < b.time ? -1 : 1) : a.date < b.date ? -1 : 1));
    return rows.length ? simulateBattery(rows, p, c) : null;
  });
}
const payback = (perYear, price) => (price == null ? '—' : perYear > 0 ? `${f1(price / perYear)} years` : 'Never');
dash.draw('bat-size-label', (el) => { el.textContent = `${f0(batteryChoice().size)} kWh`; });
dash.draw('bat-year', (el) => {
  const r = battery(selPlan());
  el.textContent = r ? money0(r.savingPerYear) : '—';
});
dash.draw('bat-sub', (el) => {
  const r = battery(selPlan()), c = batteryChoice();
  if (!r) { el.textContent = '—'; return; }
  el.textContent = `${money(r.savingPerDay)} a day, using ${f1(r.usedPerDay)} kWh a day from the battery. `
    + (c.price == null ? 'Enter its price to see the payback.' : `Pays back ${money0(c.price)} in ${payback(r.savingPerYear, c.price)}, before any rebate or battery wear.`);
});
dash.draw('bat-lede', (el) => {
  const p = selPlan(), r = battery(p), c = batteryChoice(), g = selRangeRow();
  if (!p || !r || !g) { el.textContent = '—'; return; }
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  if (isFlat(selRates())) {
    el.replaceChildren(b(p.tariff), ' charges the same at every hour, so a battery charged from the grid saves nothing on it. Pick a time-of-use tariff at the top to see what one would save there.');
    return;
  }
  el.replaceChildren(`On `, b(p.tariff), `, a `, b(`${f0(c.size)} kWh`), ` battery charged from the grid in the cheapest hours and used from 3 pm until it runs out would have cut the energy cost over these ${plural(r.days, 'day')} from ${money(r.costBefore)} to ${money(r.costAfter)}, saving `,
    b(money(r.saving)), ', or about ', b(`${money0(r.savingPerYear)} a year`), '. Charging from solar panels instead would save more.');
});
dash.draw('bat-chart', (el) => {
  const p = selPlan(), r = battery(p);
  if (!r) { el.replaceChildren(); return; }
  const rows = r.profile;
  const H = 220, top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H, 'Line chart of the average kWh drawn from the grid in each half-hour of the day, without a battery and with one, charging included.');
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => Math.max(d.before, d.after)) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, false);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 8;
  const x = d3.scaleLinear([0, rows.length], [ml, W - mr]);
  const cx = (i) => x(i + 0.5);
  yAxis(svg, y, yt, fmt, ml, W - mr, 'kWh per half-hour');
  svg.append('path').datum(rows).attr('class', 'eu-halo').attr('d', d3.line().x((d, i) => cx(i)).y((d) => y(d.before)));
  svg.append('path').datum(rows).attr('class', 'eu-wd').attr('d', d3.line().x((d, i) => cx(i)).y((d) => y(d.before)));
  svg.append('path').datum(rows).attr('class', 'eu-avgdash').attr('d', d3.line().x((d, i) => cx(i)).y((d) => y(d.after)));
  xLabels(svg, d3.range(0, rows.length + 1, W < 560 ? 12 : 6), (i) => x(i), H - 6, W, (i) => (i >= rows.length ? '24:00' : rows[i].time));
  const tip = makeTip(el);
  const rule = svg.append('line').attr('class', 'eu-rule').attr('y1', top).attr('y2', bottom).attr('visibility', 'hidden');
  svg.append('rect').attr('class', 'eu-hit').attr('fill', 'transparent')
    .attr('x', ml).attr('y', 0).attr('width', Math.max(0, W - mr - ml)).attr('height', bottom)
    .on('pointerenter pointermove', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const i = Math.max(0, Math.min(rows.length - 1, Math.floor(x.invert(px))));
      rule.attr('x1', cx(i)).attr('x2', cx(i)).attr('visibility', 'visible');
      tip.show(event, `${rows[i].time}–${endOf(rows[i].time)}`, [
        {label: 'Without a battery', value: kwh(rows[i].before, f2), line: 'solid'},
        {label: 'With the battery', value: kwh(rows[i].after, f2), line: 'dash'},
      ], ratePeriod(rows[i].time));
    })
    .on('pointerleave', () => { rule.attr('visibility', 'hidden'); tip.hide(); });
}, {deps: ['range', 'tariff', 'batSize', 'batPower', 'batEff']});
dash.draw('bat-rows', (tbody) => {
  const c = batteryChoice(), chosen = selTariff();
  tbody.replaceChildren(...rowsOf('plans').map((p) => {
    const r = battery(p);
    const tr = document.createElement('tr');
    tr.append(
      nameCell(p.tariff, p.tariff === chosen ? 'Chosen' : null, tariffColor(p.tariff)),
      cell(r ? money(r.costBefore) : '—', 'eu-num'),
      cell(r ? money(r.costAfter) : '—', 'eu-num'),
      cell(r ? money0(r.savingPerYear) : '—', 'eu-num eu-strong'),
      cell(r ? payback(r.savingPerYear, c.price) : '—', 'eu-num'),
    );
    return tr;
  }));
});

/* ---------- Time of day ---------- */
dash.draw('tod-lede', (el) => {
  const rows = forView('blocks');
  if (!rows.length) { el.textContent = '—'; return; }
  const by = new Map(rows.map((r) => [r.block, r]));
  const ev = by.get('Early evening'), on = by.get('Overnight'), late = by.get('Late evening'), am = by.get('Morning');
  const most = rows.reduce((m, r) => (r.avgKW > m.avgKW ? r : m));
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  el.replaceChildren(
    'The early evening, 3–9 pm, used ', b(`${f1(ev.kWhPerDay)} kWh a day`), ` (${f0(ev.kWhShare)}% of the total) and made up `, b(`${f0(ev.costShare)}%`), ' of the energy cost. ',
    'Overnight, 12–6 am, used ', b(`${f1(on.kWhPerDay)} kWh`), ', the late evening, 9 pm–midnight, ', b(`${f1(late.kWhPerDay)} kWh`), ', and the morning, 6–9 am, ', b(`${f1(am.kWhPerDay)} kWh`), ' a day. ',
    `The home drew the most in the ${most.block.toLowerCase()}, `, b(`${f2(most.avgKW)} kW`), ' on average.');
});
dash.draw('tod-chart', (el) => {
  if (placeholder(el, firstNotOk('blocks', 'plans'))) return;
  const rows = forView('blocks');
  if (!rows.length) { el.replaceChildren(); return; }
  const cost = isCost();
  const key = cost ? 'costPerDay' : 'kWhPerDay';
  const rowH = 34, H = rows.length * rowH + 4;
  const {svg, W} = chartBox(el, H, `Bar chart of the ${cost ? 'energy cost' : 'kWh'} a day in each part of the day, coloured by rate period.`);
  const labels = rows.map((r) => `${r.block}, ${r.hours}`);
  const ml = Math.ceil(textWidth(svg, labels)) + 12;
  const fmtV = cost ? money : (v) => `${f1(v)} kWh`;
  const mr = Math.ceil(textWidth(svg, rows.map((r) => fmtV(r[key])), 'eu-vlab')) + 10;
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r[key]) || 1], [ml, W - mr]);
  const tip = makeTip(el);
  rows.forEach((r, i) => {
    const y0 = 2 + i * rowH;
    svg.append('g').attr('class', 'eu-axis').append('text').attr('x', 0).attr('y', y0 + 12).attr('dy', '0.32em').text(labels[i]);
    svg.append('rect').attr('x', ml).attr('y', y0 + 2).attr('height', 20).attr('width', Math.max(0, x(r[key]) - ml))
      .style('fill', COLOR[r.period])
      .on('pointerenter pointermove', (event) => tip.show(event, `${r.block}, ${r.hours}`, [
        {label: 'kWh a day', value: f2(r.kWhPerDay)},
        {label: 'Share of kWh', value: pct(r.kWhShare)},
        {label: 'Energy cost a day', value: money(r.costPerDay)},
        {label: 'Share of cost', value: pct(r.costShare)},
        {label: 'Average power', value: `${f2(r.avgKW)} kW`},
      ], r.period))
      .on('pointerleave', () => tip.hide());
    svg.append('text').attr('class', 'eu-vlab').attr('x', x(r[key]) + 6).attr('y', y0 + 12).attr('dy', '0.32em').text(fmtV(r[key]));
  });
}, {deps: ['range', 'tariff', 'measure']});
dash.draw('tod-rows', (tbody) => {
  tbody.replaceChildren(...forView('blocks').map((r) => {
    const tr = document.createElement('tr');
    tr.append(
      nameCell(r.block, null, COLOR[r.period]),
      cell(r.hours),
      cell(f2(r.kWhPerDay), 'eu-num'),
      cell(pct(r.kWhShare), 'eu-num'),
      cell(money(r.costPerDay), 'eu-num'),
      cell(pct(r.costShare), 'eu-num'),
      cell(f2(r.avgKW), 'eu-num'),
    );
    return tr;
  }));
});

/* ---------- Where the cost concentrates ---------- */
const hourName = (h) => {
  const x = ((h % 24) + 24) % 24;
  return x === 0 ? 'midnight' : x === 12 ? 'noon' : x < 12 ? `${x} am` : `${x - 12} pm`;
};
dash.draw('conc-lede', (el) => {
  const r = forView('concentration')[0];
  if (!r) { el.textContent = '—'; return; }
  const t10 = r.tops.find((x) => x.pct === 10), t25 = r.tops.find((x) => x.pct === 25);
  const lead = Object.entries(r.periodShare).sort((a, b) => b[1] - a[1])[0];
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  const nodes = ['The dearest 10% of half-hours, ', b(`${f0(t10.halfHours / 2)} hours`), ', made up ', b(`${f0(t10.costShare)}%`), ` of the energy cost while using ${f0(t10.kWhShare)}% of the kWh, and the dearest quarter made up ${f0(t25.costShare)}%. `];
  nodes.push(`${f0(lead[1])}% of that dearest 10% was in the ${lead[0].toLowerCase()} period`);
  if (r.topHours.length) nodes.push(`, most often from ${hourName(r.topHours[0].hour)} to ${hourName(r.topHours[0].hour + 1)}`);
  nodes.push('. Cutting back in those half-hours does the most for the bill.');
  el.replaceChildren(...nodes);
});
dash.draw('conc-chart', (el) => {
  if (placeholder(el, firstNotOk('concentration', 'plans'))) return;
  const r = forView('concentration')[0];
  if (!r) { el.replaceChildren(); return; }
  const H = 250, top = 28, bottom = H - 24;
  const {svg, W} = chartBox(el, H, 'Curve of the share of the energy cost against the share of half-hours, adding them up from the dearest, with a dashed diagonal for if every half-hour cost the same.');
  const y = d3.scaleLinear([0, 100], [bottom, top]);
  const yt = [0, 25, 50, 75, 100];
  const fmt = (v) => `${v}%`;
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 10;
  const x = d3.scaleLinear([0, 100], [ml, W - mr]);
  yAxis(svg, y, yt, fmt, ml, W - mr, 'Share of energy cost');
  svg.append('line').attr('class', 'eu-usual').attr('x1', x(0)).attr('y1', y(0)).attr('x2', x(100)).attr('y2', y(100));
  const pts = r.curve.map((v, i) => [i, v]);
  svg.append('path').datum(pts).attr('class', 'eu-halo').attr('d', d3.line().x((d) => x(d[0])).y((d) => y(d[1])));
  svg.append('path').datum(pts).attr('class', 'eu-wd').attr('d', d3.line().x((d) => x(d[0])).y((d) => y(d[1])));
  const t10 = r.curve[10];
  svg.append('line').attr('class', 'eu-ref').attr('x1', x(10)).attr('x2', x(10)).attr('y1', y(0)).attr('y2', y(t10));
  svg.append('circle').attr('class', 'eu-dot').attr('cx', x(10)).attr('cy', y(t10)).attr('r', 4);
  svg.append('text').attr('class', 'eu-vlab').attr('x', x(10) + 8).attr('y', y(t10) + 4).text(`dearest 10%: ${f0(t10)}% of the cost`);
  xLabels(svg, [0, 25, 50, 75, 100], (v) => x(v), H - 6, W, (v) => (v ? `${v}% of half-hours` : 'Dearest first'));
  const dot = svg.append('circle').attr('class', 'eu-dot').attr('r', 3.5).attr('visibility', 'hidden');
  const tip = makeTip(el);
  svg.append('rect').attr('class', 'eu-hit').attr('fill', 'transparent')
    .attr('x', ml).attr('y', 0).attr('width', Math.max(0, W - mr - ml)).attr('height', bottom)
    .on('pointerenter pointermove', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const i = Math.max(0, Math.min(100, Math.round(x.invert(px))));
      dot.attr('cx', x(i)).attr('cy', y(r.curve[i])).attr('visibility', 'visible');
      tip.show(event, `The dearest ${i}% of half-hours`, [
        {label: 'Hours', value: f0((r.halfHours * i) / 100 / 2)},
        {label: 'Share of energy cost', value: `${f1(r.curve[i])}%`, strong: true},
      ], '');
    })
    .on('pointerleave', () => { dot.attr('visibility', 'hidden'); tip.hide(); });
}, {deps: ['range', 'tariff']});
dash.draw('conc-rows', (tbody) => {
  const r = forView('concentration')[0];
  tbody.replaceChildren(...(r ? r.tops : []).map((x) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(`Dearest ${x.pct}%`),
      cell(f0(x.halfHours / 2), 'eu-num'),
      cell(pct(x.costShare), 'eu-num eu-strong'),
      cell(pct(x.kWhShare), 'eu-num'),
      cell(money(x.cost), 'eu-num'),
    );
    return tr;
  }));
});

/* ---------- Peak demand ---------- */
dash.draw('dem-lede', (el) => {
  const days = inChosen(rowsOf('demand')).filter((d) => d.halfHours >= 40);
  if (!days.length) { el.textContent = '—'; return; }
  const top = days.reduce((m, d) => (d.peakKW > m.peakKW ? d : m));
  const typical = d3.median(days, (d) => d.peakKW), avg = d3.mean(days, (d) => d.avgKW);
  const atPeak = days.filter((d) => d.period === 'Peak').length / days.length;
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  el.replaceChildren('The busiest half-hour in these dates was ', b(`${top.time}–${endOf(top.time)} on ${asDate(top.date, fmtDay)}`), ', averaging ', b(`${f1(top.peakKW)} kW`),
    '. On a typical day the busiest half-hour averages ', b(`${f1(typical)} kW`), `, while across the whole day the home draws ${f2(avg)} kW, about ${f0((avg / typical) * 100)}% of that peak. `,
    `On ${f0(atPeak * 100)}% of days the busiest half-hour was at peak, 3–9 pm. This is what sizes a battery’s power, or shows when big loads overlap.`);
});
dash.draw('dem-chart', (el) => {
  if (placeholder(el, firstNotOk('demand', 'ranges'))) return;
  const days = inChosen(rowsOf('demand'));
  if (!days.length) { el.replaceChildren(); return; }
  const H = el.clientWidth < 560 ? 220 : 250, top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H, `Bar chart of the average power in each day’s busiest half-hour from ${asDate(days[0].date)} to ${asDate(days[days.length - 1].date)}, coloured by the rate period it fell in, with a dashed line for the typical day.`);
  const y = d3.scaleLinear().domain([0, d3.max(days, (d) => d.peakKW) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = d3.format(',.1f');
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const {x, cx} = anomAxisX(svg, days, W, ml, mr);
  yAxis(svg, y, yt, fmt, ml, W - mr, 'kW');
  svg.append('g').selectAll('rect').data(days).join('rect')
    .attr('x', (d) => x(d.date)).attr('width', x.bandwidth()).attr('y', (d) => y(d.peakKW)).attr('height', (d) => Math.max(0, y(0) - y(d.peakKW)))
    .style('fill', (d) => COLOR[d.period] || 'var(--color-fg-muted)');
  const med = d3.median(days, (d) => d.peakKW);
  svg.append('line').attr('class', 'eu-usual').attr('x1', ml).attr('x2', W - mr).attr('y1', y(med)).attr('y2', y(med));
  xLabels(svg, dateTicks(days.map((d) => d.date), x.step()), cx, H - 6, W, (d) => asDate(d));
  anomHits(svg, el, days, x, top, bottom, (d) => [[
    {label: 'Busiest half-hour', value: `${f2(d.peakKW)} kW`, strong: true, swatch: COLOR[d.period]},
    {label: 'Starting', value: d.time},
    {label: 'Average over the day', value: `${f2(d.avgKW)} kW`},
  ], d.halfHours < 48 ? 'Some half-hours missing' : d.period]);
}, {deps: ['range', 'day']});
dash.draw('dem-hours', (el) => {
  if (placeholder(el, firstNotOk('demand', 'ranges'))) return;
  const days = inChosen(rowsOf('demand'));
  if (!days.length) { el.replaceChildren(); return; }
  const counts = d3.range(24).map((h) => ({h, n: days.filter((d) => Number(d.time.slice(0, 2)) === h).length, period: ratePeriod(`${String(h).padStart(2, '0')}:00`)}));
  const H = el.clientWidth < 560 ? 220 : 250, top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H, 'Bar chart of how many days had their busiest half-hour starting in each hour of the day, coloured by rate period.');
  const y = d3.scaleLinear().domain([0, d3.max(counts, (c) => c.n) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4).filter(Number.isInteger);
  const fmt = d3.format(',.0f');
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const x = d3.scaleBand(counts.map((c) => c.h), [ml, W - mr]).paddingInner(0.2);
  yAxis(svg, y, yt, fmt, ml, W - mr, 'Days');
  const tip = makeTip(el);
  svg.append('g').selectAll('rect').data(counts).join('rect')
    .attr('x', (c) => x(c.h)).attr('width', x.bandwidth()).attr('y', (c) => y(c.n)).attr('height', (c) => Math.max(0, y(0) - y(c.n)))
    .style('fill', (c) => COLOR[c.period])
    .on('pointerenter pointermove', (event, c) => tip.show(event, `${hourName(c.h)} to ${hourName(c.h + 1)}`, [{label: 'Days peaking then', value: f0(c.n), swatch: COLOR[c.period]}], c.period))
    .on('pointerleave', () => tip.hide());
  xLabels(svg, counts.filter((c) => c.h % (W < 560 ? 6 : 3) === 0).map((c) => c.h), (h) => x(h), H - 6, W, (h) => `${String(h).padStart(2, '0')}:00`);
}, {deps: ['range']});

/* ---------- Longer-term trend ---------- */
// Each day's kWh or cost for the chosen tariff over the whole file, its 30-day
// average (given when at least 20 of the 30 days have readings), and the same
// average a year earlier.
function trendSeries(cost) {
  const t = selTariff();
  return memo(`trend|${t}|${cost}`, () => {
    const days = rowsOf('daily').filter((d) => d.tariff === t);
    const value = new Map(days.map((d) => [d.date, cost ? d.cost : d.total]));
    const out = days.map((d) => {
      let sum = 0, n = 0;
      for (let k = 0; k < 30; k += 1) {
        const v = value.get(addDays(d.date, -k));
        if (v != null) { sum += v; n += 1; }
      }
      return {date: d.date, avg: n >= 20 ? sum / n : null};
    });
    const avgOn = new Map(out.map((d) => [d.date, d.avg]));
    for (const d of out) d.lastYear = avgOn.get(yearBefore(d.date)) ?? null;
    return out;
  });
}
dash.draw('trend-lede', (el) => {
  const all = rowsOf('ranges').find((r) => r.range === 'all');
  if (!all) { el.textContent = '—'; return; }
  const b = (t) => Object.assign(document.createElement('b'), {textContent: t});
  const nodes = [];
  if (all.days < 60) {
    el.replaceChildren('A trend needs at least 60 days of readings. Synergy exports 90 days at a time, so add older exports with ', b('Add CSV files…'), ' to build up a longer history; where they overlap, each half-hour is only counted once.');
    return;
  }
  const cost = isCost();
  const v = (n) => (cost ? `${money(n)} a day` : `${f1(n)} kWh a day`);
  const s = trendSeries(cost).filter((d) => d.avg != null);
  if (s.length > 1) nodes.push(`The 30-day average went from ${v(s[0].avg)} (to ${asDate(s[0].date, fmtFull)}) to `, b(v(s[s.length - 1].avg)), ` (to ${asDate(s[s.length - 1].date, fmtFull)}). `);
  const ly = forView('lastYear')[0];
  const say = (r, what) => {
    nodes.push(`${what} used `, b(`${f1(r.kWhPerDay)} kWh a day`), `, ${r.kWhChange === 0 ? 'the same as' : `${f0(Math.abs(r.kWhChange))}% ${r.kWhChange > 0 ? 'more than' : 'less than'}`} the same dates a year earlier (${f1(r.prevKWhPerDay)}), and cost ${money(r.costPerDay)} a day against ${money(r.prevCostPerDay)} then, each at the rates of the time. `);
  };
  if (ly) say(ly, 'These dates');
  else nodes.push('There aren’t enough readings for the same dates a year earlier to compare these dates with. ');
  if (selRange() !== 'last365') {
    const y = dash.data('lastYear', 'last365');
    const r = y.status === 'ok' ? y.data.find((x) => x.tariff === selTariff()) : null;
    if (r) say(r, 'The last 12 months');
  }
  el.replaceChildren(...nodes);
});
dash.draw('trend-chart', (el) => {
  if (placeholder(el, firstNotOk('daily', 'plans'))) return;
  const cost = isCost();
  const s = trendSeries(cost);
  if (!s.some((d) => d.avg != null)) { el.replaceChildren(); return; }
  const g = selRangeRow();
  const H = el.clientWidth < 560 ? 230 : 270, top = 20, bottom = H - 24;
  const {svg, W} = chartBox(el, H, `Line chart of the 30-day average ${cost ? 'cost' : 'kWh'} a day across the whole file, with the same average a year earlier dashed and the chosen dates shaded.`);
  const y = d3.scaleLinear().domain([0, d3.max(s, (d) => Math.max(d.avg || 0, d.lastYear || 0)) || 1]).nice().range([bottom, top]);
  const yt = y.ticks(4);
  const fmt = axisFmt(yt, cost);
  const ml = Math.ceil(textWidth(svg, yt.map(fmt))) + 10, mr = 6;
  const x = d3.scaleUtc([parseDay(s[0].date), parseDay(s[s.length - 1].date)], [ml, W - mr]);
  const xd = (d) => x(parseDay(d));
  if (g && (g.from > s[0].date || g.to < s[s.length - 1].date)) {
    svg.append('rect').attr('class', 'eu-band').attr('x', xd(g.from)).attr('width', Math.max(2, xd(g.to) - xd(g.from))).attr('y', top).attr('height', bottom - top);
  }
  yAxis(svg, y, yt, fmt, ml, W - mr, cost ? 'Cost a day, 30-day average' : 'kWh a day, 30-day average');
  svg.append('path').datum(s).attr('class', 'eu-avgdash').attr('d', d3.line().defined((d) => d.lastYear != null).x((d) => xd(d.date)).y((d) => y(d.lastYear)));
  svg.append('path').datum(s).attr('class', 'eu-halo').attr('d', d3.line().defined((d) => d.avg != null).x((d) => xd(d.date)).y((d) => y(d.avg)));
  svg.append('path').datum(s).attr('class', 'eu-avg').attr('d', d3.line().defined((d) => d.avg != null).x((d) => xd(d.date)).y((d) => y(d.avg)));
  const ticks = x.ticks(W < 560 ? 4 : 8);
  xLabels(svg, ticks, (d) => x(d), H - 6, W, (d) => (s.length > 400 ? fmtMonth(d) : fmtShort(d)));
  const rule = svg.append('line').attr('class', 'eu-rule').attr('y1', top).attr('y2', bottom).attr('visibility', 'hidden');
  const tip = makeTip(el);
  const bis = d3.bisector((d) => d.date).center;
  svg.append('rect').attr('class', 'eu-hit').attr('fill', 'transparent')
    .attr('x', ml).attr('y', 0).attr('width', Math.max(0, W - mr - ml)).attr('height', bottom)
    .on('pointerenter pointermove', (event) => {
      const [px] = d3.pointer(event, svg.node());
      const d = s[bis(s, x.invert(px).toISOString().slice(0, 10))];
      rule.attr('x1', xd(d.date)).attr('x2', xd(d.date)).attr('visibility', 'visible');
      const v = (n) => (n == null ? '—' : cost ? money(n) : `${f1(n)} kWh`);
      tip.show(event, `30 days to ${asDate(d.date, fmtFull)}`, [
        {label: 'Average a day', value: v(d.avg), line: 'solid', strong: true},
        {label: 'A year earlier', value: v(d.lastYear), line: 'dash'},
      ], '');
    })
    .on('pointerleave', () => { rule.attr('visibility', 'hidden'); tip.hide(); })
    .on('click', (event) => {
      const [px] = d3.pointer(event, svg.node());
      dash.setParams({day: s[bis(s, x.invert(px).toISOString().slice(0, 10))].date});
    });
}, {deps: ['range', 'tariff', 'measure']});

/* ---------- Inputs for the bill and battery ---------- */
const BAT_INPUTS = {'bat-size': 'batSize', 'bat-power': 'batPower', 'bat-eff': 'batEff', 'bat-price': 'batPrice'};
for (const [id, key] of Object.entries(BAT_INPUTS)) {
  document.querySelectorAll(`#${id}`).forEach((el) => el.addEventListener('input', () => dash.setParams({[key]: el.value})));
}
function applyBillDates() {
  const f = document.getElementById('nb-from'), t = document.getElementById('nb-to');
  if (!f || !t || !f.value || !t.value || !f.validity.valid || !t.validity.valid) return;
  const [a, b] = f.value <= t.value ? [f.value, t.value] : [t.value, f.value];
  dash.setParams({billFrom: a, billTo: b});
}
document.querySelectorAll('#nb-from, #nb-to').forEach((el) => el.addEventListener('change', applyBillDates));
document.querySelectorAll('#nb-reset').forEach((b) => b.addEventListener('click', () => dash.setParams({billFrom: '', billTo: ''})));
// Shows the current choices in the inputs, except one being typed in.
function syncInputs() {
  const put = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v == null ? '' : String(v);
  };
  const c = batteryChoice();
  put('bat-size', c.size);
  put('bat-power', c.power);
  put('bat-eff', c.efficiency);
  put('bat-price', c.price);
  const b = billPeriod();
  if (b) { put('nb-from', b.from); put('nb-to', b.to); }
  const reset = document.getElementById('nb-reset');
  if (reset) reset.hidden = !(b && b.chosen);
}

/* ---------- Sortable tables ---------- */
// Select a column heading to sort by it (numbers biggest first, words A to Z),
// again to reverse, and a third time to go back to the table's own order.
const sortSpec = (id) => ((dash.params() || {}).sorts || {})[id] || null;
function withSort(td, value) {
  td.dataset.sort = value == null ? '' : String(value);
  return td;
}
// A cell's value to sort by: its data-sort, else the number its text starts with, else its text.
function sortValueOf(td) {
  const given = td.dataset.sort !== undefined;
  const raw = given ? td.dataset.sort : td.textContent.trim();
  if (raw === '' || raw === '—') return null;
  const t = raw.replace(/[−–]/g, '-').replace(/[$,%¢]/g, '');
  const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(t);
  if (m && (!given || m[0].length === t.length)) return Number(m[0]);
  return raw.toLowerCase();
}
const compareValues = (a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1);
// Sorted copy of list by key(item); blanks always last, ties keep their order.
function sortBy(list, key, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return list.map((item, i) => ({item, i, v: key(item)}))
    .sort((x, y) => {
      const xn = x.v == null || Number.isNaN(x.v), yn = y.v == null || Number.isNaN(y.v);
      if (xn || yn) return xn - yn || x.i - y.i;
      return sign * compareValues(x.v, y.v) || x.i - y.i;
    })
    .map((x) => x.item);
}
document.querySelectorAll('.eu-table').forEach((table) => {
  table.querySelectorAll('thead th').forEach((th, col) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eu-sortbtn';
    const label = document.createElement('span');
    label.append(...th.childNodes);
    const arrow = document.createElement('span');
    arrow.className = 'eu-sortarrow';
    arrow.setAttribute('aria-hidden', 'true');
    btn.append(label, arrow);
    th.append(btn);
    btn.addEventListener('click', () => {
      const first = th.classList.contains('eu-num') ? 'desc' : 'asc';
      const cur = sortSpec(table.id);
      const next = !cur || cur.col !== col ? {col, dir: first} : cur.dir === first ? {col, dir: first === 'asc' ? 'desc' : 'asc'} : null;
      const sorts = Object.assign({}, (dash.params() || {}).sorts);
      if (next) sorts[table.id] = next;
      else delete sorts[table.id];
      dash.setParams({sorts});
    });
  });
});
dash.afterDraw(() => {
  document.querySelectorAll('.eu-table').forEach((table) => {
    const spec = sortSpec(table.id);
    table.querySelectorAll('thead th').forEach((th, col) => {
      const on = !!spec && spec.col === col;
      if (on) th.setAttribute('aria-sort', spec.dir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
      th.classList.toggle('eu-sorted', on);
      const arrow = th.querySelector('.eu-sortarrow');
      if (arrow) arrow.textContent = on ? (spec.dir === 'asc' ? '▲' : '▼') : '↕';
    });
    // "What stood out" sorts its whole list itself, before trimming it.
    const body = table.tBodies[0];
    if (!spec || !body || table.hasAttribute('data-sort-self')) return;
    const rows = [...body.rows];
    if (rows.length < 2 || rows.some((r) => r.cells.length <= spec.col)) return;
    body.append(...sortBy(rows, (tr) => sortValueOf(tr.cells[spec.col]), spec.dir));
  });
});
