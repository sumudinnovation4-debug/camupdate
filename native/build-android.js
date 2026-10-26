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


/* ---------------------------------------------------- native notification buttons */
// WhatsApp-style notifications: Reply on chats, Answer / Decline on calls. This is real Android code.
// Safety valve: if the build ever fails because of it, add an empty file named DISABLE-NATIVE-ACTIONS
// inside the native/ folder on GitHub and run the build again — the app then builds without it
// (notifications still work, just without the buttons).
const JAVA = {
  CamplugieState: String.raw`package com.camplugie.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Small shared facts for the native notification code. */
final class CamplugieState {
    private CamplugieState() {}

    /** True while the Camplugie screen is open (set by CamplugiePlugin). */
    static volatile boolean foreground = false;

    static final String PREFS = "camplugie_native";
    static final String DEFAULT_API = "https://www.camplugie.com";

    static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The secret that lets THIS phone send quick replies for the signed-in user. */
    static String replyToken(Context c) {
        return prefs(c).getString("reply_token", null);
    }

    static String api(Context c) {
        String a = prefs(c).getString("api", null);
        return (a == null || a.isEmpty()) ? DEFAULT_API : a;
    }
}
`,
  CamplugiePlugin: String.raw`package com.camplugie.app;

import android.content.SharedPreferences;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge between the Camplugie website (running inside the app) and the native notification code.
 * The website calls CamplugieNative.setReplyToken(...) once after sign-in so that the
 * "Reply" button on a notification can send a message without opening the app.
 */
@CapacitorPlugin(name = "CamplugieNative")
public class CamplugiePlugin extends Plugin {

    @Override
    public void load() {
        CamplugieNotifier.ensureChannels(getContext());
    }

    @PluginMethod
    public void setReplyToken(PluginCall call) {
        String token = call.getString("token");
        String api = call.getString("api");
        if (token == null || token.length() < 32) {
            call.reject("token missing");
            return;
        }
        // Only ever talk to camplugie.com.
        if (api == null || !api.matches("https://([a-z0-9-]+\\.)?camplugie\\.com")) {
            api = CamplugieState.DEFAULT_API;
        }
        SharedPreferences.Editor e = CamplugieState.prefs(getContext()).edit();
        e.putString("reply_token", token);
        e.putString("api", api);
        e.apply();
        call.resolve();
    }

    @PluginMethod
    public void clearReplyToken(PluginCall call) {
        CamplugieState.prefs(getContext()).edit().remove("reply_token").apply();
        call.resolve();
    }

    @Override
    protected void handleOnResume() {
        CamplugieState.foreground = true;
    }

    @Override
    protected void handleOnPause() {
        CamplugieState.foreground = false;
    }
}
`,
  CamplugieMessagingService: String.raw`package com.camplugie.app;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Receives Firebase messages. Messages Camplugie marks as "cp=1" (chats and calls) arrive as plain
 * data so we can build the notification ourselves — with Reply / Answer / Decline buttons — even if
 * the app is closed. Everything else behaves exactly as before.
 */
public class CamplugieMessagingService extends FirebaseMessagingService {

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        PushNotificationsPlugin.onNewToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        boolean ours = data != null && "1".equals(data.get("cp"));
        if (ours && !CamplugieState.foreground) {
            CamplugieNotifier.show(getApplicationContext(), data);
            return;
        }
        // App is open (JS shows its own banner) or an ordinary notification message.
        PushNotificationsPlugin.sendRemoteMessage(message);
    }
}
`,
  CamplugieNotifier: String.raw`package com.camplugie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.util.Map;

/** Builds the WhatsApp-style notifications (Reply on chats, Answer / Decline on calls). */
final class CamplugieNotifier {
    private CamplugieNotifier() {}

    static final String CH_MESSAGES = "cp_messages";
    static final String CH_CALLS = "cp_calls";
    static final String KEY_REPLY = "cp_reply_text";

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Chats and group chats");
        messages.enableVibration(true);
        messages.enableLights(true);
        messages.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(messages);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Calls & lectures", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Incoming calls and lectures");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] {0, 600, 300, 600, 300, 600});
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        AudioAttributes ring = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        calls.setSound(Settings.System.DEFAULT_RINGTONE_URI, ring);
        nm.createNotificationChannel(calls);
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String absolute(Context ctx, String url) {
        String u = nz(url);
        if (u.startsWith("http://") || u.startsWith("https://")) return u;
        return CamplugieState.api(ctx) + (u.startsWith("/") ? u : "/" + u);
    }

    /** Opens the app on the given url (a chat, group, call). */
    static PendingIntent open(Context ctx, String url, int requestCode) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(absolute(ctx, url)));
        i.setClass(ctx, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void show(Context ctx, Map<String, String> d) {
        String type = nz(d.get("type"));
        String title = nz(d.get("title"));
        String body = nz(d.get("body"));
        String url = nz(d.get("url"));
        String tag = nz(d.get("tag"));
        boolean isCall = type.equals("call") || type.equals("group_call");
        boolean isChat = type.equals("message") || type.equals("group_message") || type.equals("mention");

        int id = (tag.isEmpty() ? (type + title + body) : tag).hashCode();   // same tag = replaces the old one
        ensureChannels(ctx);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(ctx, isCall ? CH_CALLS : CH_MESSAGES)
                : new Notification.Builder(ctx);
        int smallIcon = ctx.getResources().getIdentifier("ic_stat_camplugie", "drawable", ctx.getPackageName());
        b.setSmallIcon(smallIcon != 0 ? smallIcon : ctx.getApplicationInfo().icon);
        b.setColor(0xFF7C3AED);
        b.setContentTitle(title);
        b.setContentText(body);
        b.setStyle(new Notification.BigTextStyle().bigText(body));
        b.setAutoCancel(true);
        b.setShowWhen(true);
        b.setWhen(System.currentTimeMillis());
        b.setVisibility(Notification.VISIBILITY_PUBLIC);
        b.setCategory(isCall ? Notification.CATEGORY_CALL : Notification.CATEGORY_MESSAGE);
        b.setContentIntent(open(ctx, url, id));
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_ALL);
        }

        if (isCall) {
            if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(45000);   // a call that rang 45 s ago is a missed call
            Notification.Action answer = new Notification.Action.Builder(
                    Icon.createWithResource(ctx, android.R.drawable.sym_action_call), "Answer", open(ctx, url, id + 1)).build();
            b.addAction(answer);
            String callChannel = nz(d.get("call_channel"));
            if (type.equals("call") && !callChannel.isEmpty()) {
                Intent decline = new Intent(ctx, NotificationActionReceiver.class);
                decline.setAction(NotificationActionReceiver.ACTION_DECLINE);
                decline.putExtra("notif_id", id);
                decline.putExtra("call_channel", callChannel);
                PendingIntent pd = PendingIntent.getBroadcast(ctx, id + 2, decline, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                b.addAction(new Notification.Action.Builder(
                        Icon.createWithResource(ctx, android.R.drawable.ic_menu_close_clear_cancel), "Decline", pd).build());
            }
        } else if (isChat && CamplugieState.replyToken(ctx) != null
                && (!nz(d.get("conv_id")).isEmpty() || !nz(d.get("group_id")).isEmpty())) {
            Intent reply = new Intent(ctx, NotificationActionReceiver.class);
            reply.setAction(NotificationActionReceiver.ACTION_REPLY);
            reply.putExtra("notif_id", id);
            reply.putExtra("conv_id", nz(d.get("conv_id")));
            reply.putExtra("group_id", nz(d.get("group_id")));
            // The reply text is written INTO this intent by Android, so it must be mutable on Android 12+.
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pr = PendingIntent.getBroadcast(ctx, id + 3, reply, flags);
            RemoteInput input = new RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build();
            Notification.Action act = new Notification.Action.Builder(
                    Icon.createWithResource(ctx, android.R.drawable.ic_menu_send), "Reply", pr)
                    .addRemoteInput(input)
                    .build();
            b.addAction(act);
        }

        Notification n = b.build();
        if (isCall) n.flags |= Notification.FLAG_INSISTENT;   // keep ringing until answered / declined / timed out
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(id, n);
    }
}
`,
  NotificationActionReceiver: String.raw`package com.camplugie.app;

import android.app.NotificationManager;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/** Handles the buttons on notifications: Reply (sends a message) and Decline (rejects a call). */
public class NotificationActionReceiver extends BroadcastReceiver {
    static final String ACTION_REPLY = "com.camplugie.app.ACTION_REPLY";
    static final String ACTION_DECLINE = "com.camplugie.app.ACTION_DECLINE";

    @Override
    public void onReceive(final Context ctx, final Intent intent) {
        final String action = intent.getAction();
        final int id = intent.getIntExtra("notif_id", 0);
        final NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        final PendingResult pending = goAsync();

        if (ACTION_DECLINE.equals(action)) {
            if (nm != null) nm.cancel(id);
            final String channel = intent.getStringExtra("call_channel");
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        JSONObject body = new JSONObject();
                        body.put("call_channel", channel);
                        post(ctx, "/api/call-decline", body);
                    } catch (Exception ignored) {
                    } finally {
                        pending.finish();
                    }
                }
            }).start();
            return;
        }

        if (ACTION_REPLY.equals(action)) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence typed = results == null ? null : results.getCharSequence(CamplugieNotifier.KEY_REPLY);
            final String text = typed == null ? "" : typed.toString().trim();
            if (text.isEmpty()) {
                if (nm != null) nm.cancel(id);
                pending.finish();
                return;
            }
            final String conv = intent.getStringExtra("conv_id");
            final String group = intent.getStringExtra("group_id");
            new Thread(new Runnable() {
                @Override public void run() {
                    boolean ok = false;
                    try {
                        JSONObject body = new JSONObject();
                        body.put("text", text);
                        if (conv != null && !conv.isEmpty()) body.put("conversation_id", conv);
                        if (group != null && !group.isEmpty()) body.put("group_id", group);
                        ok = post(ctx, "/api/quick-reply", body);
                    } catch (Exception ignored) {
                    }
                    // Android keeps a spinner on the notification until it is updated or removed.
                    if (nm != null) nm.cancel(id);
                    final String msg = ok ? "Reply sent" : "Couldn't send your reply — open Camplugie to try again";
                    new Handler(Looper.getMainLooper()).post(new Runnable() {
                        @Override public void run() { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show(); }
                    });
                    pending.finish();
                }
            }).start();
            return;
        }
        pending.finish();
    }

    /** POSTs JSON to camplugie.com with this phone's reply token. Returns true on a 2xx answer. */
    static boolean post(Context ctx, String path, JSONObject body) throws Exception {
        String token = CamplugieState.replyToken(ctx);
        if (token == null) return false;
        body.put("reply_token", token);
        HttpURLConnection c = (HttpURLConnection) new URL(CamplugieState.api(ctx) + path).openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.toString().getBytes("UTF-8");
            OutputStream out = c.getOutputStream();
            out.write(bytes);
            out.close();
            int code = c.getResponseCode();
            return code >= 200 && code < 300;
        } finally {
            c.disconnect();
        }
    }
}
`,
  MainActivity: String.raw`package com.camplugie.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CamplugiePlugin.class);   // must come before super.onCreate
        super.onCreate(savedInstanceState);
    }
}
`,
};

function nativeActions() {
  if (fs.existsSync(path.join(__dirname, 'DISABLE-NATIVE-ACTIONS'))) {
    console.log('• native notification buttons skipped (DISABLE-NATIVE-ACTIONS file found)');
    return;
  }
  const javaDir = path.join(ANDROID, 'app/src/main/java/com/camplugie/app');
  for (const [name, code] of Object.entries(JAVA)) write(path.join(javaDir, name + '.java'), code);

  // Manifest: our message service (wins over the stock one), the button receiver.
  let m = read(MANIFEST);
  if (!m.includes('CamplugieMessagingService')) {
    m = replaceOnce(m, '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"', '<manifest tag');
    m = replaceOnce(m, '        <provider',
`        <service android:name=".CamplugieMessagingService" android:exported="false">
            <intent-filter android:priority="100">
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
        <service android:name="com.capacitorjs.plugins.pushnotifications.MessagingService" tools:node="remove" />
        <receiver android:name=".NotificationActionReceiver" android:exported="false" />

        <provider`, '<provider');
    write(MANIFEST, m);
  }
  // Gradle: the app itself now uses Firebase classes directly.
  let g = read(APP_GRADLE);
  if (!g.includes('firebase-messaging')) {
    g = replaceOnce(g, "    implementation project(':capacitor-android')",
      "    implementation project(':capacitor-android')\n    implementation \"com.google.firebase:firebase-messaging:25.0.1\"", 'capacitor-android dependency');
    write(APP_GRADLE, g);
  }
  console.log('✔ native notification buttons added (Reply / Answer / Decline)');
}

(async () => {
  must(fs.existsSync(ANDROID), 'native/android not found — run `npx cap add android` first.');
  await makeIcons(); console.log('✔ icons + splash generated');
  patchManifest(); console.log('✔ manifest: permissions, Firebase defaults, sign-in link');
  patchGradle(); console.log('✔ gradle: version + release signing');
  nativeActions();
  copyFirebaseConfig();
})().catch((e) => { console.error(e); process.exit(1); });
