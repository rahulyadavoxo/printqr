package com.receipto.print;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * New-order push notifications (Firebase Cloud Messaging). The server (Edge Function push-new-order)
 * sends a "notification" message on the "orders" channel, so Android shows it by itself while the app
 * is closed or in the background. While the app is open the dashboard already rings, so nothing extra.
 */
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL = "orders";
    static final String PREFS = "pq";
    static final String KEY_TOKEN = "push_token";

    /** True while MainActivity is on screen. */
    static volatile boolean foreground = false;
    /** Set by MainActivity so a fresh token can be handed to the page right away. */
    static volatile MainActivity active = null;

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, c.getString(R.string.notif_channel), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(c.getString(R.string.notif_channel_desc));
        ch.enableVibration(true);
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
        nm.createNotificationChannel(ch);
    }

    @Override
    public void onNewToken(String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply();
        MainActivity a = active;
        if (a != null) a.sendPushToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        // App open: the dashboard rings and shows the order itself.
    }
}
