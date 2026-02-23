/**
 * wasm-loader.js — Load ACEGF and Custody WASM in the webapp.
 *
 * Exposes window.YaultWasm:
 *   - init() -> Promise<void>  (call once before using custody/acegf)
 *   - acegf   -> namespace of acegf exports (after init)
 *   - custody -> namespace of custody exports (after init, or null if not built)
 *   - ready   -> boolean
 *   - custodyError -> string if custody failed to load (e.g. "Run npm run build:wasm:webapp")
 *
 * Usage:
 *   await window.YaultWasm.init();
 *   if (window.YaultWasm.custody) {
 *     const creds = window.YaultWasm.custody.custody_generate_path(1, 'Recipient A');
 *   }
 */
(function () {
  'use strict';
  var script = typeof document !== 'undefined' && document.currentScript;
  var base = script ? script.src.replace(/\/[^/]+$/, '') + '/' : '';
  var wasmDir = base.replace(/js\/?$/, 'wasm/');

  window.YaultWasm = {
    ready: false,
    acegf: null,
    custody: null,
    custodyError: null,

    init: function () {
      var self = this;
      if (self.ready) return Promise.resolve();

      return (async function () {
        try {
          var acegfMod = await import(/* webpackIgnore: true */ wasmDir + 'acegf.js');
          if (typeof acegfMod.default === 'function') {
            await acegfMod.default();
          }
          self.acegf = acegfMod;
        } catch (e) {
          console.warn('[YaultWasm] acegf load failed:', e.message);
          self.acegf = null;
          throw e;
        }

        try {
          var custodyMod = await import(/* webpackIgnore: true */ wasmDir + 'yault_custody_wasm.js');
          if (typeof custodyMod.default === 'function') {
            await custodyMod.default();
          }
          self.custody = custodyMod;
          self.custodyError = null;
        } catch (e) {
          console.warn('[YaultWasm] custody wasm not loaded:', e.message);
          self.custody = null;
          self.custodyError = e.message || 'Run npm run build:wasm:webapp to build and copy custody WASM.';
        }

        self.ready = true;
      })();
    },
  };
})();
