package com.receipto.print;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
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

import com.razorpay.Checkout;
import com.razorpay.PaymentData;
import com.razorpay.PaymentResultWithDataListener;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;

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
        ".catch(function(){PQ.toast('Download failed')})}" +
        "var clickOrig=HTMLAnchorElement.prototype.click;" +
        "HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')&&/^(blob|data):/.test(this.href)){save(this);return}return clickOrig.call(this)};" +
        "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[download]');" +
        "if(a&&/^(blob|data):/.test(a.href)){e.preventDefault();e.stopPropagation();save(a)}},true);" +
        "})();";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(0xFF0B1210);
        w.setNavigationBarColor(0xFF0B1210);

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
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
                return handleUrl(req.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serveAsset(req.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(BRIDGE_JS, null);
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
                if (progress > 60) view.evaluateJavascript(BRIDGE_JS, null);
            }
        });
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            if (url.startsWith("http")) openExternal(url);
        });

        Checkout.preload(getApplicationContext());

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START);
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
            if (host.equals(APP_HOST) || host.endsWith("razorpay.com")) return false;
            if (host.endsWith("supabase.co") && !uri.getPath().contains("/storage/")) return false;
            openExternal(uri.toString());
            return true;
        }
        Intent i = null;
        try {
            i = scheme.equals("intent")
                ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                : new Intent(Intent.ACTION_VIEW, uri);
            if (scheme.equals("intent")) {
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
            }
            startActivity(i);
        } catch (Exception e) {
            String fallback = i == null ? null : i.getStringExtra("browser_fallback_url");
            if (fallback != null) openExternal(fallback);
            else Toast.makeText(this, scheme.equals("upi") || uri.toString().contains("upi")
                ? "No UPI app found. Install Google Pay, PhonePe or Paytm, or pay by card."
                : "No app found to open this", Toast.LENGTH_LONG).show();
        }
        return true;
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        String host = u.getHost() == null ? "" : u.getHost();
        if (host.endsWith("supabase.co") && u.getPath() != null && u.getPath().contains("/storage/")) {
            downloadToPhone(u);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "No app found to open this file", Toast.LENGTH_SHORT).show();
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
            Toast.makeText(this, "Downloading " + name + " - tap the notification to open and print", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download failed", Toast.LENGTH_SHORT).show();
        }
    }

    private class Bridge {
        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                if (pm != null) {
                    pm.print(title, web.createPrintDocumentAdapter(title), new PrintAttributes.Builder().build());
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> MainActivity.this.openExternal(url));
        }

        @JavascriptInterface
        public void razorpay(String optionsJson) {
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
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void saveFile(String base64, String name, String mime) {
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
                    Toast.makeText(MainActivity.this, "Saved: Downloads/PrintQR/" + name, Toast.LENGTH_LONG).show();
                    if (open != null) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(open, mime)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                        } catch (Exception ignored) { }
                    }
                });
            } catch (Exception e) {
                toast("Download failed");
            }
        }
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

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
