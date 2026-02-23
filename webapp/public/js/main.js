/**
 * main.js — Unified frontend entry.
 * Loads the matching portal script by ?portal=client|authority|ops and calls its init.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var portal = (params.get('portal') || 'client').toLowerCase();
  var allowed = ['client', 'authority', 'ops'];
  var current = allowed.includes(portal) ? portal : 'client';

  // Highlight active portal tab
  document.querySelectorAll('.portal-tab').forEach(function (a) {
    a.classList.toggle('active', a.getAttribute('data-portal') === current);
  });

  // Chain/Token context selectors only for Client portal
  var contextEl = document.getElementById('shell-context-selectors');
  if (contextEl) contextEl.style.display = current === 'client' ? 'flex' : 'none';

  // Load portal script and call init on load
  window.YaultPortals = window.YaultPortals || {};
  var script = document.createElement('script');
  script.src = 'js/' + current + '-portal.js';
  script.onload = function () {
    var init = window.YaultPortals[current] && window.YaultPortals[current].init;
    if (typeof init === 'function') {
      init();
    } else {
      var app = document.getElementById('app');
      var msg = (typeof window.t === 'function' ? window.t('errorPortalLoad') : 'Portal failed to load.');
      if (app) {
        var p = document.createElement('p');
        p.className = 'alert alert-danger';
        p.textContent = msg;
        app.textContent = '';
        app.appendChild(p);
      }
    }
  };
  script.onerror = function () {
    var app = document.getElementById('app');
    var msg = (typeof window.t === 'function' ? window.t('errorPortalScript') : 'Failed to load portal script.');
    if (app) {
      var p = document.createElement('p');
      p.className = 'alert alert-danger';
      p.textContent = msg;
      app.textContent = '';
      app.appendChild(p);
    }
  };
  document.body.appendChild(script);
})();
