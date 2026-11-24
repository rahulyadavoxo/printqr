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

    static final String KEY_LANG = "lang";

    /** UI language picked in the app (the page sends it through PQ.setLang); English until then. */
    static boolean hi(Context c) {
        return "hi".equals(c.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_LANG, "en"));
    }

    static void setLang(Context c, String lang) {
        if (!"en".equals(lang) && !"hi".equals(lang)) return;
        c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LANG, lang).apply();
        ensureChannel(c);
    }

    /** Creates the channels, or renames existing ones to the picked language (sound / importance stay). */
    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean hi = hi(c);
        nm.createNotificationChannel(channel(CHANNEL,
            c.getString(hi ? R.string.notif_channel_hi : R.string.notif_channel),
            c.getString(hi ? R.string.notif_channel_desc_hi : R.string.notif_channel_desc)));
        nm.createNotificationChannel(channel(CHANNEL_READY,
            c.getString(hi ? R.string.notif_channel_ready_hi : R.string.notif_channel_ready),
            c.getString(hi ? R.string.notif_channel_ready_desc_hi : R.string.notif_channel_ready_desc)));
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
    /** v43: admin alert taps open the Admin panel, optionally on one tab (support message -> /admin?tab=support). */
    static boolean validAdminPath(String path) {
        return path != null && path.matches("/admin(\\?tab=[a-z]{2,20})?");
    }

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
        // v43: admin alert while the app is open (Android only shows it by itself in the background)
        if ("admin_alert".equals(d.get("kind"))) { showAdmin(msg, d); return; }
        if (!"ready".equals(d.get("kind"))) return;
        String path = d.get("path");
        if (!validOrderPath(path)) return;
        // That order's status page is on screen: it rings by itself.
        String url = currentUrl == null ? "" : currentUrl;
        // Both URL forms: app (#/o/ID/KEY, HashRouter) and website (/o/ID/KEY).
        if (foreground && url.contains(path)) return;
        showReady(msg, path, d.get("order_id"), d.get("lang"));
    }

    private void showAdmin(RemoteMessage msg, Map<String, String> d) {
        try {
            String path = d.get("path");
            if (!validAdminPath(path)) path = "/admin";
            ensureChannel(this);
            RemoteMessage.Notification n = msg.getNotification();
            String title = n != null && n.getTitle() != null ? n.getTitle() : (d.get("title") != null ? d.get("title") : "PrintQR");
            String body = n != null && n.getBody() != null ? n.getBody() : (d.get("body") != null ? d.get("body") : "");
            String tag = d.get("tag") != null ? d.get("tag") : "admin";
            Intent open = new Intent(this, MainActivity.class)
                .putExtra("kind", "admin_alert")
                .putExtra("path", path)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
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
            if (nm != null) nm.notify(tag, 2, b.build());
        } catch (Exception ignored) {
            // no permission: the admin bell still shows it
        }
    }

    private void showReady(RemoteMessage msg, String path, String orderId, String lang) {
        try {
            ensureChannel(this);
            RemoteMessage.Notification n = msg.getNotification();
            // The server already sends the customer's language; this is only the fallback title.
            boolean hi = "hi".equals(lang) || ((lang == null || lang.isEmpty()) && hi(this));
            String title = n != null && n.getTitle() != null ? n.getTitle() : (hi ? "ऑर्डर तैयार है" : "Order ready");
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
