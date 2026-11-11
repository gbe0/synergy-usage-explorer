/*
 * load-readers.js - loads public/js/readers.js in Node for the tests, the way
 * the page runs it: a plain script that sets window.SynergyReaders.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function loadReaders() {
  const sandbox = {console};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js', 'readers.js'), 'utf8'), sandbox, {filename: 'js/readers.js'});
  return sandbox.SynergyReaders;
}

// Objects made in the sandbox have its own Object and Array, which
// assert.deepStrictEqual counts as different from the test's; this makes them plain.
const plain = (x) => JSON.parse(JSON.stringify(x));

module.exports = {loadReaders, plain, ROOT, PUBLIC};
