/*! Camplugie — swift-geo.js
 *  Address search ("customer types address → map picks it"), road distance and
 *  the Swift delivery fee. Used by swift.html.
 *
 *  Free by default:
 *    • Address search  → Photon (OpenStreetMap data), no key needed
 *    • Road distance   → OSRM public router (same one Swift already uses)
 *    • Map             → Leaflet + OpenStreetMap tiles
 *  Optional upgrade: put  window.CP_GOOGLE_MAPS_KEY = "AIza…";  in config.js and
 *  address search switches to Google Places (better for building / shop names).
 *  Restrict that key to your site (HTTP referrers) and to the "Places API (New)".
 *
 *  Fee rules (change the three numbers below):
 *    up to FLAT_KM by road  → FLAT_FEE (₦1,000 anywhere on / around campus)
 *    beyond that            → + PER_KM for every extra km (rounded up)
 */
(function () {
  'use strict';

  var CFG = { FLAT_FEE: 1000, FLAT_KM: 5, PER_KM: 150, ROAD_FACTOR: 1.3 };

  /* ---------- distance ---------- */
  function haversineKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    var R = 6371, rad = function (x) { return x * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Instant estimate (straight line × 1.3 ≈ typical road length). Used while the real route loads.
  function estimateKm(a, b) {
    var d = haversineKm(a, b);
    return d == null ? null : d * CFG.ROAD_FACTOR;
  }

  var routeCache = {};
  // Real road distance via OSRM; falls back to the estimate if the router is down or slow.
  function roadKm(a, b) {
    var est = estimateKm(a, b);
    if (est == null) return Promise.resolve({ km: null, source: 'none' });
    var key = [a.lat, a.lng, b.lat, b.lng].map(function (n) { return n.toFixed(4); }).join(',');
    if (routeCache[key]) return Promise.resolve(routeCache[key]);
    var url = 'https://router.project-osrm.org/route/v1/driving/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=false';
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { return r.json(); }).then(function (j) {
      if (timer) clearTimeout(timer);
      var m = j && j.routes && j.routes[0] && j.routes[0].distance;
      var out = m ? { km: m / 1000, source: 'road' } : { km: est, source: 'estimate' };
      if (m) routeCache[key] = out;
      return out;
    }).catch(function () { if (timer) clearTimeout(timer); return { km: est, source: 'estimate' }; });
  }

  /* ---------- fee ---------- */
  function prettyKm(km) { return km < 0.95 ? (Math.round(km * 100) * 10) + ' m' : km.toFixed(1) + ' km'; }

  function fee(km) {
    var total = CFG.FLAT_FEE;
    var breakdown = [{ label: 'Delivery (campus & nearby)', amount: CFG.FLAT_FEE }];
    if (km != null && km > CFG.FLAT_KM) {
      var extra = Math.ceil(km - CFG.FLAT_KM) * CFG.PER_KM;
      total += extra;
      breakdown.push({ label: 'Extra distance (' + prettyKm(km) + ' trip)', amount: extra });
    }
    return { fee: total, breakdown: breakdown, km: km };
  }

  /* ---------- address search ---------- */
  var JOS = { lat: 9.8965, lng: 8.8583 };   // default bias if the university has no pinned centre
  var gToken = null;
  function newToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function searchPhoton(q, bias) {
    var b = bias || JOS;
    var url = 'https://photon.komoot.io/api/?lang=en&limit=7&q=' + encodeURIComponent(q) +
              '&lat=' + b.lat + '&lon=' + b.lng + '&location_bias_scale=0.4';
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var seen = {};
      return (j.features || []).filter(function (f) {
        var p = f.properties || {};
        return !p.countrycode || p.countrycode === 'NG';
      }).map(function (f) {
        var p = f.properties || {}, c = f.geometry.coordinates;
        var main = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.district || p.city || 'Unnamed place';
        var sub = [p.street && p.name ? p.street : null, p.district || p.locality, p.city || p.county, p.state].filter(Boolean).join(', ');
        return { id: (p.osm_type || '') + (p.osm_id || '') + ':' + c.join(','), label: main, sub: sub, lat: c[1], lng: c[0], provider: 'photon' };
      }).filter(function (s) { if (seen[s.label + s.sub]) return false; seen[s.label + s.sub] = 1; return true; });
    });
  }

  function searchGoogle(q, bias) {
    var b = bias || JOS;
    if (!gToken) gToken = newToken();
    return fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': window.CP_GOOGLE_MAPS_KEY },
      body: JSON.stringify({
        input: q, sessionToken: gToken, includedRegionCodes: ['ng'],
        locationBias: { circle: { center: { latitude: b.lat, longitude: b.lng }, radius: 30000 } },
      }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      return (j.suggestions || []).filter(function (s) { return s.placePrediction; }).map(function (s) {
        var p = s.placePrediction, t = p.structuredFormat || {};
        return {
          id: p.placeId, provider: 'google',
          label: (t.mainText && t.mainText.text) || (p.text && p.text.text) || '',
          sub: (t.secondaryText && t.secondaryText.text) || '',
        };
      });
    });
  }

  // Returns a list of { id, label, sub, lat?, lng?, provider }. Never rejects.
  function search(q, bias) {
    q = (q || '').trim();
    if (q.length < 3) return Promise.resolve([]);
    var p = window.CP_GOOGLE_MAPS_KEY ? searchGoogle(q, bias).catch(function () { return searchPhoton(q, bias); }) : searchPhoton(q, bias);
    return p.catch(function () { return []; });
  }

  // Photon results already carry coordinates; Google needs one more call to turn a placeId into lat/lng.
  function resolve(s) {
    if (s.lat != null && s.lng != null) return Promise.resolve({ lat: s.lat, lng: s.lng, label: s.label });
    return fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(s.id) + '?sessionToken=' + encodeURIComponent(gToken || ''), {
      headers: { 'X-Goog-Api-Key': window.CP_GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'location,displayName' },
    }).then(function (r) { return r.json(); }).then(function (j) {
      gToken = null; // a session ends once a place is picked (keeps Google billing per-session)
      if (!j.location) throw new Error('no location');
      return { lat: j.location.latitude, lng: j.location.longitude, label: s.label };
    });
  }

  /* ---------- attach autocomplete to an <input> ---------- */
  // opts: { getBias():{lat,lng}, onPick({lat,lng,label}) }
  function attach(input, opts) {
    var box = document.createElement('div');
    box.className = 'geo-results';
    box.setAttribute('role', 'listbox');
    input.parentNode.style.position = 'relative';
    input.insertAdjacentElement('afterend', box);
    input.setAttribute('autocomplete', 'off');

    var timer = null, seq = 0, current = [];
    function close() { box.style.display = 'none'; box.innerHTML = ''; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    function paint(list, loading) {
      current = list;
      if (loading) { box.innerHTML = '<div class="geo-note">Searching…</div>'; box.style.display = 'block'; return; }
      if (!list.length) { box.innerHTML = '<div class="geo-note">No match — type more, or tap the map to drop a pin.</div>'; box.style.display = 'block'; return; }
      box.innerHTML = list.map(function (s, i) {
        return '<button type="button" class="geo-item" role="option" data-i="' + i + '"><b>' + esc(s.label) + '</b>' + (s.sub ? '<span>' + esc(s.sub) + '</span>' : '') + '</button>';
      }).join('');
      box.style.display = 'block';
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 3) { close(); return; }
      timer = setTimeout(function () {
        var mine = ++seq; paint([], true);
        search(q, opts.getBias && opts.getBias()).then(function (list) { if (mine === seq) paint(list); });
      }, 350);
    });

    // pointerdown so it fires before the input's blur hides the list
    box.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest('.geo-item'); if (!btn) return;
      e.preventDefault();
      var s = current[+btn.dataset.i]; if (!s) return;
      close(); input.value = s.label + (s.sub ? ', ' + s.sub.split(',')[0] : '');
      resolve(s).then(function (pt) { opts.onPick(pt); }).catch(function () { alert('Could not get that place’s location — tap the map to drop a pin instead.'); });
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    return { close: close };
  }

  window.CPGeo = { CFG: CFG, haversineKm: haversineKm, estimateKm: estimateKm, roadKm: roadKm, fee: fee, prettyKm: prettyKm, search: search, resolve: resolve, attach: attach };
})();
