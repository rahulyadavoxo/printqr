package com.receipto.print;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * New-order push notifications (Firebase Cloud Messaging). The server (Edge Function push-new-order)
 * sends a "notification" message on the "orders" channel, so Android shows it by itself while the app
 * is closed or in the background. While the app is open the dashboard already rings, so nothing extra.
 *
 * v18: the customer's "order ready" message (data kind=ready, path=/o/ID/KEY) on the "ready" channel.
 * Tapping it opens that order's status page in the app (MainActivity reads the "path" extra). While
 * the app is open on another page, it is shown here; on that order's status page the page rings itself.
 */
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL = "orders";
    static final String CHANNEL_READY = "ready";
    static final String PREFS = "pq";
    static final String KEY_TOKEN = "push_token";

    /** Page the app shows now (MainActivity.trackPage). */
    static volatile String currentUrl = "";
    /** True while MainActivity is on screen. */
    static volatile boolean foreground = false;
    /** Set by MainActivity so a fresh token can be handed to the page right away. */
    static volatile MainActivity active = null;

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(channel(CHANNEL, c.getString(R.string.notif_channel), c.getString(R.string.notif_channel_desc)));
        }
        if (nm.getNotificationChannel(CHANNEL_READY) == null) {
            nm.createNotificationChannel(channel(CHANNEL_READY, c.getString(R.string.notif_channel_ready), c.getString(R.string.notif_channel_ready_desc)));
        }
    }

    private static NotificationChannel channel(String id, String name, String desc) {
        NotificationChannel ch = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(desc);
        ch.enableVibration(true);
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
        return ch;
    }

    /** "/o/<uuid>/<uuid>" only: the status page of one order. */
    static boolean validOrderPath(String path) {
        return path != null && path.matches("/o/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}");
    }

    @Override
    public void onNewToken(String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply();
        MainActivity a = active;
        if (a != null) a.sendPushToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        // App open: the dashboard rings and shows a new order itself.
        Map<String, String> d = msg.getData();
        if (!"ready".equals(d.get("kind"))) return;
        String path = d.get("path");
        if (!validOrderPath(path)) return;
        // That order's status page is on screen: it rings by itself.
        String url = currentUrl == null ? "" : currentUrl;
        if (foreground && url.contains("#" + path)) return;
        showReady(msg, path, d.get("order_id"));
    }

    private void showReady(RemoteMessage msg, String path, String orderId) {
        try {
            ensureChannel(this);
            RemoteMessage.Notification n = msg.getNotification();
            String title = n != null && n.getTitle() != null ? n.getTitle() : "Order ready";
            String body = n != null && n.getBody() != null ? n.getBody() : "";
            Intent open = new Intent(this, MainActivity.class)
                .putExtra("kind", "ready")
                .putExtra("path", path)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int id = ("ready-" + orderId).hashCode();
            PendingIntent pi = PendingIntent.getActivity(this, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_READY)
                : new Notification.Builder(this);
            b.setSmallIcon(R.drawable.ic_stat_print)
                .setColor(getColor(R.color.notif))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi);
            if (Build.VERSION.SDK_INT < 26) {
                b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            }
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify("ready-" + orderId, 1, b.build());
        } catch (Exception ignored) {
            // no permission or bad resources: the status page still shows "ready"
        }
    }
}
