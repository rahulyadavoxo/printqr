package com.receipto.print;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.os.BundleCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.CustomCredential;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.android.gms.auth.api.phone.SmsRetriever;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Status;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.razorpay.Checkout;
import com.razorpay.PaymentData;
import com.razorpay.PaymentResultWithDataListener;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * PrintQR Android app. The whole web app is bundled inside the APK (assets/www, built by
 * .github/workflows/apps.yml) and served from https://appassets.androidplatform.net, so nothing is
 * loaded from print.receipto.in. Data still comes from Supabase. Payments use Razorpay's native SDK.
 * Adds what a plain WebView lacks: file picking, downloads, printing, and UPI / external links.
 */
public class MainActivity extends Activity implements PaymentResultWithDataListener {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + APP_HOST + "/#/dashboard";
    private static final int PICK_FILES = 1001;

    private FrameLayout root;
    private WebView web;
    /** Pop-up window opened by Razorpay (card 3-D Secure, net banking, wallets). */
    private WebView popup;
    private ValueCallback<Uri[]> pendingFiles;

    // Runs after every page load: routes print, popups and blob downloads to the app.
    private static final String BRIDGE_JS =
        "(function(){if(window.__pq)return;window.__pq=1;" +
        "window.print=function(){PQ.print(document.title||'PrintQR')};" +
        "var openOrig=window.open;" +
        "window.open=function(u){if(!u||u==='about:blank'){return{close:function(){},location:{set href(v){PQ.openExternal(String(v))},get href(){return ''}}}}" +
        "var a=document.createElement('a');a.href=u;if(a.host===location.host){location.href=a.href;return window}PQ.openExternal(a.href);return null};" +
        "function save(a){var h=a.href,n=a.getAttribute('download')||'file';" +
        "fetch(h).then(function(r){return r.blob()}).then(function(b){var fr=new FileReader();" +
        "fr.onload=function(){var s=String(fr.result);PQ.saveFile(s.substring(s.indexOf(',')+1),n,b.type||'application/octet-stream')};fr.readAsDataURL(b)})" +
        ".catch(function(){PQ.toast(localStorage.getItem('printqr-lang')==='hi'?'\u0921\u093e\u0909\u0928\u0932\u094b\u0921 \u0928\u0939\u0940\u0902 \u0939\u0941\u0906':'Download failed')})}" +
        "var clickOrig=HTMLAnchorElement.prototype.click;" +
        "HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')&&/^(blob|data):/.test(this.href)){save(this);return}return clickOrig.call(this)};" +
        "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[download]');" +
        "if(a&&/^(blob|data):/.test(a.href)){e.preventDefault();e.stopPropagation();save(a)}},true);" +
        "})();";

    /** Strip behind the status bar; its colour follows the page's top bar (setStatusColor). */
    private View statusBg;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(0xFFFAF9F6);
        w.setNavigationBarColor(0xFFFAF9F6);
        // Android 15+ draws edge-to-edge: dark icons on the light bar, and keep content clear of the bars.
        WindowCompat.setDecorFitsSystemWindows(w, false);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(w, w.getDecorView());
        bars.setAppearanceLightStatusBars(true);
        bars.setAppearanceLightNavigationBars(true);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFFAF9F6);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            // Top inset gets its own strip (statusBg) so the page can colour the status bar to match its top bar.
            v.setPadding(sys.left, 0, sys.right, Math.max(sys.bottom, ime.bottom));
            FrameLayout.LayoutParams wl = (FrameLayout.LayoutParams) web.getLayoutParams();
            if (wl.topMargin != sys.top) { wl.topMargin = sys.top; web.setLayoutParams(wl); }
            FrameLayout.LayoutParams sl = (FrameLayout.LayoutParams) statusBg.getLayoutParams();
            if (sl.height != sys.top) { sl.height = sys.top; statusBg.setLayoutParams(sl); }
            return WindowInsetsCompat.CONSUMED;
        });
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // No raw system autofill dialog ("Use your saved password for appassets..."); the app asks Google Password Manager itself (PQ.getPassword).
        if (android.os.Build.VERSION.SDK_INT >= 26) web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        statusBg = new View(this);
        statusBg.setBackgroundColor(0xFFFAF9F6);
        root.addView(statusBg, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, android.view.Gravity.TOP));
        setContentView(root);
        PushService.ensureChannel(this);
        PushService.active = this;

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // No pinch / double-tap zoom, and ignore the phone's font-size setting so the layout never blows up
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true); // Razorpay opens bank / 3-D Secure pages in a pop-up
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " PrintQRApp/Android");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "PQ");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Cloudflare Turnstile (bot check) runs in its own frame: let that frame load in place.
                if (!req.isForMainFrame() && "challenges.cloudflare.com".equals(req.getUrl().getHost())) return false;
                // UPI pay button on the order status page (item 16): hand the upi:// link to a UPI app.
                if ("upi".equalsIgnoreCase(req.getUrl().getScheme())) return openUpi(req.getUrl(), false);
                return handleUrl(req.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serveAsset(req.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                trackPage(url);
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                trackPage(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                trackPage(url);
                if (trustedPage) view.evaluateJavascript(BRIDGE_JS, null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = cb;
                try {
                    Intent i = params.createIntent();
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(Intent.createChooser(i, "Choose file"), PICK_FILES);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                openPopup(resultMsg);
                return true;
            }

            @Override
            public void onCloseWindow(WebView window) {
                closePopup();
            }

            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (progress > 60 && trustedPage) view.evaluateJavascript(BRIDGE_JS, null);
            }
        });
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            if (url.startsWith("http")) openExternal(url);
        });

        Checkout.preload(getApplicationContext());

        String deep = orderLink(getIntent());
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
            if (deep != null) web.loadUrl(deep);
        } else {
            web.loadUrl(deep != null ? deep : START);
        }
    }

    /** v18: "order ready" notification tapped -> that order's status page (inside the app). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String deep = orderLink(intent);
        if (deep != null && web != null) {
            closePopup();
            web.loadUrl(deep);
        } else if (web != null && intent != null && intent.hasExtra("order_id") && popup == null) {
            // Owner's new-order notification: open the dashboard, as before singleTop (it used to recreate the screen).
            intent.removeExtra("order_id");
            web.loadUrl(START);
        }
    }

    /** App URL for the "path" extra of a ready notification (FCM puts data keys in the extras), else null. Used once. */
    private String orderLink(Intent intent) {
        if (intent == null) return null;
        try {
            String kind = intent.getStringExtra("kind");
            String path = intent.getStringExtra("path");
            if (!"ready".equals(kind) || !PushService.validOrderPath(path)) return null;
            intent.removeExtra("kind");
            intent.removeExtra("path");
            return "https://" + APP_HOST + "/#" + path;
        } catch (Exception e) {
            return null;
        }
    }

    /** Serves the bundled web app (assets/www) for https://appassets.androidplatform.net/... */
    private WebResourceResponse serveAsset(Uri uri) {
        if (!APP_HOST.equals(uri.getHost())) return null;
        String path = uri.getPath() == null ? "/" : uri.getPath();
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        String file = "www" + path;
        try {
            InputStream in = getAssets().open(file);
            WebResourceResponse r = new WebResourceResponse(mimeFor(file), mimeFor(file).startsWith("text/") || mimeFor(file).endsWith("javascript") ? "utf-8" : null, in);
            java.util.Map<String, String> h = new java.util.HashMap<>();
            h.put("Cache-Control", file.endsWith("index.html") ? "no-cache" : "max-age=31536000");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            // Unknown file: answer 404 instead of trying the network (this host does not exist online).
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mimeFor(String f) {
        String n = f.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".json") || n.endsWith(".webmanifest")) return "application/json";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    // ---------------- In-app update (same system as Dairy Diary) ----------------
    // The newest GitHub release (tag app-vX.Y.Z) carries PrintQR-X.Y.Z.apk. The web code asks
    // checkUpdate(), downloadUpdate(version), installUpdate(); answers arrive via window.__pqUpd.
    private static final String REPO_PAGE = "https://github.com/rahulyadavoxo/printqr";
    private static final String UPD_FILE = "pq-update.apk";
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int CONNECT_TRIES = 4;
    private static final long MIN_APK_BYTES = 1024L * 1024L;
    private volatile boolean updBusy = false;

    private File updFile() {
        File dir = new File(getCacheDir(), "updates");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, UPD_FILE);
    }

    private void updEvent(String json) {
        js("window.__pqUpd&&window.__pqUpd(" + json + ")");
    }

    @SuppressWarnings("deprecation")
    private long installedVersionCode() throws PackageManager.NameNotFoundException {
        PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    private static Set<String> certs(PackageInfo pi) {
        try {
            if (pi == null || Build.VERSION.SDK_INT < 28) return null;
            SigningInfo si = pi.signingInfo;
            if (si == null) return null;
            Signature[] sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
            if (sigs == null || sigs.length == 0) return null;
            Set<String> out = new HashSet<>();
            for (Signature g : sigs) out.add(Arrays.toString(g.toByteArray()));
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    /** Only GitHub may serve the update (also after redirects). */
    private static boolean allowedUrl(String u, boolean first) {
        try {
            URL url = new URL(u);
            if (!"https".equals(url.getProtocol())) return false;
            String host = url.getHost().toLowerCase(Locale.ROOT);
            String path = url.getPath();
            if (path.contains("..") || path.toLowerCase(Locale.ROOT).contains("%2e")) return false;
            if (first) return host.equals("github.com") && path.startsWith("/rahulyadavoxo/printqr/releases/download/");
            return host.equals("github.com") || host.endsWith(".githubusercontent.com");
        } catch (Exception e) {
            return false;
        }
    }

    /** null when the file is a newer build of this same app with the same signing key. */
    @SuppressWarnings("deprecation")
    private String checkApk(File f) {
        try {
            PackageManager pm = getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : 0;
            PackageInfo pi = pm.getPackageArchiveInfo(f.getAbsolutePath(), flags);
            if (pi == null) return "NOT_APK";
            if (!getPackageName().equals(pi.packageName)) return "WRONG_APP";
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            if (code <= installedVersionCode()) return "NOT_NEWER";
            Set<String> mine = certs(pm.getPackageInfo(getPackageName(), flags));
            Set<String> theirs = certs(pi);
            if (mine != null && theirs != null && java.util.Collections.disjoint(mine, theirs)) return "WRONG_SIGNER";
            return null;
        } catch (Exception e) {
            return "NOT_APK";
        }
    }

    private static String[] head(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        try {
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(10000);
            c.setRequestMethod("HEAD");
            c.setRequestProperty("User-Agent", "PrintQR-Updater");
            return new String[] { String.valueOf(c.getResponseCode()), c.getHeaderField("Location") };
        } finally {
            c.disconnect();
        }
    }

    private static String apkUrl(String version) {
        return REPO_PAGE + "/releases/download/app-v" + version + "/PrintQR-" + version + ".apk";
    }

    /** github.com/.../releases/latest redirects to .../releases/tag/app-vX.Y.Z (no API rate limit). */
    private void checkUpdateAsync() {
        new Thread(() -> {
            try {
                String[] r = head(REPO_PAGE + "/releases/latest");
                String loc = r[1];
                String tag = loc != null && loc.contains("/releases/tag/") ? loc.substring(loc.lastIndexOf('/') + 1) : null;
                if (tag == null || !tag.matches("app-v\\d+\\.\\d+\\.\\d+")) {
                    updEvent("{\"type\":\"check\",\"error\":\"NO_TAG\"}");
                    return;
                }
                String version = tag.substring(5);
                int code = Integer.parseInt(head(apkUrl(version))[0]);
                boolean apk = code >= 200 && code < 400; // the APK is uploaded a little after the release
                updEvent("{\"type\":\"check\",\"version\":" + JSONObject.quote(version) + ",\"apk\":" + apk + "}");
            } catch (Exception e) {
                updEvent("{\"type\":\"check\",\"error\":\"OFFLINE\"}");
            }
        }).start();
    }

    private void downloadUpdateAsync(String version) {
        if (version == null || !version.matches("\\d+\\.\\d+\\.\\d+") || !allowedUrl(apkUrl(version), true)) {
            updEvent("{\"type\":\"error\",\"code\":\"BAD_URL\"}");
            return;
        }
        if (updBusy) return;
        updBusy = true;
        new Thread(() -> {
            File out = updFile();
            File part = new File(out.getParentFile(), UPD_FILE + ".part");
            HttpURLConnection con = null;
            try {
                String next = apkUrl(version);
                int hops = 0, tries = 0;
                while (true) {
                    con = (HttpURLConnection) new URL(next).openConnection();
                    con.setInstanceFollowRedirects(false);
                    con.setConnectTimeout(CONNECT_TIMEOUT_MS);
                    con.setReadTimeout(30000);
                    con.setRequestProperty("User-Agent", "PrintQR-Updater");
                    int st;
                    try {
                        st = con.getResponseCode();
                    } catch (java.io.IOException ce) {
                        con.disconnect();
                        if (++tries >= CONNECT_TRIES) throw ce;
                        continue;
                    }
                    if (st >= 300 && st < 400) {
                        String loc = con.getHeaderField("Location");
                        con.disconnect();
                        if (loc == null || ++hops > 5) throw new Exception("redirect");
                        next = new URL(new URL(next), loc).toString();
                        if (!allowedUrl(next, false)) throw new Exception("redirect host");
                        continue;
                    }
                    if (st != 200) throw new Exception("HTTP " + st);
                    break;
                }
                long total = con.getContentLengthLong();
                long done = 0;
                int lastPct = -1;
                try (InputStream in = con.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        os.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                updEvent("{\"type\":\"progress\",\"percent\":" + pct + "}");
                            }
                        }
                    }
                }
                if (total > 0 && done != total) throw new Exception("incomplete");
                if (total <= 0 && done < MIN_APK_BYTES) throw new Exception("incomplete");
                if (out.exists()) out.delete();
                if (!part.renameTo(out)) throw new Exception("rename failed");
                String bad = checkApk(out);
                if (bad != null) {
                    out.delete();
                    updEvent("{\"type\":\"error\",\"code\":\"" + bad + "\"}");
                    return;
                }
                updEvent("{\"type\":\"downloaded\"}");
            } catch (Exception e) {
                part.delete();
                updEvent("{\"type\":\"error\",\"code\":\"DOWNLOAD_FAILED\"}");
            } finally {
                if (con != null) con.disconnect();
                updBusy = false;
            }
        }).start();
    }

    /** "started", "perm" (opened the allow-installs setting) or "error:CODE". */
    private String installUpdateNow() {
        File f = updFile();
        if (!f.exists()) return "error:NO_FILE";
        String bad = checkApk(f);
        if (bad != null) {
            f.delete();
            return "error:" + bad;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                return "perm";
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(i);
            return "started";
        } catch (ActivityNotFoundException e) {
            return "error:NO_INSTALLER";
        } catch (Exception e) {
            return "error:INSTALL_FAILED";
        }
    }

    // ---------------- SMS OTP auto-read (Google SMS Retriever API) ----------------
    // The login page calls PQ.startSmsRetriever() just before it asks Supabase for the SMS code. Play services
    // then hands us the next SMS (within 5 minutes) that contains this app's 11-character hash
    // (send-sms adds it from the SMS_APP_HASH secret). No SMS permission, no tap. The code goes to the page as
    // window event 'printqr-otp' {code, error}. The receiver is removed after one message, on timeout, or on destroy.
    /** Play services gives up after 5 minutes (and broadcasts TIMEOUT); this is only a safety net. */
    private static final long SMS_WAIT_MS = 5 * 60 * 1000L + 30 * 1000L;
    private static final Pattern OTP_6 = Pattern.compile("(?<!\\d)\\d{6}(?!\\d)");
    private static final Pattern OTP_ANY = Pattern.compile("(?<!\\d)\\d{4,10}(?!\\d)");
    private final Handler smsHandler = new Handler(Looper.getMainLooper());
    /** Registered receiver while waiting for the SMS, else null. Main thread only. */
    private BroadcastReceiver smsReceiver;
    private final Runnable smsTimeout = () -> {
        if (smsReceiver == null) return;
        endSmsWait();
        otpEvent("", "timeout");
    };

    /** Main thread. Starts (or restarts) the wait for one OTP SMS. */
    private void startSmsWait() {
        endSmsWait();
        final BroadcastReceiver r = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                if (smsReceiver != this || intent == null || !SmsRetriever.SMS_RETRIEVED_ACTION.equals(intent.getAction())) return;
                Bundle x = intent.getExtras();
                Status st = x == null ? null : smsStatus(x);
                int code = st == null ? CommonStatusCodes.ERROR : st.getStatusCode();
                endSmsWait();
                if (code == CommonStatusCodes.SUCCESS) {
                    String otp = otpFrom(x.getString(SmsRetriever.EXTRA_SMS_MESSAGE));
                    otpEvent(otp, otp.isEmpty() ? "no_code" : "");
                } else {
                    otpEvent("", code == CommonStatusCodes.TIMEOUT ? "timeout" : "error");
                }
            }
        };
        IntentFilter f = new IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION);
        try {
            // Only Play services (holder of SEND_PERMISSION) may deliver this broadcast. Android 13+ needs the
            // exported flag spelled out for a receiver that hears another app (Android 14+ throws without it);
            // ContextCompat passes RECEIVER_EXPORTED on 33+ and uses the plain permission overload below that.
            androidx.core.content.ContextCompat.registerReceiver(this, r, f, SmsRetriever.SEND_PERMISSION, null,
                androidx.core.content.ContextCompat.RECEIVER_EXPORTED);
        } catch (Exception e) {
            otpEvent("", "register");
            return;
        }
        smsReceiver = r;
        smsHandler.postDelayed(smsTimeout, SMS_WAIT_MS);
        try {
            SmsRetriever.getClient(this).startSmsRetriever().addOnFailureListener(e -> {
                // No / old Play services, API not available: stop listening; the user types the code.
                if (smsReceiver != r) return;
                endSmsWait();
                otpEvent("", "start");
            });
        } catch (Throwable t) {
            endSmsWait();
            otpEvent("", "start");
        }
    }

    /** Main thread. Stops waiting (safe to call any time). */
    private void endSmsWait() {
        smsHandler.removeCallbacks(smsTimeout);
        BroadcastReceiver r = smsReceiver;
        smsReceiver = null;
        if (r != null) {
            try { unregisterReceiver(r); } catch (Exception ignored) { }
        }
    }

    @SuppressWarnings("deprecation")
    private static Status smsStatus(Bundle x) {
        try {
            x.setClassLoader(Status.class.getClassLoader());
            Object o = Build.VERSION.SDK_INT >= 33
                ? BundleCompat.getParcelable(x, SmsRetriever.EXTRA_STATUS, Status.class)
                : x.get(SmsRetriever.EXTRA_STATUS);
            return o instanceof Status ? (Status) o : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** First 6-digit number in the SMS (the code comes before the app hash), else any 4-10 digit number. */
    static String otpFrom(String sms) {
        if (sms == null) return "";
        Matcher m = OTP_6.matcher(sms);
        if (m.find()) return m.group();
        m = OTP_ANY.matcher(sms);
        return m.find() ? m.group() : "";
    }

    /** Hands the code (or why there is none) to the login page. The SMS text itself never leaves this method. */
    private void otpEvent(String code, String error) {
        if (!trustedPage) return;
        js("window.dispatchEvent(new CustomEvent('printqr-otp',{detail:{code:" + JSONObject.quote(code)
            + ",error:" + JSONObject.quote(error) + "}}))");
    }

    /** Runs JavaScript in the app page (used to hand Razorpay's result back to the web code). */
    private void js(String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    @Override
    public void onPaymentSuccess(String paymentId, PaymentData data) {
        try {
            JSONObject r = data != null && data.getData() != null ? data.getData() : new JSONObject();
            if (!r.has("razorpay_payment_id")) r.put("razorpay_payment_id", paymentId);
            if (data != null && data.getSignature() != null && !r.has("razorpay_signature")) r.put("razorpay_signature", data.getSignature());
            js("window.__pqRzpDone&&window.__pqRzpDone(" + r.toString() + ")");
        } catch (Exception e) {
            js("window.__pqRzpFail&&window.__pqRzpFail(false," + JSONObject.quote(String.valueOf(e.getMessage())) + ")");
        }
    }

    @Override
    public void onPaymentError(int code, String response, PaymentData data) {
        boolean cancelled = code == Checkout.PAYMENT_CANCELED;
        String msg = "Payment failed";
        try {
            JSONObject err = new JSONObject(response).optJSONObject("error");
            if (err != null && err.optString("description", "").length() > 0) msg = err.optString("description");
        } catch (Exception ignored) { }
        js("window.__pqRzpFail&&window.__pqRzpFail(" + cancelled + "," + JSONObject.quote(msg) + ")");
    }

    /** Shows a Razorpay pop-up (bank page, OTP, wallet) on top of the app, the way a browser tab would. */
    @SuppressLint("SetJavaScriptEnabled")
    private void openPopup(Message resultMsg) {
        closePopup();
        WebView p = new WebView(this);
        WebSettings ps = p.getSettings();
        ps.setJavaScriptEnabled(true);
        ps.setDomStorageEnabled(true);
        ps.setJavaScriptCanOpenWindowsAutomatically(true);
        ps.setSupportMultipleWindows(false);
        ps.setTextZoom(100);
        ps.setUserAgentString(web.getSettings().getUserAgentString());
        CookieManager.getInstance().setAcceptThirdPartyCookies(p, true);
        p.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String sc = u.getScheme() == null ? "" : u.getScheme();
                if (sc.equals("http") || sc.equals("https")) return false; // bank pages stay in the pop-up
                return handleUrl(u); // upi://, intent:// etc. open the UPI app
            }
        });
        p.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onCloseWindow(WebView window) {
                closePopup();
            }
        });
        root.addView(p, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        popup = p;
        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(p);
        resultMsg.sendToTarget();
    }

    private void closePopup() {
        if (popup == null) return;
        WebView p = popup;
        popup = null;
        root.removeView(p);
        p.stopLoading();
        p.destroy();
    }

    /** Keep our own site, Supabase auth and Razorpay inside the app; send the rest out. */
    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        String host = uri.getHost() == null ? "" : uri.getHost();
        if (scheme.equals("http") || scheme.equals("https")) {
            if (host.equals(APP_HOST) || isHost(host, "razorpay.com")) return false;
            String path = uri.getPath() == null ? "" : uri.getPath();
            if (isHost(host, "supabase.co") && !path.contains("/storage/")) return false;
            openExternal(uri.toString());
            return true;
        }
        // Razorpay pop-up (plan payment): same UPI hand-off, but the fallback there is a card.
        if (scheme.equalsIgnoreCase("upi")) return openUpi(uri, true);
        Intent i = null;
        try {
            i = scheme.equals("intent")
                ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                : new Intent(Intent.ACTION_VIEW, uri);
            if (scheme.equals("intent")) {
                // A web page must not reach our own or any non-exported screen, or pass file permissions.
                if (getPackageName().equals(i.getPackage())) return true;
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
                i.removeFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                Uri data = i.getData();
                String ds = data == null || data.getScheme() == null ? "" : data.getScheme().toLowerCase(Locale.ROOT);
                if (ds.equals("file") || ds.equals("content") || ds.equals("javascript")) return true;
            }
            startActivity(i);
        } catch (Exception e) {
            String fallback = i == null ? null : i.getStringExtra("browser_fallback_url");
            if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) openExternal(fallback);
            else Toast.makeText(this, scheme.equals("upi") || uri.toString().contains("upi")
                ? (PushService.hi(this) ? "कोई UPI ऐप नहीं मिला। Google Pay, PhonePe या Paytm इंस्टॉल करें, या कार्ड से भुगतान करें।" : "No UPI app found. Install Google Pay, PhonePe or Paytm, or pay by card.")
                : (PushService.hi(this) ? "इसे खोलने के लिए कोई ऐप नहीं मिला" : "No app found to open this"), Toast.LENGTH_LONG).show();
        }
        return true;
    }

    /**
     * upi://pay links open in a UPI app with ACTION_VIEW (Google Pay, PhonePe, Paytm, BHIM...). If no app can take it,
     * a Toast says so instead of the WebView showing an error page. Always returns true (the WebView never loads it).
     */
    private boolean openUpi(Uri uri, boolean cardFallback) {
        Intent i = new Intent(Intent.ACTION_VIEW, uri);
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            if (i.resolveActivity(getPackageManager()) == null) throw new ActivityNotFoundException();
            startActivity(i);
        } catch (Exception e) {
            boolean hi = PushService.hi(this);
            String msg = cardFallback
                ? (hi ? "कोई UPI ऐप नहीं मिला। Google Pay, PhonePe या Paytm इंस्टॉल करें, या कार्ड से भुगतान करें।" : "No UPI app found. Install Google Pay, PhonePe or Paytm, or pay by card.")
                : (hi ? "कोई UPI ऐप नहीं मिला। Google Pay, PhonePe या Paytm इंस्टॉल करें, या काउंटर पर पेमेंट करें।" : "No UPI app found. Install Google Pay, PhonePe or Paytm, or pay at the counter.");
            Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
        }
        return true;
    }

    /** True for the domain itself or a real subdomain of it (evilrazorpay.com does not match razorpay.com). */
    private static boolean isHost(String host, String domain) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        return h.equals(domain) || h.endsWith("." + domain);
    }

    /** Only the bundled app's own pages may use the PQ bridge (not ads, payment pages or other sites). */
    private volatile boolean trustedPage = true;

    private void trackPage(String url) {
        PushService.currentUrl = url == null ? "" : url;
        Uri u = url == null ? null : Uri.parse(url);
        trustedPage = u != null && "https".equals(u.getScheme()) && APP_HOST.equals(u.getHost());
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("upi") && !scheme.equals("mailto") && !scheme.equals("tel")) return;
        String host = u.getHost() == null ? "" : u.getHost();
        if (isHost(host, "supabase.co") && u.getPath() != null && u.getPath().contains("/storage/")) {
            downloadToPhone(u);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, PushService.hi(this) ? "यह फ़ाइल खोलने के लिए कोई ऐप नहीं मिला" : "No app found to open this file", Toast.LENGTH_SHORT).show();
        }
    }

    /** Customer files: save to Downloads/PrintQR; the notification opens them for printing. */
    private void downloadToPhone(Uri u) {
        try {
            String name = u.getLastPathSegment() == null ? "printqr-file" : u.getLastPathSegment();
            DownloadManager.Request r = new DownloadManager.Request(u)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "PrintQR/" + name);
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            dm.enqueue(r);
            Toast.makeText(this, PushService.hi(this) ? name + " डाउनलोड हो रहा है - खोलकर प्रिंट करने के लिए नोटिफ़िकेशन पर टैप करें" : "Downloading " + name + " - tap the notification to open and print", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, PushService.hi(this) ? "डाउनलोड नहीं हुआ" : "Download failed", Toast.LENGTH_SHORT).show();
        }
    }

    private class Bridge {
        /** Light or dark system bars to match the web theme. */
        @JavascriptInterface
        public void setBars(boolean dark) {
            if (!trustedPage) return;
            runOnUiThread(() -> {
                int c = dark ? 0xFF0B1210 : 0xFFFAF9F6;
                Window w = getWindow();
                w.setStatusBarColor(c);
                w.setNavigationBarColor(c);
                root.setBackgroundColor(c);
                if (statusBg != null) statusBg.setBackgroundColor(c);
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(w, w.getDecorView());
                bars.setAppearanceLightStatusBars(!dark);
                bars.setAppearanceLightNavigationBars(!dark);
            });
        }

        /** Offer to save the login in Google Password Manager (app 1.5.71+). Shows the system "Save password?" sheet. */
        @JavascriptInterface
        public void savePassword(String id, String password) {
            if (!trustedPage || id == null || password == null || id.isEmpty() || password.isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    CredentialManager cm = CredentialManager.create(MainActivity.this);
                    cm.createCredentialAsync(MainActivity.this, new CreatePasswordRequest(id, password), null,
                        androidx.core.content.ContextCompat.getMainExecutor(MainActivity.this), new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                            @Override public void onResult(CreateCredentialResponse r) { }
                            @Override public void onError(CreateCredentialException e) {
                                // User tapped "Not now" -> silent. Anything else: say why, so it can be fixed (e.g. no password manager turned on).
                                if (e instanceof androidx.credentials.exceptions.CreateCredentialCancellationException) return;
                                boolean hi = PushService.hi(MainActivity.this);
                                // Only the case the user can fix gets a Toast; the technical type goes to the log, never on screen.
                                android.util.Log.w("PrintQR", "password save: " + e.getType());
                                if (e instanceof androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
                                    || e instanceof androidx.credentials.exceptions.CreateCredentialProviderConfigurationException)
                                    Toast.makeText(MainActivity.this, hi ? "पासवर्ड सेव नहीं हुआ: फ़ोन Settings में Google Password Manager चालू करें" : "Password not saved: turn on Google Password Manager in phone Settings", Toast.LENGTH_LONG).show();
                            }
                        });
                } catch (Throwable t) {
                    android.util.Log.w("PrintQR", "password save failed", t);
                }
            });
        }

        /** Pick a saved login from Google Password Manager (app 1.5.73+). Fills the form through window.__pqFill(id, password). */
        @JavascriptInterface
        public void getPassword() {
            if (!trustedPage) return;
            runOnUiThread(() -> {
                try {
                    CredentialManager cm = CredentialManager.create(MainActivity.this);
                    GetCredentialRequest req = new GetCredentialRequest.Builder().addCredentialOption(new GetPasswordOption()).build();
                    cm.getCredentialAsync(MainActivity.this, req, null,
                        androidx.core.content.ContextCompat.getMainExecutor(MainActivity.this), new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                            @Override public void onResult(GetCredentialResponse r) {
                                if (!(r.getCredential() instanceof PasswordCredential) || web == null) return;
                                PasswordCredential pc = (PasswordCredential) r.getCredential();
                                web.evaluateJavascript("window.__pqFill&&window.__pqFill(" + JSONObject.quote(pc.getId()) + "," + JSONObject.quote(pc.getPassword()) + ")", null);
                            }
                            @Override public void onError(GetCredentialException e) { /* nothing saved / dismissed: just type it */ }
                        });
                } catch (Throwable ignored) { }
            });
        }

        /** Sign in with Google (app 1.5.74+): Google's own account sheet, answers window.__pqGoogle(idToken, error). */
        @JavascriptInterface
        public void googleSignIn(String clientId, String nonceHash) {
            if (!trustedPage || clientId == null || clientId.isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    GetSignInWithGoogleOption.Builder ob = new GetSignInWithGoogleOption.Builder(clientId);
                    if (nonceHash != null && !nonceHash.isEmpty()) ob.setNonce(nonceHash);
                    GetCredentialRequest req = new GetCredentialRequest.Builder().addCredentialOption(ob.build()).build();
                    CredentialManager.create(MainActivity.this).getCredentialAsync(MainActivity.this, req, null,
                        androidx.core.content.ContextCompat.getMainExecutor(MainActivity.this), new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                            @Override public void onResult(GetCredentialResponse r) {
                                try {
                                    if (r.getCredential() instanceof CustomCredential
                                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(r.getCredential().getType())) {
                                        googleAnswer(GoogleIdTokenCredential.createFrom(r.getCredential().getData()).getIdToken(), "");
                                    } else googleAnswer("", "type");
                                } catch (Throwable t) { googleAnswer("", t.getClass().getSimpleName()); }
                            }
                            @Override public void onError(GetCredentialException e) {
                                // A real "back"/close is silent. Google also reports setup problems (wrong SHA-1, app not allowed) as a "cancel" with code 16: show those.
                                String m = String.valueOf(e.getMessage());
                                boolean userCancel = e instanceof androidx.credentials.exceptions.GetCredentialCancellationException
                                    && !m.contains("16") && !m.toLowerCase().contains("reauth") && !m.toLowerCase().contains("developer");
                                googleAnswer("", userCancel ? "cancel" : (e.getType() + ": " + m));
                            }
                        });
                } catch (Throwable t) { googleAnswer("", t.getClass().getSimpleName()); }
            });
        }

        private void googleAnswer(String token, String err) {
            if (web == null) return;
            web.evaluateJavascript("window.__pqGoogle&&window.__pqGoogle(" + JSONObject.quote(token) + "," + JSONObject.quote(err) + ")", null);
        }

        /** SMS OTP auto-read (newer than app 1.5.77): wait for the next OTP SMS; answers via window event 'printqr-otp'. */
        @JavascriptInterface
        public void startSmsRetriever() {
            if (!trustedPage) return;
            runOnUiThread(MainActivity.this::startSmsWait);
        }

        /** Stop waiting for the OTP SMS (login page closed, number changed). */
        @JavascriptInterface
        public void stopSmsRetriever() {
            runOnUiThread(MainActivity.this::endSmsWait);
        }

        /** Status bar colour to match the page's own top bar (app 1.5.47+). hex like #e6e1d6. */
        @JavascriptInterface
        public void setStatusColor(String hex, boolean darkIcons) {
            if (!trustedPage) return;
            final int c;
            try { c = android.graphics.Color.parseColor(hex); } catch (Exception e) { return; }
            runOnUiThread(() -> {
                Window w = getWindow();
                w.setStatusBarColor(c);
                if (statusBg != null) statusBg.setBackgroundColor(c);
                WindowCompat.getInsetsController(w, w.getDecorView()).setAppearanceLightStatusBars(darkIcons);
            });
        }

        @JavascriptInterface
        public void print(String title) {
            if (!trustedPage) return;
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                if (pm != null) {
                    pm.print(title, web.createPrintDocumentAdapter(title), new PrintAttributes.Builder().build());
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            if (!trustedPage) return;
            runOnUiThread(() -> MainActivity.this.openExternal(url));
        }

        @JavascriptInterface
        public void razorpay(String optionsJson) {
            if (!trustedPage) return;
            runOnUiThread(() -> {
                try {
                    JSONObject o = new JSONObject(optionsJson);
                    Checkout co = new Checkout();
                    co.setKeyID(o.getString("key"));
                    co.open(MainActivity.this, o);
                } catch (Exception e) {
                    js("window.__pqRzpFail&&window.__pqRzpFail(false," + JSONObject.quote(String.valueOf(e.getMessage())) + ")");
                }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            if (!trustedPage) return "";
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void checkUpdate() {
            if (!trustedPage) return;
            checkUpdateAsync();
        }

        @JavascriptInterface
        public void downloadUpdate(String version) {
            if (!trustedPage) return;
            downloadUpdateAsync(version);
        }

        @JavascriptInterface
        public boolean canInstall() {
            if (!trustedPage) return false;
            try {
                return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
            } catch (Exception e) {
                return true;
            }
        }

        @JavascriptInterface
        public String installUpdate() {
            if (!trustedPage) return "error:UNTRUSTED";
            final String[] res = { "error:INSTALL_FAILED" };
            final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
            runOnUiThread(() -> {
                res[0] = installUpdateNow();
                done.countDown();
            });
            try { done.await(5, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            return res[0];
        }

        /** Saved push token ("" until Firebase gives one; a new one also arrives via window.__pqPush). */
        @JavascriptInterface
        public String pushToken() {
            if (!trustedPage) return "";
            runOnUiThread(MainActivity.this::fetchPushToken);
            return getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_TOKEN, "");
        }

        /** Last Firebase token problem ("" when fine), for the Settings push line. */
        @JavascriptInterface
        public String pushError() {
            if (!trustedPage) return "";
            return getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString("push_err", "");
        }

        /** True when the user allowed notifications for the app. */
        @JavascriptInterface
        public boolean notifyAllowed() {
            return androidx.core.app.NotificationManagerCompat.from(MainActivity.this).areNotificationsEnabled();
        }

        /** Android 13+: ask once for permission to show notifications. The answer goes to window.__pqNotify(granted). */
        @JavascriptInterface
        public void askNotify() {
            if (!trustedPage) return;
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1002);
                } else {
                    notifyAnswer();
                }
            });
        }

        /** UI language (EN / हिं on the page): the app's own notifications, channel names and messages use it. */
        @JavascriptInterface
        public void setLang(String lang) {
            if (!trustedPage) return;
            PushService.setLang(MainActivity.this, lang);
        }

        @JavascriptInterface
        public void toast(String msg) {
            if (!trustedPage) return;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void saveFile(String base64, String name, String mime) {
            if (!trustedPage) return;
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                Uri saved;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/PrintQR");
                    saved = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (saved == null) throw new Exception("insert failed");
                    try (OutputStream os = getContentResolver().openOutputStream(saved)) { os.write(data); }
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File f = new File(dir, name);
                    try (FileOutputStream os = new FileOutputStream(f)) { os.write(data); }
                    saved = null;
                }
                final Uri open = saved;
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, (PushService.hi(MainActivity.this) ? "सेव हो गया: Downloads/PrintQR/" : "Saved: Downloads/PrintQR/") + name, Toast.LENGTH_LONG).show();
                    if (open != null) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(open, mime)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                        } catch (Exception ignored) { }
                    }
                });
            } catch (Exception e) {
                toast(PushService.hi(MainActivity.this) ? "डाउनलोड नहीं हुआ" : "Download failed");
            }
        }
    }

    private void notifyAnswer() {
        boolean ok = androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled();
        js("window.__pqNotify&&window.__pqNotify(" + ok + ")");
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req == 1002) notifyAnswer();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK_FILES || pendingFiles == null) return;
        Uri[] result = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        pendingFiles.onReceiveValue(result);
        pendingFiles = null;
    }

    @Override
    public void onBackPressed() {
        if (popup != null) {
            if (popup.canGoBack()) popup.goBack();
            else closePopup();
            return;
        }
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    /** Hands a push token to the page (Dashboard registers it with Supabase). */
    void sendPushToken(String token) {
        if (token == null || token.isEmpty() || !trustedPage) return;
        js("window.__pqPush&&window.__pqPush(" + JSONObject.quote(token) + ")");
    }

    private void fetchPushToken() {
        try {
            if (FirebaseApp.getApps(this).isEmpty()) { pushErr("no firebase config"); return; } // built without google-services.json: push off
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    Exception e = task.getException();
                    pushErr("token: " + (e == null ? "empty" : (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage())));
                    return;
                }
                pushErr("");
                String t = task.getResult();
                getSharedPreferences(PushService.PREFS, MODE_PRIVATE).edit().putString(PushService.KEY_TOKEN, t).apply();
                sendPushToken(t);
            });
        } catch (Exception e) {
            pushErr("init: " + e.getClass().getSimpleName()); // push is optional
        }
    }

    private void pushErr(String msg) {
        getSharedPreferences(PushService.PREFS, MODE_PRIVATE).edit().putString("push_err", msg == null ? "" : msg).apply();
    }

    @Override
    protected void onDestroy() {
        endSmsWait();
        if (PushService.active == this) PushService.active = null;
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        PushService.foreground = true;
        if (web != null) web.evaluateJavascript("window.__pqResume&&window.__pqResume()", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        PushService.foreground = false;
        CookieManager.getInstance().flush();
    }
}
