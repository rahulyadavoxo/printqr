package com.receipto.print;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.browser.customtabs.CustomTabsIntent;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * Opens PrintQR as a Trusted Web Activity (full screen, in Chrome).
 * Some phones (ColorOS / OnePlus / Realme / Oppo and others) block the app from
 * connecting to the browser, so the TWA never shows and the app looks like it
 * closes. If the browser has not appeared within a few seconds, open the site
 * in a Custom Tab instead (still Chrome, so upload, payment and printing work).
 */
public class MainLauncher extends LauncherActivity {
    private static final String URL = "https://print.receipto.in/";
    private static final long FALLBACK_MS = 3500;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean browserShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!isFinishing()) {
            handler.postDelayed(this::fallbackIfStuck, FALLBACK_MS);
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        browserShown = true;
        handler.removeCallbacksAndMessages(null);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void fallbackIfStuck() {
        if (browserShown || isFinishing()) return;
        Uri uri = Uri.parse(URL);
        try {
            CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).build();
            tab.launchUrl(this, uri);
        } catch (RuntimeException e) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException ignored) {
                // No browser at all: nothing else we can do.
            }
        }
        finish();
    }
}
