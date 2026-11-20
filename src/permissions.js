// Turns an APK's requested permissions/components into a checklist of ADB grant actions.
// Each action: { id, label, detail, commands: string[], on: default checked, risky: bool }

// Runtime ("dangerous") permissions, granted with `pm grant`.
const RUNTIME = new Set([
  "READ_CALENDAR", "WRITE_CALENDAR", "CAMERA", "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS",
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "RECORD_AUDIO",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "READ_CALL_LOG",
  "WRITE_CALL_LOG", "ADD_VOICEMAIL", "USE_SIP", "PROCESS_OUTGOING_CALLS", "BODY_SENSORS",
  "BODY_SENSORS_BACKGROUND", "SEND_SMS", "RECEIVE_SMS", "READ_SMS", "RECEIVE_WAP_PUSH", "RECEIVE_MMS",
  "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "ACCESS_MEDIA_LOCATION", "ACTIVITY_RECOGNITION",
  "POST_NOTIFICATIONS", "NEARBY_WIFI_DEVICES", "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "BLUETOOTH_ADVERTISE",
  "UWB_RANGING", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "READ_MEDIA_VISUAL_USER_SELECTED",
]);

// Special permissions controlled by app-ops (Settings toggles), harmless enough to enable by default.
const APPOPS = {
  SYSTEM_ALERT_WINDOW: { op: "SYSTEM_ALERT_WINDOW", label: "Display over other apps" },
  WRITE_SETTINGS: { op: "WRITE_SETTINGS", label: "Modify system settings" },
  MANAGE_EXTERNAL_STORAGE: { op: "MANAGE_EXTERNAL_STORAGE", label: "All files access" },
  REQUEST_INSTALL_PACKAGES: { op: "REQUEST_INSTALL_PACKAGES", label: "Install unknown apps" },
  PACKAGE_USAGE_STATS: { op: "GET_USAGE_STATS", label: "Usage access" },
  SCHEDULE_EXACT_ALARM: { op: "SCHEDULE_EXACT_ALARM", label: "Alarms & reminders" },
};

// Development permissions grantable with pm grant – powerful, off by default.
const DEVELOPMENT = {
  WRITE_SECURE_SETTINGS: "Change secure system settings",
  READ_LOGS: "Read all system logs",
  DUMP: "Read system service state (dumpsys)",
};

const short = (p) => p.replace(/^android\.permission\./, "");

/**
 * @param {{packageName:string, permissions:string[], components:{kind:string,name:string,permission:string}[]}} apk
 */
export function planActions(apk) {
  const pkg = apk.packageName;
  const perms = apk.permissions.map(short);
  const has = (p) => perms.includes(p);
  const actions = [];

  const runtime = apk.permissions.filter((p) => p.startsWith("android.permission.") && RUNTIME.has(short(p)));
  if (runtime.length) {
    actions.push({
      id: "runtime",
      label: `Runtime permissions (${runtime.length})`,
      detail: runtime.map(short).join(", "),
      commands: runtime.map((p) => `pm grant ${pkg} ${p}`),
      on: true,
      risky: false,
    });
  }
  // Legacy storage app-ops (needed on some Android 10/11 builds even after pm grant, e.g. head units).
  if (has("READ_EXTERNAL_STORAGE") || has("WRITE_EXTERNAL_STORAGE")) {
    actions.push({
      id: "storage-appops", label: "Storage app-ops (legacy)", detail: "appops READ/WRITE_EXTERNAL_STORAGE allow",
      commands: ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"].filter(has).map((o) => `appops set ${pkg} ${o} allow`),
      on: true, risky: false,
    });
  }
  for (const [perm, { op, label }] of Object.entries(APPOPS)) {
    if (has(perm)) actions.push({ id: `op-${op}`, label, detail: `appops ${op} allow`, commands: [`appops set ${pkg} ${op} allow`], on: true, risky: false });
  }
  if (has("ACCESS_NOTIFICATION_POLICY")) {
    actions.push({ id: "dnd", label: "Do Not Disturb access", detail: "cmd notification allow_dnd", commands: [`cmd notification allow_dnd ${pkg}`], on: true, risky: false });
  }
  if (has("REQUEST_IGNORE_BATTERY_OPTIMIZATIONS") || has("FOREGROUND_SERVICE")) {
    actions.push({
      id: "battery", label: "Exclude from battery optimization", detail: "dumpsys deviceidle whitelist",
      commands: [`dumpsys deviceidle whitelist +${pkg}`], on: true, risky: false,
    });
  }

  for (const c of apk.components) {
    const perm = short(c.permission);
    const comp = `${pkg}/${c.name}`;
    if (perm === "BIND_VPN_SERVICE") {
      actions.push({ id: "vpn", label: "Allow VPN without the consent dialog", detail: c.name, commands: [`appops set ${pkg} ACTIVATE_VPN allow`], on: true, risky: false });
    } else if (perm === "BIND_NOTIFICATION_LISTENER_SERVICE") {
      actions.push({ id: `nl-${c.name}`, label: "Notification access (reads ALL notifications)", detail: c.name, commands: [`cmd notification allow_listener ${comp}`], on: false, risky: true });
    } else if (perm === "BIND_ACCESSIBILITY_SERVICE") {
      actions.push({
        id: `a11y-${c.name}`, label: "Accessibility service (can see and control the screen)", detail: c.name,
        // Appended to the existing list, never replacing other services.
        commands: [`cur=$(settings get secure enabled_accessibility_services); case "$cur" in *${comp}*) ;; null|"") settings put secure enabled_accessibility_services ${comp} ;; *) settings put secure enabled_accessibility_services "$cur:${comp}" ;; esac; settings put secure accessibility_enabled 1`],
        on: false, risky: true,
      });
    } else if (perm === "BIND_DEVICE_ADMIN") {
      actions.push({ id: `admin-${c.name}`, label: "Device administrator", detail: c.name, commands: [`dpm set-active-admin ${comp}`], on: false, risky: true });
    }
  }
  for (const [perm, label] of Object.entries(DEVELOPMENT)) {
    if (has(perm)) actions.push({ id: `dev-${perm}`, label, detail: `pm grant android.permission.${perm}`, commands: [`pm grant ${pkg} android.permission.${perm}`], on: false, risky: true });
  }
  return actions;
}
