/*
 * load-app.js - runs the dashboard's data steps in Node, without a browser.
 *
 * It loads d3, runtime.js and dashboard.js into a sandbox with just enough of
 * a browser stubbed out for them to register their steps, then hands back
 * `dash`. Tests feed it CSV text with dash.setSources() and read results with
 * dash.data(id). Nothing is drawn: drawing needs a real page.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

function loadApp() {
  const noop = () => {};
  const stored = new Map();
  const sandbox = {
    console,
    // runtime.js schedules redraws with setTimeout; there is nothing to draw here.
    setTimeout: noop,
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => { stored.set(k, String(v)); },
      removeItem: (k) => { stored.delete(k); },
    },
    document: {querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, activeElement: null},
    addEventListener: noop,
    innerWidth: 1024,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['vendor/d3.v7.9.0.min.js', 'js/runtime.js', 'js/dashboard.js']) {
    vm.runInContext(read(file), sandbox, {filename: file});
  }
  return sandbox.dash;
}

const sampleCsv = () => read('data/sample-interval-data.csv');
const tariffsCsv = () => read('data/tariffs.csv');

module.exports = {loadApp, sampleCsv, tariffsCsv, PUBLIC};
