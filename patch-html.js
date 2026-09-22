#!/usr/bin/env node
/**
 * Camplugie — patch-html.js
 * Adds <script src="/pwa.js"></script> to the <head> of every page in your project
 * (splash screen, loading bar, install prompt, update toast) and adds link-preview
 * tags (WhatsApp / Twitter cards) to index.html.
 *
 * Safe to run more than once — it skips files that are already patched.
 *
 *   node tools/patch-html.js            # patch everything
 *   node tools/patch-html.js --dry      # just show what WOULD change
 *
 * Run it from the ROOT of your project (the folder with home.html, sw.js, etc.).
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const SKIP = new Set(['offline.html', 'turn-test.html']);       // these must work with no JS help
const TAG = '<script src="/pwa.js"></script>';

const OG = `
<meta name="description" content="Buy, sell and get things delivered on campus, with escrow-protected payments on every deal.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Camplugie">
<meta property="og:title" content="Camplugie — Campus Marketplace">
<meta property="og:description" content="Buy, sell and get things delivered on campus, with escrow-protected payments on every deal.">
<meta property="og:url" content="https://camplugie.com/">
<meta property="og:image" content="https://camplugie.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
`;

if (!fs.existsSync(path.join(ROOT, 'home.html'))) {
  console.error('✗ Run this from your project root (the folder that contains home.html).');
  process.exit(1);
}

let patched = 0, already = 0, skipped = 0, failed = [];
for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort()) {
  if (SKIP.has(file)) { skipped++; continue; }
  const p = path.join(ROOT, file);
  let html = fs.readFileSync(p, 'utf8');
  let changed = false;

  if (!html.includes('/pwa.js')) {
    const i = html.search(/<\/head>/i);
    if (i === -1) { failed.push(file); continue; }
    html = html.slice(0, i) + TAG + '\n' + html.slice(i);
    changed = true;
  }
  if (file === 'index.html' && !/og:image/i.test(html)) {
    const i = html.search(/<\/head>/i);
    if (i !== -1) { html = html.slice(0, i) + OG.trimStart() + html.slice(i); changed = true; }
  }

  if (changed) {
    if (!DRY) fs.writeFileSync(p, html);
    console.log((DRY ? '• would patch  ' : '✓ patched  ') + file);
    patched++;
  } else { already++; }
}
console.log(`\n${DRY ? 'Dry run — ' : ''}${patched} patched, ${already} already done, ${skipped} skipped` + (failed.length ? `, ${failed.length} FAILED (no </head>): ${failed.join(', ')}` : ''));
