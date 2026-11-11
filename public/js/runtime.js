/*
 * runtime.js - the small engine behind the dashboard.
 *
 * dashboard.js registers its data steps with dash.loader / dash.calc and its
 * drawings with dash.draw. This file runs those steps on the CSV text that
 * app.js hands over (dash.setSources), caches the results, and redraws when a
 * choice changes (dash.setParams). Choices are remembered in localStorage.
 * It also adds the from/to date fields, which make a "Custom" date range.
 *
 * Two things keep long files (years of readings) quick:
 * - A step that depends on the date ranges ('ranges', directly or through
 *   another step) is only worked out for the chosen range, when it's first
 *   asked for, and cached per range. Its rows still carry `range`.
 * - A drawing registered with {deps: [...]} is only redrawn when one of those
 *   choices, the data or the page width has changed, so dragging a slider
 *   doesn't rebuild every chart. dash.redraw() redraws everything.
 */
(function () {
  'use strict';
  const STORE = 'synergy-tool-choices';
  const DEFAULTS = {day: '', measure: 'cost', tariff: '', range: 'all', shiftTo: 'Super off-peak', shiftPct: 30, from: '', to: ''};
  const reg = {loaders: new Map(), calcs: new Map(), draws: new Map(), ons: [], afters: []};
  let sources = {};
  let cache = new Map();
  let gen = 0;   // goes up whenever cached results are thrown away
  let params = Object.assign({}, DEFAULTS);
  try { Object.assign(params, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { /* storage blocked */ }

  function saveParams() {
    try { localStorage.setItem(STORE, JSON.stringify(params)); } catch { /* storage blocked */ }
  }
  function dropCache() {
    cache = new Map();
    gen += 1;
  }

  // RFC 4180 CSV -> array of objects keyed by the (trimmed) header; blank cells become null.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (quoted) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i += 1;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const kept = rows.filter((r) => r.some((x) => x.trim() !== ''));
    if (!kept.length) return [];
    const head = kept[0].map((h) => h.trim());
    return kept.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined || r[i].trim() === '' ? null : r[i].trim()])));
  }

  const fmtDay = (iso) => d3.utcFormat('%-d %b %Y')(d3.utcParse('%Y-%m-%d')(iso));
  function withCustomRange(ranges) {
    const all = ranges.find((r) => r.range === 'all');
    if (!all || !params.from || !params.to) return ranges;
    let [a, b] = params.from <= params.to ? [params.from, params.to] : [params.to, params.from];
    if (a < all.from) a = all.from;
    if (b > all.to) b = all.to;
    if (a > b) return ranges;
    const days = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
    return ranges.concat({range: 'custom', group: 'Custom', label: `Custom, ${fmtDay(a)} – ${fmtDay(b)}`, from: a, to: b, days});
  }

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const perRangeMemo = new Map();
  function isPerRange(id) {
    if (id === 'ranges') return false;
    if (!perRangeMemo.has(id)) {
      const c = reg.calcs.get(id);
      perRangeMemo.set(id, !!c && c.inputs.some((i) => i === 'ranges' || isPerRange(i)));
    }
    return perRangeMemo.get(id);
  }
  const chosenRange = (ranges) => ranges.find((r) => r.range === params.range) || ranges.find((r) => r.range === 'all') || ranges[0] || null;

  // dash.data(id) for the chosen dates, or dash.data(id, rangeId) for another range.
  function compute(id, rangeId) {
    if (!isPerRange(id)) return computeOnce(id, id, null);
    const rs = computeOnce('ranges', 'ranges', null);
    if (rs.status !== 'ok') return {status: rs.status, data: [], message: rs.message};
    const g = rangeId ? rs.data.find((r) => r.range === rangeId) : chosenRange(rs.data);
    if (!g) return {status: 'ok', data: [], columns: []};
    return computeOnce(`${id}@${g.range}|${g.from}|${g.to}`, id, g);
  }

  function computeOnce(key, id, range) {
    if (cache.has(key)) return cache.get(key);
    let out;
    try {
      let data;
      if (reg.loaders.has(id)) {
        if (sources[id] == null) { out = {status: 'missing', data: []}; cache.set(key, out); return out; }
        const res = reg.loaders.get(id).fn({answer: sources[id], args: {}, call: null, read: null});
        data = Array.isArray(res) ? res : res.rows || res.data || [];
      } else if (has(sources, id)) {
        data = parseCsv(sources[id]);
      } else if (reg.calcs.has(id)) {
        const c = reg.calcs.get(id);
        const inputs = c.inputs.map((i) => (range && i === 'ranges' ? {status: 'ok', data: [range]} : compute(i, range && range.range)));
        const bad = inputs.find((s) => s.status !== 'ok');
        if (bad) {
          out = {status: bad.status, data: [], message: bad.message};
          cache.set(key, out);
          return out;
        }
        data = c.fn(...inputs.map((s) => s.data));
        if (id === 'ranges') data = withCustomRange(data);
      } else {
        out = {status: 'missing', data: []};
        cache.set(key, out);
        return out;
      }
      out = {status: 'ok', data, columns: Array.isArray(data) && data.length ? Object.keys(data[0]) : []};
    } catch (e) {
      console.error(`"${id}" failed:`, e);
      out = {status: 'error', data: [], message: e.message};
    }
    cache.set(key, out);
    return out;
  }

  // What a drawing with deps last drew from, per element.
  const drawnFrom = new WeakMap();
  function runDraw(name, force) {
    const {fn, deps} = reg.draws.get(name);
    const key = deps ? JSON.stringify([gen, window.innerWidth, deps.map((k) => params[k])]) : null;
    document.querySelectorAll(`[data-draw="${name}"]`).forEach((el) => {
      if (el.closest('[hidden]')) return;
      if (key && !force && drawnFrom.get(el) === key) return;
      try {
        fn(el);
        if (key) drawnFrom.set(el, key);
      } catch (e) {
        drawnFrom.delete(el);
        console.error(`Drawing "${name}" failed:`, e);
      }
    });
  }
  let pending = false, forceNext = false;
  function run() {
    const force = forceNext;
    pending = false;
    forceNext = false;
    for (const fn of reg.ons) { try { fn(); } catch (e) { console.error(e); } }
    for (const name of reg.draws.keys()) runDraw(name, force);
    for (const fn of reg.afters) { try { fn(); } catch (e) { console.error(e); } }
  }
  function schedule(force) {
    if (force) forceNext = true;
    if (pending) return;
    pending = true;
    setTimeout(run, 0);
  }

  window.dash = {
    colors: ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)'],
    loader: (id, spec) => { reg.loaders.set(id, spec); },
    calc: (id, spec) => { reg.calcs.set(id, spec); perRangeMemo.clear(); },
    data: compute,
    params: () => params,
    // Goes up whenever the data changes, for drawings that keep their own memo.
    gen: () => gen,
    setParams: (next) => {
      const datesChanged = ('from' in next && next.from !== params.from) || ('to' in next && next.to !== params.to);
      params = Object.assign({}, params, next);
      // Only the list of ranges changes with the custom dates; per-range results are keyed by their dates.
      if (datesChanged) { cache.delete('ranges'); gen += 1; }
      saveParams();
      schedule(false);
    },
    resetParams: () => { dash.setParams(Object.assign({}, DEFAULTS)); },
    onData: (fn) => { reg.ons.push(fn); },
    afterDraw: (fn) => { reg.afters.push(fn); },
    // dash.draw(name, fn, {deps}) registers a drawing; dash.draw(name) redraws it now.
    draw: (name, fn, opts) => {
      if (typeof fn === 'function') reg.draws.set(name, {fn, deps: opts && opts.deps});
      else if (reg.draws.has(name)) runDraw(name, true);
    },
    refresh: () => {},
    setLink: () => {},
    // App additions: swap in new CSV text ({intervals, tariffs}) and redraw;
    // forget the remembered choices; redraw now.
    setSources: (next) => {
      sources = Object.assign({}, next);
      dropCache();
      schedule(true);
    },
    forgetParams: () => {
      params = Object.assign({}, DEFAULTS);
      try { localStorage.removeItem(STORE); } catch { /* storage blocked */ }
      dropCache();
      schedule(true);
    },
    redraw: () => schedule(true),
    parseCsv,
  };

  function addDateFields() {
    const bar = document.querySelector('.eu-tariffbar');
    if (!bar || bar.querySelector('.eu-dates')) return;
    const wrap = document.createElement('span');
    wrap.className = 'eu-dates';
    const field = (id, text) => {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = text;
      const input = document.createElement('input');
      input.type = 'date';
      input.id = id;
      input.className = 'eu-date';
      wrap.append(label, input);
      return input;
    };
    const from = field('eu-from', 'from');
    const to = field('eu-to', 'to');
    bar.append(wrap);
    const apply = () => {
      if (!from.value || !to.value || !from.validity.valid || !to.validity.valid) return;
      dash.setParams({from: from.value, to: to.value, range: 'custom', day: ''});
    };
    from.addEventListener('change', apply);
    to.addEventListener('change', apply);
    // Keep the fields inside the file's dates and showing whichever range is chosen.
    reg.ons.push(() => {
      const ranges = compute('ranges').data || [];
      const all = ranges.find((r) => r.range === 'all');
      if (!all) return;
      for (const input of [from, to]) { input.min = all.from; input.max = all.to; }
      const g = chosenRange(ranges) || all;
      if (document.activeElement !== from) from.value = g.from;
      if (document.activeElement !== to) to.value = g.to;
    });
  }

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth !== lastWidth) {
      lastWidth = window.innerWidth;
      schedule(false);
    }
  });

  // Called once by app.js after dashboard.js has registered everything.
  dash.start = () => {
    addDateFields();
    schedule(true);
  };
})();
