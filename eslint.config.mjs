// eslint.config.mjs - lint rules for the project's own JavaScript.
// vendor/ (d3) and the files stamp_version.py generates are left out.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {ignores: ['node_modules/**', 'public/vendor/**', 'public/js/default-tariffs.js', 'public/js/sample-data.js']},
  js.configs.recommended,
  {
    // Plain <script> files that share the page's globals: d3 from vendor/,
    // and dash, which runtime.js puts on window for dashboard.js and app.js.
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {...globals.browser, d3: 'readonly', dash: 'readonly'},
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: {sourceType: 'script', globals: globals.serviceworker},
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {sourceType: 'commonjs', globals: globals.node},
  },
];
