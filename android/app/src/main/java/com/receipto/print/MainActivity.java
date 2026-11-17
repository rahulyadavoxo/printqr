package com.receipto.print;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;

import java.util.Collections;

/**
 * Opens https://print.receipto.in full screen in Chrome (Trusted Web Activity).
 * Every step is guarded: if the browser can't be reached in 3 s, or anything
 * fails, the site opens in a Chrome tab instead, and as a last resort in any browser.
 */
public class MainActivity extends Activity {
    private static final Uri URL = Uri.parse("https://print.receipto.in/");
    private final Handler handler = new Handler(Looper.getMainLooper());
    private CustomTabsServiceConnection connection;
    private boolean done = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String pkg = null;
        try {
            pkg = CustomTabsClient.getPackageName(this, Collections.singletonList("com.android.chrome"), false);
        } catch (Throwable ignored) { }
        if (pkg == null) { openInBrowser(); return; }

        handler.postDelayed(this::openTab, 3000);
        try {
            connection = new CustomTabsServiceConnection() {
                @Override
                public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
                    if (done) return;
                    try {
                        client.warmup(0);
                        CustomTabsSession session = client.newSession(null);
                        if (session == null) { openTab(); return; }
                        new TrustedWebActivityIntentBuilder(URL).build(session).launchTrustedWebActivity(MainActivity.this);
                        finishOnce();
                    } catch (Throwable t) {
                        openTab();
                    }
                }

                @Override
                public void onServiceDisconnected(ComponentName name) { }
            };
            if (!CustomTabsClient.bindCustomTabsService(this, pkg, connection)) openTab();
        } catch (Throwable t) {
            openTab();
        }
    }

    private void openTab() {
        if (done) return;
        try {
            new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, URL);
            finishOnce();
        } catch (Throwable t) {
            openInBrowser();
        }
    }

    private void openInBrowser() {
        if (done) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, URL));
        } catch (Throwable ignored) { }
        finishOnce();
    }

    private void finishOnce() {
        done = true;
        handler.removeCallbacksAndMessages(null);
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (connection != null) {
            try { unbindService(connection); } catch (Throwable ignored) { }
        }
        super.onDestroy();
    }
}
