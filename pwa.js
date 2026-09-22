/*! Camplugie — pwa.js
 *  ONE file that gives every page:
 *    1. the animated launch splash (once per app launch)
 *    2. a slim top loading bar between pages
 *    3. CPLoader  – overlay / spinner / skeleton helpers you can call from any page
 *    4. service-worker registration + "app updated" toast
 *    5. install prompt (Android/Chrome) and "Add to Home Screen" hint (iPhone)
 *    6. CamplugiePWA.share() – native share sheet with a WhatsApp fallback
 *
 *  Add this to the <head> of every page (tools/patch-html.js does it for you):
 *      <script src="/pwa.js"></script>
 */
(function () {
  'use strict';
  if (window.__cpPwa) return;
  window.__cpPwa = true;

  var doc = document, root = doc.documentElement;
  var page = (location.pathname.replace(/\/+$/, '').split('/').pop() || 'index').replace(/\.html$/, '') || 'index';

  /* ---------- settings you may want to tweak ---------- */
  var APK_URL       = '/downloads/camplugie.apk';
  var SPLASH_MIN_MS = 1500;   // splash always plays at least this long
  var SPLASH_MAX_MS = 6000;   // …and never blocks the app longer than this
  var NO_SPLASH = ['offline', 'call', 'group-call', 'turn-test', 'admin', 'ambassador', 'download', 'preview'];
  var NO_PROMPT = ['offline', 'call', 'group-call', 'turn-test', 'admin', 'ambassador', 'download', 'preview',
                   'auth', 'onboarding', 'verify-email', 'banned', 'chat-thread', 'group-thread',
                   'create', 'cart', 'wallet', 'orders', 'swift', 'listing'];
  var NO_TOAST  = ['call', 'group-call'];

  /* ---------- tiny helpers ---------- */
  function has(list) { return list.indexOf(page) !== -1; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function sess(k, v)  { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) {} return null; }
  function isStandalone() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true ||
           (doc.referrer || '').indexOf('android-app://') === 0;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isAndroid() { return /android/i.test(navigator.userAgent); }
  function inAppBrowser() { return /FBAN|FBAV|Instagram|Line\/|Twitter|MicroMessenger|TikTok/i.test(navigator.userAgent); }
  function addStyle(id, css) {
    if (doc.getElementById(id)) return;
    var s = doc.createElement('style'); s.id = id; s.textContent = css;
    (doc.head || root).appendChild(s);
  }

  /* =====================================================================
   *  CSS  (all class names are prefixed cps- / cp- so they can't clash)
   * ===================================================================== */
  var SPLASH_CSS = [
    '#cp-splash{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;',
    'background:radial-gradient(circle at 18% -8%,rgba(124,58,237,.42),transparent 44%),radial-gradient(circle at 92% 108%,rgba(56,189,248,.18),transparent 42%),linear-gradient(180deg,#0E0A1D,#090714);',
    'transition:opacity .5s ease,transform .5s ease}',
    '#cp-splash.cps-out{opacity:0;transform:scale(1.04);pointer-events:none}',
    '.cps-inner{display:flex;flex-direction:column;align-items:center;gap:20px;padding-bottom:5vh}',
    '.cps-mark{width:min(52vw,220px);height:auto;overflow:visible}',
    '.cps-word{width:min(64vw,250px);height:auto;overflow:visible}',
    '.cps-bar{width:min(32vw,116px);height:3px;border-radius:3px;background:rgba(167,139,250,.16);overflow:hidden;opacity:0;animation:cps-fade .4s ease .9s forwards}',
    '.cps-bar i{display:block;height:100%;width:45%;border-radius:3px;background:linear-gradient(90deg,#A78BFA,#38BDF8);animation:cps-slide 1.15s ease-in-out infinite}',
    '.cps-float{animation:cps-float 3.2s ease-in-out 1.6s infinite}',
    '.cps-rm{stroke-dasharray:1 1.02;stroke-dashoffset:1.01;animation:cps-draw .75s cubic-bezier(.6,0,.25,1) .05s forwards}',
    '.cps-tail,.cps-shield,.cps-plug,.cps-cap,.cps-node,.cps-dot,.cps-spark{transform-box:fill-box;transform-origin:center}',
    '.cps-tail{transform-origin:78% 6%;opacity:0;animation:cps-tail .35s cubic-bezier(.3,1.5,.5,1) .5s forwards}',
    '.cps-shield{opacity:0;animation:cps-pop .6s cubic-bezier(.3,1.4,.5,1) .2s forwards}',
    '.cps-hex{stroke-dasharray:1 1.02;stroke-dashoffset:1.01;animation:cps-draw .5s ease .55s forwards}',
    '.cps-node{opacity:0;animation:cps-node .4s cubic-bezier(.3,1.6,.5,1) calc(.62s + var(--i)*.06s) forwards,cps-pulse 2.4s ease-in-out calc(1.7s + var(--i)*.2s) infinite;animation-fill-mode:forwards,none}',
    '.cps-plug{opacity:0;animation:cps-plug .55s cubic-bezier(.3,1.3,.5,1) .5s forwards}',
    '.cps-spark{opacity:0;animation:cps-spark .6s ease-out .95s forwards}',
    '.cps-cap{opacity:0;animation:cps-cap .55s cubic-bezier(.3,1.5,.5,1) .7s forwards}',
    '.cps-stroke{stroke-dasharray:1 1.02;stroke-dashoffset:1.01;animation:cps-draw .45s cubic-bezier(.5,0,.2,1) calc(.75s + var(--i)*.04s) forwards}',
    '.cps-dot{transform:scale(0);animation:cps-dot .35s cubic-bezier(.3,1.7,.5,1) calc(.85s + var(--i)*.04s) forwards}',
    '@keyframes cps-draw{to{stroke-dashoffset:0}}',
    '@keyframes cps-pop{0%{opacity:0;transform:scale(.55)}65%{opacity:1;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}',
    '@keyframes cps-tail{0%{opacity:0;transform:scale(0)}100%{opacity:1;transform:scale(1)}}',
    '@keyframes cps-node{0%{opacity:0;transform:scale(0)}100%{opacity:1;transform:scale(1)}}',
    '@keyframes cps-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.28)}}',
    '@keyframes cps-plug{0%{opacity:0;transform:translate(52px,-52px) rotate(10deg)}60%{opacity:1;transform:translate(-5px,5px)}100%{opacity:1;transform:none}}',
    '@keyframes cps-spark{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(2.4)}}',
    '@keyframes cps-cap{0%{opacity:0;transform:translateY(-40px) rotate(-6deg)}65%{opacity:1;transform:translateY(5px)}100%{opacity:1;transform:none}}',
    '@keyframes cps-dot{to{transform:scale(1)}}',
    '@keyframes cps-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
    '@keyframes cps-fade{to{opacity:1}}',
    '@keyframes cps-slide{0%{transform:translateX(-110%)}100%{transform:translateX(250%)}}',
    '@media (prefers-reduced-motion:reduce){#cp-splash *{animation:none!important}',
    '.cps-rm,.cps-hex,.cps-stroke{stroke-dashoffset:0}.cps-tail,.cps-shield,.cps-plug,.cps-cap,.cps-node{opacity:1}',
    '.cps-dot{transform:none}.cps-bar{opacity:1}.cps-bar i{width:100%}}'
  ].join('');

  var UI_CSS = [
    /* top loading bar */
    '#cp-topbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483500;pointer-events:none;opacity:0;transition:opacity .25s}',
    '#cp-topbar.on{opacity:1}',
    '#cp-topbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#A78BFA,#7C6CFF,#38BDF8);box-shadow:0 0 10px rgba(124,108,255,.7);border-radius:0 3px 3px 0;transition:width .35s ease}',
    /* spinner */
    '.cp-spinner{display:inline-block;width:var(--s,28px);height:var(--s,28px);border-radius:50%;box-sizing:border-box;',
    'border:calc(var(--s,28px)/9) solid rgba(167,139,250,.2);border-top-color:#A78BFA;border-right-color:#38BDF8;animation:cp-spin .75s linear infinite;vertical-align:middle}',
    '.cp-spinner.sm{--s:16px}.cp-spinner.lg{--s:44px}',
    '.cp-dots{display:inline-flex;gap:5px;align-items:center}.cp-dots i{width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,#A78BFA,#38BDF8);animation:cp-bounce 1s ease-in-out infinite}',
    '.cp-dots i:nth-child(2){animation-delay:.15s}.cp-dots i:nth-child(3){animation-delay:.3s}',
    /* skeletons */
    '.cp-skeleton,.cp-skel-line,.cp-skel-circle,.cp-skel-block{background:linear-gradient(90deg,var(--surface2,#1A1729) 25%,var(--surface3,#242039) 50%,var(--surface2,#1A1729) 75%);background-size:200% 100%;animation:cp-shimmer 1.4s linear infinite;border-radius:10px}',
    '.cp-skel-line{height:12px;margin:8px 0}.cp-skel-line.w60{width:60%}.cp-skel-line.w40{width:40%}',
    '.cp-skel-circle{width:44px;height:44px;border-radius:50%;flex:none}.cp-skel-block{height:150px;border-radius:16px}',
    '.cp-skel-card{display:flex;gap:12px;align-items:center;padding:14px;border-radius:16px;background:var(--surface,#12101D);border:1px solid var(--border,rgba(255,255,255,.06));margin:10px 0}',
    '.cp-skel-card>div:not(.cp-skel-circle){flex:1}',
    /* overlay */
    '#cp-overlay{position:fixed;inset:0;z-index:2147483400;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;',
    'background:rgba(9,7,20,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .2s;color:#F8F6FF;font:600 14px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:24px}',
    '#cp-overlay.on{opacity:1;pointer-events:auto}',
    /* toast */
    '#cp-toast{position:fixed;left:50%;bottom:calc(92px + env(safe-area-inset-bottom,0px));transform:translate(-50%,20px);z-index:2147483300;display:flex;gap:14px;align-items:center;',
    'background:rgba(26,23,41,.96);color:#F8F6FF;border:1px solid rgba(167,139,250,.28);border-radius:14px;padding:11px 16px;font:600 13.5px/1.3 system-ui,-apple-system,sans-serif;',
    'box-shadow:0 10px 30px rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:all .28s ease;max-width:calc(100vw - 32px)}',
    '#cp-toast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}',
    '#cp-toast button{background:none;border:0;color:#A78BFA;font:700 13.5px system-ui,sans-serif;cursor:pointer;padding:2px 0}',
    /* install banner */
    '#cp-install{position:fixed;left:12px;right:12px;bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:2147483200;display:flex;align-items:center;gap:12px;',
    'padding:12px 12px 12px 14px;border-radius:20px;color:#F8F6FF;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    'background:linear-gradient(135deg,rgba(38,28,86,.96),rgba(18,16,29,.96));border:1px solid rgba(167,139,250,.32);',
    '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 18px 44px rgba(0,0,0,.5),0 0 0 1px rgba(124,58,237,.12);',
    'transform:translateY(30px);opacity:0;transition:all .38s cubic-bezier(.2,.9,.3,1.1);max-width:460px;margin:0 auto}',
    '#cp-install.on{transform:none;opacity:1}',
    '#cp-install img{width:46px;height:46px;border-radius:12px;flex:none}',
    '#cp-install .t{flex:1;min-width:0}#cp-install .t b{display:block;font-size:14.5px;margin-bottom:2px}',
    '#cp-install .t span{display:block;font-size:12.5px;color:#C9C3DE;line-height:1.35}',
    '#cp-install .t svg{width:14px;height:14px;vertical-align:-2px;margin:0 1px}',
    '#cp-install .go{background:linear-gradient(135deg,#7C3AED,#4F8DF7);color:#fff;border:0;border-radius:12px;padding:10px 16px;font:700 13.5px system-ui,sans-serif;cursor:pointer;flex:none}',
    '#cp-install .x{background:none;border:0;color:#8D86AA;font-size:18px;cursor:pointer;padding:4px 6px;flex:none}',
    '@keyframes cp-spin{to{transform:rotate(360deg)}}@keyframes cp-shimmer{to{background-position:-200% 0}}',
    '@keyframes cp-bounce{0%,80%,100%{transform:scale(.6);opacity:.5}40%{transform:scale(1);opacity:1}}'
  ].join('');

  var MARK_SVG = "<svg class=\"cps-mark\" viewBox=\"0 0 512 512\" aria-hidden=\"true\"><defs>\n<linearGradient id=\"s-gr\" gradientUnits=\"userSpaceOnUse\" x1=\"70\" y1=\"40\" x2=\"460\" y2=\"480\">\n  <stop offset=\"0\" stop-color=\"#F0A6FF\"/><stop offset=\".30\" stop-color=\"#B77DFF\"/>\n  <stop offset=\".62\" stop-color=\"#7C6CFF\"/><stop offset=\"1\" stop-color=\"#38C4F5\"/>\n</linearGradient>\n<linearGradient id=\"s-gp\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">\n  <stop offset=\"0\" stop-color=\"#8ED8FF\"/><stop offset=\"1\" stop-color=\"#3B82F6\"/>\n</linearGradient>\n<linearGradient id=\"s-gs\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n  <stop offset=\"0\" stop-color=\"#3E31A6\"/><stop offset=\"1\" stop-color=\"#1D1364\"/>\n</linearGradient>\n<linearGradient id=\"s-gm\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">\n  <stop offset=\"0\" stop-color=\"#A78BFA\"/><stop offset=\"1\" stop-color=\"#38BDF8\"/>\n</linearGradient>\n<linearGradient id=\"s-gc\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n  <stop offset=\"0\" stop-color=\"#FFFFFF\"/><stop offset=\"1\" stop-color=\"#D5CCFF\"/>\n</linearGradient>\n<radialGradient id=\"s-gn\" cx=\".35\" cy=\".3\" r=\".8\">\n  <stop offset=\"0\" stop-color=\"#F3EEFF\"/><stop offset=\"1\" stop-color=\"#7C6CFF\"/>\n</radialGradient>\n<linearGradient id=\"s-gh\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">\n  <stop offset=\"0\" stop-color=\"#fff\" stop-opacity=\".55\"/><stop offset=\".5\" stop-color=\"#fff\" stop-opacity=\"0\"/>\n</linearGradient>\n<filter id=\"s-glow\" x=\"-60%\" y=\"-60%\" width=\"220%\" height=\"220%\"><feGaussianBlur stdDeviation=\"5\"/></filter>\n<mask id=\"s-rm\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"512\" height=\"512\"><path class=\"cps-rm\" d=\"M323.8 72.0 L308.2 67.6 L292.3 64.6 L276.1 62.9 L259.9 62.5 L243.8 63.6 L227.7 65.9 L212.0 69.6 L196.6 74.6 L181.6 80.9 L167.3 88.4 L153.6 97.1 L140.7 106.9 L128.6 117.7 L117.5 129.6 L107.5 142.3 L98.5 155.8 L90.7 170.0 L84.1 184.8 L78.8 200.1 L74.7 215.8 L72.0 231.7 L70.7 247.9 L70.7 264.1 L72.0 280.3 L74.7 296.2 L78.8 311.9 L84.1 327.2 L90.7 342.0 L98.5 356.2 L107.5 369.7 L117.5 382.4 L128.6 394.3 L140.7 405.1 L153.6 414.9 L167.2 423.6 L181.6 431.1 L196.6 437.4 L212.0 442.4 L227.7 446.1 L243.8 448.4 L259.9 449.5 L276.1 449.1 L292.3 447.4 L308.2 444.4 L323.8 440.0 L339.0 434.4 L353.6 427.5 L367.7 419.4 L381.0 410.1 L393.5 399.8 L405.1 388.5 L415.6 376.2 L425.2 363.1 L433.6 349.2 L440.8 334.7 L446.7 319.6 L451.4 304.1 L454.8 288.3 L456.8 272.2 L457.5 256.0\" fill=\"none\" stroke=\"#fff\" stroke-width=\"120\" stroke-linecap=\"round\" pathLength=\"1\"/></mask></defs><g class=\"cps-float\"><g mask=\"url(#s-rm)\"><path d=\"M325.2 43.0 A224 224 0 1 0 480.0 256.0 A22.5 22.5 0 0 0 435.0 256.0 A163 163 0 1 1 322.4 101.0 A29.0 29.0 0 0 0 325.2 43.0 Z\" fill=\"url(#s-gr)\"/><path d=\"M325.2 43.0 A224 224 0 1 0 480.0 256.0 A22.5 22.5 0 0 0 435.0 256.0 A163 163 0 1 1 322.4 101.0 A29.0 29.0 0 0 0 325.2 43.0 Z\" fill=\"url(#s-gh)\"/></g><path class=\"cps-tail\" d=\"M118.8 408.3 Q 96 452 66 494 Q 150 492 220.4 457.9 Z\" fill=\"url(#s-gr)\"/><g class=\"cps-plug\"><rect x=\"392\" y=\"40\" width=\"20\" height=\"74\" rx=\"10\" fill=\"url(#s-gp)\"/><rect x=\"444\" y=\"40\" width=\"20\" height=\"74\" rx=\"10\" fill=\"url(#s-gp)\"/><rect x=\"369\" y=\"98\" width=\"112\" height=\"120\" rx=\"22\" fill=\"url(#s-gp)\"/><rect x=\"376\" y=\"104\" width=\"98\" height=\"46\" rx=\"16\" fill=\"#fff\" opacity=\".16\"/></g><circle class=\"cps-spark\" cx=\"440\" cy=\"228\" r=\"22\" fill=\"none\" stroke=\"#8ED8FF\" stroke-width=\"5\"/><g class=\"cps-shield\"><path d=\"M170 326 L214 352 L160 386 Z\" fill=\"#2A1E86\" stroke=\"url(#s-gm)\" stroke-width=\"9\" stroke-linejoin=\"round\"/><path d=\"M258 146 C304 146 346 160 376 182 L376 268 C376 318 324 352 258 378 C192 352 140 318 140 268 L140 182 C170 160 212 146 258 146 Z\" fill=\"url(#s-gs)\" stroke=\"url(#s-gm)\" stroke-width=\"9\" stroke-linejoin=\"round\"/></g><path class=\"cps-hex\" d=\"M262 172 L348 210 L348 300 L262 338 L176 300 L176 210 Z\" fill=\"none\" stroke=\"#6F7FF0\" stroke-width=\"5\" stroke-linejoin=\"round\" opacity=\".85\" pathLength=\"1\"/><g class=\"cps-node\" style=\"--i:0\"><circle cx=\"262\" cy=\"172\" r=\"17\" fill=\"#8B7BFF\" opacity=\".55\" filter=\"url(#s-glow)\"/><circle cx=\"262\" cy=\"172\" r=\"11.5\" fill=\"url(#s-gn)\"/></g><g class=\"cps-node\" style=\"--i:1\"><circle cx=\"348\" cy=\"210\" r=\"17\" fill=\"#8B7BFF\" opacity=\".55\" filter=\"url(#s-glow)\"/><circle cx=\"348\" cy=\"210\" r=\"11.5\" fill=\"url(#s-gn)\"/></g><g class=\"cps-node\" style=\"--i:2\"><circle cx=\"348\" cy=\"300\" r=\"17\" fill=\"#8B7BFF\" opacity=\".55\" filter=\"url(#s-glow)\"/><circle cx=\"348\" cy=\"300\" r=\"11.5\" fill=\"url(#s-gn)\"/></g><g class=\"cps-node\" style=\"--i:3\"><circle cx=\"262\" cy=\"338\" r=\"17\" fill=\"#8B7BFF\" opacity=\".55\" filter=\"url(#s-glow)\"/><circle cx=\"262\" cy=\"338\" r=\"11.5\" fill=\"url(#s-gn)\"/></g><g class=\"cps-node\" style=\"--i:4\"><circle cx=\"176\" cy=\"300\" r=\"17\" fill=\"#8B7BFF\" opacity=\".55\" filter=\"url(#s-glow)\"/><circle cx=\"176\" cy=\"300\" r=\"11.5\" fill=\"url(#s-gn)\"/></g><g class=\"cps-node\" style=\"--i:5\"><circle cx=\"176\" cy=\"210\" r=\"17\" fill=\"#8B7BFF\" opacity=\".55\" filter=\"url(#s-glow)\"/><circle cx=\"176\" cy=\"210\" r=\"11.5\" fill=\"url(#s-gn)\"/></g><g class=\"cps-cap\"><path d=\"M226 256 L226 284 C226 298 290 298 290 284 L290 256 Z\" fill=\"#9AA6FF\" opacity=\".95\"/><path d=\"M258 214 L326 244 L258 274 L190 244 Z\" fill=\"url(#s-gc)\"/><path d=\"M258 214 L326 244 L258 274 Z\" fill=\"#B9B0F6\" opacity=\".35\"/><path d=\"M204 252 L204 292\" stroke=\"#C9C1FF\" stroke-width=\"5\" stroke-linecap=\"round\"/><circle cx=\"204\" cy=\"296\" r=\"6\" fill=\"#C9C1FF\"/></g></g></svg>";
  var WORD_SVG = "<svg class=\"cps-word\" viewBox=\"-8 -70 341 100\" aria-hidden=\"true\"><defs><linearGradient id=\"s-gw\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"325\" y2=\"0\"><stop offset=\"0\" stop-color=\"#B77DFF\"/><stop offset=\".5\" stop-color=\"#C9C3FF\"/><stop offset=\"1\" stop-color=\"#5FD3F7\"/></linearGradient></defs><g fill=\"none\" stroke=\"url(#s-gw)\" stroke-width=\"8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M 27.9 -30.7 A 16 16 0 1 0 27.9 -9.3\" class=\"cps-stroke\" style=\"--i:0\" pathLength=\"1\"/><path d=\"M 55 -36 A 16 16 0 1 0 55 -4 A 16 16 0 1 0 55 -36\" class=\"cps-stroke\" style=\"--i:1\" pathLength=\"1\"/><path d=\"M 71 -36 V -4\" class=\"cps-stroke\" style=\"--i:1\" pathLength=\"1\"/><path d=\"M 83 -36 V -4\" class=\"cps-stroke\" style=\"--i:2\" pathLength=\"1\"/><path d=\"M 83 -24 A 12 12 0 0 1 107 -24 V -4\" class=\"cps-stroke\" style=\"--i:2\" pathLength=\"1\"/><path d=\"M 107 -24 A 12 12 0 0 1 131 -24 V -4\" class=\"cps-stroke\" style=\"--i:2\" pathLength=\"1\"/><path d=\"M 143 -36 V 20\" class=\"cps-stroke\" style=\"--i:3\" pathLength=\"1\"/><path d=\"M 159 -36 A 16 16 0 1 1 159 -4 A 16 16 0 1 1 159 -36\" class=\"cps-stroke\" style=\"--i:3\" pathLength=\"1\"/><path d=\"M 189 -60 V -4\" class=\"cps-stroke\" style=\"--i:4\" pathLength=\"1\"/><path d=\"M 201 -36 V -16 A 12 12 0 0 0 225 -16\" class=\"cps-stroke\" style=\"--i:5\" pathLength=\"1\"/><path d=\"M 225 -36 V -4\" class=\"cps-stroke\" style=\"--i:5\" pathLength=\"1\"/><path d=\"M 253 -36 A 16 16 0 1 0 253 -4 A 16 16 0 1 0 253 -36\" class=\"cps-stroke\" style=\"--i:6\" pathLength=\"1\"/><path d=\"M 269 -36 V 4 C 269 16 263 22 251 22\" class=\"cps-stroke\" style=\"--i:6\" pathLength=\"1\"/><path d=\"M 281 -36 V -4\" class=\"cps-stroke\" style=\"--i:7\" pathLength=\"1\"/><circle cx=\"281.0\" cy=\"-54\" r=\"5.4\" stroke=\"none\" fill=\"url(#s-gw)\" class=\"cps-dot\" style=\"--i:7\"/><path d=\"M 293 -20 H 325 A 16 16 0 1 0 321 -9\" class=\"cps-stroke\" style=\"--i:8\" pathLength=\"1\"/></g></svg>";

  /* =====================================================================
   *  1. LAUNCH SPLASH
   * ===================================================================== */
  var splashEl = null;
  function startSplash(force) {
    if (splashEl) return;
    if (!force) {
      if (has(NO_SPLASH) || sess('cp_splash') || /[?&]nosplash\b/.test(location.search)) return;
    }
    addStyle('cps-css', SPLASH_CSS);
    splashEl = doc.createElement('div');
    splashEl.id = 'cp-splash';
    splashEl.setAttribute('role', 'status');
    splashEl.setAttribute('aria-label', 'Loading Camplugie');
    splashEl.innerHTML = '<div class="cps-inner">' + MARK_SVG + WORD_SVG + '<div class="cps-bar"><i></i></div></div>';
    root.appendChild(splashEl);

    var t0 = Date.now(), finished = false, el = splashEl;
    function finish() {
      if (finished) return; finished = true;
      el.classList.add('cps-out');
      if (!force) sess('cp_splash', '1');          // only counts once it has fully played
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); if (splashEl === el) splashEl = null; }, 550);
    }
    function ready() { setTimeout(finish, force ? SPLASH_MIN_MS + 600 : Math.max(0, SPLASH_MIN_MS - (Date.now() - t0))); }
    if (force || doc.readyState !== 'loading') ready(); else doc.addEventListener('DOMContentLoaded', ready);   // don't wait for slow images
    if (!force) setTimeout(finish, SPLASH_MAX_MS);
  }

  /* =====================================================================
   *  2. TOP LOADING BAR
   * ===================================================================== */
  var barEl, barTimer, barPct = 0;
  var Bar = {
    start: function () {
      if (!barEl) { barEl = doc.createElement('div'); barEl.id = 'cp-topbar'; barEl.innerHTML = '<i></i>'; root.appendChild(barEl); }
      clearInterval(barTimer); barPct = 12;
      barEl.firstChild.style.width = barPct + '%'; barEl.classList.add('on');
      barTimer = setInterval(function () { barPct += (90 - barPct) * 0.08; barEl.firstChild.style.width = barPct + '%'; }, 250);
      clearTimeout(Bar._safety); Bar._safety = setTimeout(Bar.done, 12000);
    },
    done: function () {
      if (!barEl) return; clearInterval(barTimer);
      barEl.firstChild.style.width = '100%';
      setTimeout(function () { barEl.classList.remove('on'); setTimeout(function () { barEl.firstChild.style.width = '0'; }, 300); }, 220);
    }
  };

  /* =====================================================================
   *  3. CPLoader  (use from any page)
   * ===================================================================== */
  var overlayEl, overlayCount = 0;
  var CPLoader = {
    show: function (msg) {
      overlayCount++;
      if (!overlayEl) {
        overlayEl = doc.createElement('div'); overlayEl.id = 'cp-overlay'; overlayEl.setAttribute('role', 'alert');
        overlayEl.innerHTML = '<span class="cp-spinner lg"></span><div class="msg"></div>';
        (doc.body || root).appendChild(overlayEl);
      }
      overlayEl.querySelector('.msg').textContent = msg || '';
      requestAnimationFrame(function () { overlayEl.classList.add('on'); });
    },
    hide: function () { overlayCount = Math.max(0, overlayCount - 1); if (!overlayCount && overlayEl) overlayEl.classList.remove('on'); },
    hideAll: function () { overlayCount = 0; if (overlayEl) overlayEl.classList.remove('on'); },
    wrap: function (promise, msg) {
      CPLoader.show(msg);
      return Promise.resolve(promise).then(function (v) { CPLoader.hide(); return v; }, function (e) { CPLoader.hide(); throw e; });
    },
    spinner: function (size) { return '<span class="cp-spinner" style="--s:' + (size || 28) + 'px"></span>'; },
    skeletonCards: function (n) {
      var h = ''; n = n || 4;
      while (n--) h += '<div class="cp-skel-card"><div class="cp-skel-circle"></div><div><div class="cp-skel-line"></div><div class="cp-skel-line w60"></div></div></div>';
      return h;
    },
    bar: Bar
  };
  window.CPLoader = CPLoader;

  /* toast */
  var toastEl, toastTimer;
  function toast(msg, actionLabel, action, ms) {
    if (!toastEl) { toastEl = doc.createElement('div'); toastEl.id = 'cp-toast'; (doc.body || root).appendChild(toastEl); }
    toastEl.innerHTML = '';
    var s = doc.createElement('span'); s.textContent = msg; toastEl.appendChild(s);
    if (actionLabel) { var b = doc.createElement('button'); b.textContent = actionLabel; b.onclick = function () { toastEl.classList.remove('on'); action && action(); }; toastEl.appendChild(b); }
    requestAnimationFrame(function () { toastEl.classList.add('on'); });
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 6000);
  }

  /* =====================================================================
   *  4. SERVICE WORKER
   * ===================================================================== */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    var hadController = !!navigator.serviceWorker.controller, notified = false;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('[pwa] SW registration failed', e); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }          // very first install – nothing to announce
      if (notified || has(NO_TOAST)) return; notified = true;
      toast('Camplugie was updated', 'Refresh', function () { location.reload(); }, 12000);
    });
  }

  /* =====================================================================
   *  5. INSTALL
   * ===================================================================== */
  var deferred = null, listeners = [];
  function state() {
    return { canInstall: !!deferred, standalone: isStandalone(), ios: isIOS(), android: isAndroid(),
             installed: isStandalone() || store('cp_installed') === '1', inApp: inAppBrowser() };
  }
  function notify() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch (e) {} }); }

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; notify(); scheduleBanner(); });
  window.addEventListener('appinstalled', function () {
    deferred = null; store('cp_installed', '1'); removeBanner(); notify();
    toast('Camplugie is installed 🎉');
  });
  try { if (window.matchMedia) matchMedia('(display-mode: standalone)').addEventListener('change', notify); } catch (e) {}

  function install() {
    if (!deferred) return Promise.resolve({ outcome: 'unavailable' });
    var d = deferred; deferred = null;
    d.prompt();
    return d.userChoice.then(function (r) { notify(); return r; });
  }

  var bannerEl, bannerTimer;
  function snoozed() {
    var until = +store('cp_install_snooze') || 0;
    return Date.now() < until;
  }
  function removeBanner() { if (bannerEl) { bannerEl.classList.remove('on'); var b = bannerEl; setTimeout(function () { b.parentNode && b.parentNode.removeChild(b); }, 400); bannerEl = null; } }
  function dismissBanner() {
    var n = (+store('cp_install_dismissed') || 0) + 1; store('cp_install_dismissed', String(n));
    store('cp_install_snooze', String(Date.now() + (n >= 3 ? 30 : 7) * 864e5));
    removeBanner();
  }
  var SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  function showBanner() {
    if (bannerEl || isStandalone() || store('cp_installed') === '1' || snoozed() || has(NO_PROMPT) || inAppBrowser()) return;
    var ios = isIOS();
    if (!ios && !deferred) return;
    bannerEl = doc.createElement('div'); bannerEl.id = 'cp-install'; bannerEl.setAttribute('role', 'dialog');
    bannerEl.innerHTML = '<img src="/icons/icon-96.png" alt="" width="46" height="46"><div class="t"><b>Install Camplugie</b><span>' +
      (ios ? 'Tap ' + SHARE_ICON + ' then <b style="display:inline;font-size:inherit">Add to Home Screen</b>' : 'Full-screen, faster, and one tap from your home screen.') +
      '</span></div>' + (ios ? '' : '<button class="go">Install</button>') + '<button class="x" aria-label="Close">&#10005;</button>';
    (doc.body || root).appendChild(bannerEl);
    var go = bannerEl.querySelector('.go');
    if (go) go.onclick = function () { removeBanner(); install(); };
    bannerEl.querySelector('.x').onclick = dismissBanner;
    requestAnimationFrame(function () { requestAnimationFrame(function () { bannerEl && bannerEl.classList.add('on'); }); });
  }
  function scheduleBanner() {
    if (bannerTimer || isStandalone() || has(NO_PROMPT)) return;
    if (!sess('cp_visit_counted')) { sess('cp_visit_counted', '1'); store('cp_visits', String((+store('cp_visits') || 0) + 1)); }
    var returning = (+store('cp_visits') || 0) >= 2;
    bannerTimer = setTimeout(showBanner, returning ? 8000 : 25000);
  }

  /* =====================================================================
   *  6. SHARE
   * ===================================================================== */
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (res) {
      var t = doc.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0'; doc.body.appendChild(t); t.select();
      try { doc.execCommand('copy'); } catch (e) {} doc.body.removeChild(t); res();
    });
  }
  function share(o) {
    o = o || {};
    var d = { title: o.title || 'Camplugie', text: o.text || 'Buy, sell and get things delivered on campus with Camplugie 🎓🔌', url: o.url || (location.origin + '/download.html') };
    function fallback() { window.open('https://wa.me/?text=' + encodeURIComponent(d.text + ' ' + d.url), '_blank', 'noopener'); }
    if (navigator.share) return navigator.share(d).catch(function (e) { if (!e || e.name !== 'AbortError') fallback(); });
    fallback(); return Promise.resolve();
  }

  /* =====================================================================
   *  BOOT
   * ===================================================================== */
  addStyle('cp-ui-css', UI_CSS);
  var willSplash = !(has(NO_SPLASH) || sess('cp_splash') || /[?&]nosplash\b/.test(location.search));
  if (willSplash) startSplash(); else { Bar.start(); }
  window.addEventListener('load', function () { Bar.done(); scheduleBanner(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { Bar.done(); CPLoader.hideAll(); } });

  // slim bar while jumping between pages
  doc.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    var u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.origin !== location.origin || /\.(apk|aab|zip|pdf)$/i.test(u.pathname)) return;
    if (u.pathname === location.pathname && u.search === location.search) return;
    Bar.start();
  }, true);

  window.CamplugiePWA = {
    apkUrl: APK_URL,
    install: install,
    state: state,
    onChange: function (fn) { listeners.push(fn); try { fn(state()); } catch (e) {} },
    share: share,
    copy: copy,
    toast: toast,
    showBanner: showBanner,
    playSplash: function () { startSplash(true); }
  };
})();
