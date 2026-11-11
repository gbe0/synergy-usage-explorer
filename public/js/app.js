/*
 * app.js - everything around the dashboard: opening the meter and tariff
 * CSVs (readers.js reads and checks them), the tariff editor, keeping both
 * in this browser (IndexedDB), and the offline / install plumbing, including
 * offering a new version. Nothing here sends data anywhere.
 */
(function () {
  'use strict';

  // The default tariffs come from data/tariffs.csv, which stamp_version.py copies into
  // js/default-tariffs.js (a page opened from disk can't read the CSV itself).
  const DEFAULT_TARIFFS = typeof window.SYNERGY_TOOL_DEFAULT_TARIFFS === 'string' ? window.SYNERGY_TOOL_DEFAULT_TARIFFS : null;
  // Reading and checking the CSV files is in readers.js, shared with the tests.
  // start() stops with the "didn't load" note if it is missing.
  const R = window.SynergyReaders || {};
  const {InputError, RATE_COLUMNS, CREDIT_COLUMN, isAmount, niceDate, listNames,
    parseIntervals, mergeIntervals, tariffDate, readTariffs, tariffsToCsv, looksLikeTariffs} = R;
  const MAX_BYTES = 50 * 1024 * 1024;

  const $ = (sel) => document.querySelector(sel);
  const count = (n) => n.toLocaleString('en');

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

  // Each tariff is a card (template #tariff-card) holding one box per set of
  // rates (template #tariff-period), oldest first. syncTariffCards() keeps
  // their numbering, ids and labels right after any change.
  const dialog = () => $('#tariff-dialog');
  const periodColumns = () => [...RATE_COLUMNS, CREDIT_COLUMN];

  function periodBox(p) {
    const box = $('#tariff-period').content.firstElementChild.cloneNode(true);
    box.querySelector('[data-col="from"]').value = p.from || '';
    for (const {col} of periodColumns()) box.querySelector(`[data-col="${col}"]`).value = p[col] || '';
    return box;
  }

  function tariffCard(t) {
    const card = $('#tariff-card').content.firstElementChild.cloneNode(true);
    card.querySelector('[name="tariff"]').value = t.tariff;
    card.querySelector('[name="current"]').checked = !!t.current;
    card.querySelector('.app-periods').append(...(t.rates && t.rates.length ? t.rates : [{}]).map(periodBox));
    return card;
  }

  function renderTariffCards(list) {
    $('#tariff-list').replaceChildren(...list.map(tariffCard));
    syncTariffCards();
  }

  function syncTariffCards() {
    const cards = [...document.querySelectorAll('#tariff-list .app-tariff')];
    cards.forEach((card, i) => {
      const nameInput = card.querySelector('[name="tariff"]');
      const name = nameInput.value.trim() || `tariff ${i + 1}`;
      card.querySelector(':scope > legend').textContent = `Tariff ${i + 1}`;
      // Ids follow each field's place, so they stay unique as tariffs and rates come and go.
      nameInput.id = `tariff-${i}-name`;
      card.querySelector('[name="current"]').id = `tariff-${i}-current`;
      const remove = card.querySelector('.app-remove');
      remove.disabled = cards.length < 2;
      remove.setAttribute('aria-label', `Remove ${name}`);
      const periods = [...card.querySelectorAll('.app-period')];
      periods.forEach((box, n) => {
        box.querySelector(':scope > legend').textContent = periods.length > 1 ? `Rates ${n + 1}` : 'Rates';
        // Only the first set of rates can do without a start date.
        box.querySelector('.app-field-from span').textContent = n ? 'From' : 'From (optional)';
        box.querySelectorAll('input').forEach((input) => { input.id = `tariff-${i}-${n}-${input.dataset.col}`; });
        const rm = box.querySelector('.app-period-remove');
        rm.hidden = periods.length < 2;
        rm.setAttribute('aria-label', `Remove rates ${n + 1} of ${name}`);
      });
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

  // Reads the editor; returns {list} or {error, input}. Follows readTariffs's rules.
  function collectTariffs() {
    document.querySelectorAll('#tariff-list [aria-invalid]').forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    });
    const list = [];
    const names = new Set();
    for (const card of document.querySelectorAll('#tariff-list .app-tariff')) {
      const nameInput = card.querySelector('[name="tariff"]');
      const name = nameInput.value.trim();
      if (!name) return {error: 'Give each tariff a name.', input: nameInput};
      if (names.has(name.toLowerCase())) return {error: `Two tariffs are called “${name}”. Give them different names.`, input: nameInput};
      names.add(name.toLowerCase());
      const t = {tariff: name, current: card.querySelector('[name="current"]').checked, rates: []};
      const periods = [...card.querySelectorAll('.app-period')];
      for (const [n, box] of periods.entries()) {
        const fromInput = box.querySelector('[data-col="from"]');
        const from = fromInput.value;
        const which = periods.length > 1 ? ` (rates ${n + 1})` : '';
        if (fromInput.validity.badInput || (from && tariffDate(from) !== from)) {
          return {error: `The from date for “${name}”${which} isn’t complete. Fill it in${n ? '' : ' or clear it'}.`, input: fromInput};
        }
        if (!from && n) return {error: `Fill in the date rates ${n + 1} for “${name}” start from. Only the first rates can leave it blank.`, input: fromInput};
        if (t.rates.some((p) => p.from === from)) {
          return {error: `“${name}” has two sets of rates from ${niceDate(from)}. Give each set the date it starts.`, input: fromInput};
        }
        const p = {from};
        for (const {col, label} of periodColumns()) {
          const input = box.querySelector(`[data-col="${col}"]`);
          const v = input.value.trim().replace(/^0+(?=\d)/, '');
          if (v === '' && col === CREDIT_COLUMN.col) { p[col] = '0'; continue; }
          if (v === '') return {error: `Fill in the ${label} for “${name}”${which}.`, input};
          if (!isAmount(v)) return {error: `The ${label} for “${name}”${which} should be a number of cents, like 24.3431.`, input};
          p[col] = v;
        }
        t.rates.push(p);
      }
      t.rates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
      list.push(t);
    }
    if (!list.length) return {error: 'Add at least one tariff.', input: $('#tariff-add')};
    return {list};
  }

  // A field that gets focus (by Tab, or when a problem points at it) shouldn't end up under the sticky footer.
  const clearFoot = () => { dialog().style.scrollPaddingBottom = `${dialog().querySelector('.app-dialog-foot').offsetHeight + 8}px`; };

  function checkedTariffs() {
    const r = collectTariffs();
    if (r.error) {
      if (r.input.tagName === 'INPUT') {
        r.input.setAttribute('aria-invalid', 'true');
        r.input.setAttribute('aria-describedby', 'tariff-status');
      }
      tariffStatus('error', r.error);
      clearFoot();   // now, as the message may have made the footer taller
      r.input.focus({preventScroll: true});
      r.input.scrollIntoView({block: 'nearest'});
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
    if (window.ResizeObserver) new ResizeObserver(clearFoot).observe(dialog().querySelector('.app-dialog-foot'));
    $('#tariff-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const list = checkedTariffs();
      if (!list) return;
      try {
        setTariffs(tariffsToCsv(list), 'The tariff list', true);
      } catch (err) {
        tariffStatus('error', err.message);
        return;
      }
      dialog().close();
      message('info', 'Tariffs saved.');
    });
    $('#tariff-add').addEventListener('click', () => {
      const card = tariffCard({tariff: '', current: false});
      $('#tariff-list').append(card);
      syncTariffCards();
      card.querySelector('[name="tariff"]').focus();
    });
    $('#tariff-list').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const card = b.closest('.app-tariff');
      if (b.matches('.app-remove')) {
        const next = card.nextElementSibling || card.previousElementSibling;
        card.remove();
        syncTariffCards();
        if (next) next.querySelector('[name="tariff"]').focus();
      } else if (b.matches('.app-period-add')) {
        // New rates start as a copy of the latest ones, so only what changed needs typing.
        const boxes = card.querySelectorAll('.app-period');
        const last = boxes[boxes.length - 1];
        const copy = Object.fromEntries(periodColumns().map(({col}) => [col, last.querySelector(`[data-col="${col}"]`).value]));
        const box = periodBox(copy);
        last.after(box);
        syncTariffCards();
        box.querySelector('[data-col="from"]').focus();
      } else if (b.matches('.app-period-remove')) {
        const box = b.closest('.app-period');
        const next = box.nextElementSibling || box.previousElementSibling;
        box.remove();
        syncTariffCards();
        next.querySelector('[data-col="from"]').focus();
      }
    });
    $('#tariff-list').addEventListener('input', (e) => {
      e.target.removeAttribute('aria-invalid');
      e.target.removeAttribute('aria-describedby');
      if (e.target.name === 'tariff') syncTariffCards();
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
    // A new version installs alongside the one this page runs on and waits
    // (sw.js doesn't skip waiting), so a page never mixes old and new files.
    // Reload asks the waiting worker to take over, and every open tab then
    // reloads once, on controllerchange.
    let controlled = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // The first visit's worker taking charge: this page already has its files.
      if (!controlled) { controlled = true; return; }
      if (reloading) return;
      // Not twice within a few seconds either: a worker that keeps replacing
      // itself (DevTools' "Update on reload" does) would reload for ever.
      try {
        if (Date.now() - Number(sessionStorage.getItem('synergy-tool-reloaded') || 0) < 10000) return;
        sessionStorage.setItem('synergy-tool-reloaded', String(Date.now()));
      } catch { /* storage blocked: `reloading` still stops a loop within this page */ }
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = () => {
        if (!navigator.serviceWorker.controller) return;   // a first install takes over by itself
        message('info', 'A new version of the app is ready.', {label: 'Reload', fn: () => {
          if (reg.waiting) reg.waiting.postMessage({type: 'SKIP_WAITING'});
          else window.location.reload();
        }});
      };
      if (reg.waiting) offer();
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => { if (worker.state === 'installed') offer(); });
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
    if (!window.d3 || !window.dash || !dash.start || DEFAULT_TARIFFS == null || !R.readTariffs) {
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
      const base = canon(savedBase);
      if (base !== null && base === canon(DEFAULT_TARIFFS)) {
        store.set('tariffsBase', DEFAULT_TARIFFS);   // only its layout changed (say, a new column), not the tariffs
      } else if (canon(savedTariffs) === base) {
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
