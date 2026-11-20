package rdvr;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Installs an APK through the PackageInstaller session API as the shell user, without the `pm` command.
 * Some Desay SV head-unit firmware (Jaecoo "SOP6"/"SOP7") refuses `pm install`; the session API still works.
 *
 * Run on the device: CLASSPATH=/data/local/tmp/rdvr_installer.dex app_process /system/bin rdvr.Installer <apk>
 * Prints RDVR_INSTALLED:<package>:<versionCode> on success, RDVR_ERROR:<reason> otherwise.
 */
public final class Installer {
    private static final int INSTALL_REPLACE_EXISTING = 0x00000002;
    private static final int INSTALL_GRANT_RUNTIME_PERMISSIONS = 0x00000100;

    public static void main(String[] args) {
        int rc;
        try {
            rc = run(args);
        } catch (Throwable t) {
            System.out.println("RDVR_ERROR:" + t);
            t.printStackTrace(System.out);
            rc = 2;
        }
        System.out.flush();
        System.exit(rc);
    }

    private static int run(String[] args) throws Exception {
        if (args.length < 1) {
            System.out.println("usage: rdvr.Installer /data/local/tmp/app.apk");
            return 64;
        }
        File apk = new File(args[0]);
        if (!apk.isFile()) { System.out.println("RDVR_ERROR:file_not_found " + apk); return 66; }

        Looper.prepareMainLooper();
        Class<?> at = Class.forName("android.app.ActivityThread");
        Object thread = at.getMethod("systemMain").invoke(null);
        Context system = (Context) at.getMethod("getSystemContext").invoke(thread);
        // Act as the shell package so the installer's calling package matches our uid (2000).
        Context ctx = system.createPackageContext("com.android.shell", 0);
        PackageManager pm = ctx.getPackageManager();

        PackageInfo archive = pm.getPackageArchiveInfo(apk.getPath(), 0);
        if (archive == null) { System.out.println("RDVR_ERROR:invalid_apk"); return 65; }
        String pkg = archive.packageName;
        long version = archive.getLongVersionCode();
        System.out.println("RDVR_STEP:session " + pkg + " " + version + " (" + apk.length() + " bytes)");

        PackageInstaller installer = pm.getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(pkg);
        params.setSize(apk.length());
        addInstallFlags(params, INSTALL_REPLACE_EXISTING | INSTALL_GRANT_RUNTIME_PERMISSIONS);

        HandlerThread callbacks = new HandlerThread("rdvr-install");
        callbacks.start();
        final CountDownLatch finished = new CountDownLatch(1);
        final boolean[] success = {false};
        final int sessionId = installer.createSession(params);
        PackageInstaller.SessionCallback cb = new PackageInstaller.SessionCallback() {
            @Override public void onCreated(int id) {}
            @Override public void onBadgingChanged(int id) {}
            @Override public void onActiveChanged(int id, boolean active) {}
            @Override public void onProgressChanged(int id, float progress) {}
            @Override public void onFinished(int id, boolean ok) {
                if (id == sessionId) { success[0] = ok; finished.countDown(); }
            }
        };
        installer.registerSessionCallback(cb, new Handler(callbacks.getLooper()));
        try {
            PackageInstaller.Session session = installer.openSession(sessionId);
            try {
                OutputStream out = session.openWrite("base.apk", 0, apk.length());
                InputStream in = new FileInputStream(apk);
                try {
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    session.fsync(out);
                } finally {
                    in.close();
                    out.close();
                }
                int flags = Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0;
                Intent result = new Intent("rdvr.INSTALL_RESULT." + sessionId).setPackage("com.android.shell");
                PendingIntent pending = PendingIntent.getBroadcast(ctx, sessionId, result, flags);
                System.out.println("RDVR_STEP:commit " + sessionId);
                session.commit(pending.getIntentSender());
            } finally {
                session.close();
            }
            boolean done = finished.await(120, TimeUnit.SECONDS);
            long installed = installedVersion(pm, pkg);
            if (installed == version) {
                System.out.println("RDVR_INSTALLED:" + pkg + ":" + version);
                return 0;
            }
            System.out.println("RDVR_ERROR:" + (!done ? "commit_timeout" : success[0] ? "version_mismatch " + installed : "commit_failed"));
            return 1;
        } catch (Exception e) {
            try { installer.abandonSession(sessionId); } catch (Exception ignored) {}
            throw e;
        } finally {
            installer.unregisterSessionCallback(cb);
            callbacks.quitSafely();
        }
    }

    private static long installedVersion(PackageManager pm, String pkg) {
        try {
            return pm.getPackageInfo(pkg, 0).getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            return -1;
        }
    }

    /** SessionParams.installFlags is hidden; set it by reflection (best effort). */
    private static void addInstallFlags(PackageInstaller.SessionParams params, int flags) {
        try {
            Field f = PackageInstaller.SessionParams.class.getDeclaredField("installFlags");
            f.setAccessible(true);
            f.setInt(params, f.getInt(params) | flags);
        } catch (Throwable t) {
            System.out.println("RDVR_WARN:install_flags " + t);
        }
    }
}
