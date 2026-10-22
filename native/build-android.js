/* Camplugie — native Android overlay.
 *
 * Runs in the cloud (GitHub Actions) right after `npx cap add android`. It takes the plain
 * Capacitor project and turns it into the real Camplugie app:
 *   • launcher icon, round icon, adaptive icon, splash screen and the white notification icon,
 *     all generated from the icons already in your repo (no extra image files to upload)
 *   • every Android permission the app needs (notifications, camera, microphone, location…)
 *   • Firebase notification settings (icon, colour, default channel)
 *   • the camplugie:// sign-in return link + camplugie.com web links
 *   • release signing, version number and build settings
 * Run from the native/ folder:  node build-android.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');            // repo root (icons live here)
const ANDROID = path.join(__dirname, 'android');
const RES = path.join(ANDROID, 'app/src/main/res');
const MANIFEST = path.join(ANDROID, 'app/src/main/AndroidManifest.xml');
const APP_GRADLE = path.join(ANDROID, 'app/build.gradle');
const BRAND_BG = '#0E0A1D';
const SCHEME = 'com.camplugie.app';

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
function must(cond, msg) { if (!cond) { console.error('✖ ' + msg); process.exit(1); } }
function replaceOnce(src, find, repl, label) {
  must(src.includes(find), `Could not find "${label}" in the generated project — Capacitor's template changed. Tell Claude this exact line.`);
  return src.replace(find, repl);
}

const SRC = {
  icon: path.join(ROOT, 'icons/icon-512.png'),
  maskable: path.join(ROOT, 'maskable-512.png'),
  mono: path.join(ROOT, 'monochrome-512.png'),
};
for (const [k, p] of Object.entries(SRC)) must(fs.existsSync(p), `Missing ${path.relative(ROOT, p)} in the repo (needed for the ${k} icon).`);

/* ---------------------------------------------------------------- icons */
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function makeIcons() {
  for (const [d, k] of Object.entries(DENS)) {
    const dir = path.join(RES, `mipmap-${d}`);
    const sq = Math.round(48 * k), fg = Math.round(108 * k);

    // Legacy square icon: rounded-corner version of the brand icon.
    const rounded = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sq}" height="${sq}"><rect width="${sq}" height="${sq}" rx="${Math.round(sq * 0.2)}"/></svg>`);
    await sharp(SRC.maskable).resize(sq, sq).composite([{ input: rounded, blend: 'dest-in' }]).png().toFile(path.join(dir, 'ic_launcher.png'));

    // Round icon.
    const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sq}" height="${sq}"><circle cx="${sq / 2}" cy="${sq / 2}" r="${sq / 2}"/></svg>`);
    await sharp(SRC.maskable).resize(sq, sq).composite([{ input: circle, blend: 'dest-in' }]).png().toFile(path.join(dir, 'ic_launcher_round.png'));

    // Adaptive-icon foreground: the full-bleed maskable logo (already designed with a safe zone
    // for Android's mask), so there is no visible inner square.
    await sharp(SRC.maskable).resize(fg, fg).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));

    // Small white notification icon (status bar). Alpha shape only.
    const ns = Math.round(24 * k);
    const ndir = path.join(RES, `drawable-${d}`);
    fs.mkdirSync(ndir, { recursive: true });
    await sharp(SRC.mono).resize(ns, ns).png().toFile(path.join(ndir, 'ic_stat_camplugie.png'));
  }
  write(path.join(RES, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND_BG}</color>\n</resources>\n`);

  // Splash: brand colour + centred logo (replaces Capacitor's stock splash images).
  for (const f of fs.readdirSync(RES)) {
    const p = path.join(RES, f, 'splash.png');
    if (/^drawable/.test(f) && fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.mkdirSync(path.join(RES, 'drawable'), { recursive: true });
  await sharp(SRC.icon).resize(432, 432).png().toFile(path.join(RES, 'drawable/splash_logo.png'));
  write(path.join(RES, 'drawable/splash.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/cp_splash_bg" />
    <item android:gravity="center" android:width="144dp" android:height="144dp">
        <bitmap android:src="@drawable/splash_logo" android:gravity="center" />
    </item>
</layer-list>
`);
  write(path.join(RES, 'values/cp_colors.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="cp_splash_bg">${BRAND_BG}</color>
    <color name="cp_notification_color">#7C3AED</color>
</resources>
`);
  // Dark splash on Android 12+ too.
  let styles = read(path.join(RES, 'values/styles.xml'));
  if (!styles.includes('windowSplashScreenBackground')) {
    styles = replaceOnce(styles,
      '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">',
      '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="windowSplashScreenBackground">@color/cp_splash_bg</item>\n        <item name="windowSplashScreenAnimatedIcon">@drawable/splash_logo</item>',
      'AppTheme.NoActionBarLaunch style');
    write(path.join(RES, 'values/styles.xml'), styles);
  }
}

/* ------------------------------------------------------------- manifest */
function patchManifest() {
  let m = read(MANIFEST);
  if (m.includes('com.google.firebase.messaging.default_notification_channel_id')) return;   // already patched

  m = replaceOnce(m, 'android:allowBackup="true"', 'android:allowBackup="false"\n        android:usesCleartextTraffic="false"', 'allowBackup');

  // Firebase notification defaults: small white icon, brand colour, and the channel pushes land in.
  m = replaceOnce(m, '        <provider',
`        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_camplugie" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/cp_notification_color" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="messages" />

        <provider`, '<provider');

  // Sign-in return link (com.camplugie.app://…) and camplugie.com web links.
  m = replaceOnce(m, '        </activity>',
`            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${SCHEME}" />
            </intent-filter>

            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="www.camplugie.com" />
                <data android:scheme="https" android:host="camplugie.com" />
            </intent-filter>

        </activity>`, '</activity>');

  // Permissions. NOTE: no READ_MEDIA_* / storage permission on purpose — the phone's own
  // photo/file picker lets people share files without Camplugie ever getting library access
  // (and keeps Play Store review simple).
  m = replaceOnce(m, '    <uses-permission android:name="android.permission.INTERNET" />',
`    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

    <!-- Hardware is optional so the app still installs on phones without these. -->
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />
    <uses-feature android:name="android.hardware.location" android:required="false" />
    <uses-feature android:name="android.hardware.location.gps" android:required="false" />`, 'INTERNET permission');
  write(MANIFEST, m);
}

/* --------------------------------------------------------------- gradle */
function patchGradle() {
  let g = read(APP_GRADLE);
  if (g.includes('KEYSTORE_PATH')) return;
  // NOTE: `versionCode (x).toInteger()` is read by Gradle as versionCode(<String>) and fails.
  // Integer.parseInt(...) keeps it a real number.
  g = replaceOnce(g, 'versionCode 1', 'versionCode Integer.parseInt(System.getenv("VERSION_CODE") ?: "1")', 'versionCode');
  g = replaceOnce(g, 'versionName "1.0"', 'versionName (System.getenv("VERSION_NAME") ?: "1.0")', 'versionName');
  g = replaceOnce(g, '    buildTypes {',
`    signingConfigs {
        release {
            if (System.getenv("KEYSTORE_PATH")) {
                storeFile file(System.getenv("KEYSTORE_PATH"))
                storePassword System.getenv("KEYSTORE_PASSWORD")
                keyAlias System.getenv("KEY_ALIAS")
                keyPassword System.getenv("KEY_PASSWORD")
            }
        }
    }
    lint {
        abortOnError false
        checkReleaseBuilds false
    }
    buildTypes {`, 'buildTypes');
  g = replaceOnce(g, "            minifyEnabled false",
`            if (System.getenv("KEYSTORE_PATH")) { signingConfig signingConfigs.release }
            minifyEnabled false`, 'minifyEnabled');
  write(APP_GRADLE, g);
}

/* ----------------------------------------------------- google-services */
function copyFirebaseConfig() {
  const src = path.join(__dirname, 'google-services.json');
  const dst = path.join(ANDROID, 'app/google-services.json');
  if (!fs.existsSync(src)) {
    console.warn('⚠ native/google-services.json not found — the app will build, but push notifications will NOT work until you add it.');
    return false;
  }
  const j = JSON.parse(read(src));
  const pkgs = (j.client || []).map(c => c.client_info && c.client_info.android_client_info && c.client_info.android_client_info.package_name);
  must(pkgs.includes('com.camplugie.app'), `google-services.json is for package ${pkgs.join(', ') || '(none)'} — it must be for com.camplugie.app. In Firebase, add an Android app with exactly that package name and download the file again.`);
  fs.copyFileSync(src, dst);
  console.log('✔ Firebase config installed (project: ' + (j.project_info && j.project_info.project_id) + ')');
  return true;
}

(async () => {
  must(fs.existsSync(ANDROID), 'native/android not found — run `npx cap add android` first.');
  await makeIcons(); console.log('✔ icons + splash generated');
  patchManifest(); console.log('✔ manifest: permissions, Firebase defaults, sign-in link');
  patchGradle(); console.log('✔ gradle: version + release signing');
  copyFirebaseConfig();
})().catch((e) => { console.error(e); process.exit(1); });
