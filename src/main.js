import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { ReadableStream } from "@yume-chan/stream-extra";
import { unzipSync } from "fflate";
import { parseBinaryXml, summarizeManifest } from "./axml.js";
import { planActions } from "./permissions.js";

const $ = (id) => document.getElementById(id);
const state = { adb: null, device: null, headUnit: false, apk: null, apkBytes: null, actions: [], bundle: null };
const credentials = new AdbWebCredentialStore("RemoteDVR Setup");

// ---------- log ----------
function log(text, cls = "") {
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = text;
  $("log").append(line);
  $("log").scrollTop = $("log").scrollHeight;
}

// Desay SV head units (Chery/Jaecoo) close any adb command line containing "install" ("error: closed"),
// which breaks `pm install` and `appops set … REQUEST_INSTALL_PACKAGES`. Such commands are pushed as a script
// and run with `sh <script>`, which works on every device.
const TMP = "/data/local/tmp";
const NEEDS_SCRIPT = /install/i;

async function push(path, stream) {
  const sync = await state.adb.sync();
  try {
    await sync.write({ filename: path, file: stream, permission: 0o644 });
  } finally {
    await sync.dispose();
  }
}

function bytesStream(bytes) {
  const CHUNK = 256 * 1024;
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(pos, Math.min(pos + CHUNK, bytes.length)));
      pos += CHUNK;
    },
  });
}

async function sh(cmd, { quiet = false } = {}) {
  if (!quiet) log(`$ ${cmd}`, "cmd");
  let line = cmd;
  if (NEEDS_SCRIPT.test(cmd)) {
    const script = `${TMP}/rdvr_cmd_${Date.now()}.sh`;
    await push(script, bytesStream(new TextEncoder().encode(`${cmd}\nrc=$?\nrm -f "$0"\nexit $rc\n`)));
    line = `sh ${script}`;
  }
  const out = (await state.adb.subprocess.noneProtocol.spawnWaitText(line)).trim();
  if (out && !quiet) log(out, /error|exception|failure|denied|unknown/i.test(out) ? "err" : "out");
  return out;
}

function refresh() {
  const connected = !!state.adb;
  $("connect").hidden = connected;
  $("disconnect").hidden = !connected;
  $("install").disabled = !connected || !state.apk || state.busy;
  $("grant").disabled = !connected || !state.apk || state.busy;
  $("open-app").disabled = !connected || !state.apk || state.busy;
  $("run-extra").disabled = !connected;
  $("device").textContent = connected ? state.device : "Not connected";
  $("device").className = connected ? "ok" : "muted";
}

// ---------- device ----------
async function connect() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    log("WebUSB isn't available here. Use Chrome or Edge (desktop, or Android with USB OTG), over HTTPS.", "err");
    return;
  }
  let device;
  try {
    device = await manager.requestDevice();
  } catch (e) {
    log(`Device selection failed: ${e.message}`, "err");
    return;
  }
  if (!device) return; // user cancelled
  try {
    log(`Connecting to ${device.serial}… accept "Allow USB debugging" on the device if asked.`);
    const connection = await device.connect();
    const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore: credentials });
    state.adb = new Adb(transport);
    transport.disconnected.then(() => {
      state.adb = null;
      log("Device disconnected.", "muted");
      refresh();
    });
    const [model, release, sdk, fingerprint, displayId] = await Promise.all([
      sh("getprop ro.product.model", { quiet: true }),
      sh("getprop ro.build.version.release", { quiet: true }),
      sh("getprop ro.build.version.sdk", { quiet: true }),
      sh("getprop ro.build.fingerprint", { quiet: true }),
      sh("getprop ro.build.display.id", { quiet: true }),
    ]);
    state.headUnit = /DesaySV/i.test(fingerprint);
    state.sdk = Number(sdk) || 0;
    // Jaecoo/Chery firmware variant: SOP6/SOP7 refuse `pm install` (install via the session API instead).
    state.variant = displayId.match(/SOP\d+/i)?.[0]?.toUpperCase() ?? null;
    state.device = `${model} · Android ${release} (API ${sdk})` + (state.headUnit ? ` · Desay SV head unit${state.variant ? " " + state.variant : ""}` : "");
    if (state.headUnit) log(`Firmware: ${displayId}`, "muted");
    log(`Connected: ${state.device}`, "ok");
    showInstalled().catch(() => {});
  } catch (e) {
    const busy = /claim|busy|in use|access denied/i.test(e.message || "");
    log(`Connection failed: ${e.message}`, "err");
    if (busy) log("Another ADB program holds the device. Quit Android Studio (it restarts ADB automatically), close other WebADB/ADB tabs, run `adb kill-server`, then unplug and replug the device.", "err");
    state.adb = null;
  }
  refresh();
}

async function disconnect() {
  try { await state.adb?.close(); } catch {}
  state.adb = null;
  refresh();
}

// ---------- APK ----------
async function chooseApk(file) {
  if (!file) return;
  state.bundle = null; // a picked file replaces the bundled app
  await loadApk(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function loadApk(bytes, name) {
  $("info").textContent = "";
  $("actions").textContent = "";
  state.apk = null;
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === "AndroidManifest.xml" });
    if (!files["AndroidManifest.xml"]) throw new Error("no AndroidManifest.xml – is this an APK?");
    state.apk = summarizeManifest(parseBinaryXml(files["AndroidManifest.xml"]));
    state.apkBytes = bytes;
    state.actions = planActions(state.apk);
    // App-specific steps from bundle.json (e.g. importing the car's camera libraries).
    for (const extra of state.bundle?.postInstall || []) state.actions.push({ risky: false, on: true, ...extra });
    renderApk(bytes.length);
    showInstalled().catch(() => {});
  } catch (e) {
    log(`Can't read ${name}: ${e.message}`, "err");
  }
  refresh();
}

function renderApk(size) {
  const a = state.apk;
  $("info").innerHTML = "";
  const h = document.createElement("div");
  h.innerHTML = `<b></b><br><span class="muted"></span>`;
  h.querySelector("b").textContent = a.packageName;
  h.querySelector("span").textContent =
    `version ${a.versionName || "?"} (${a.versionCode || "?"}) · ${(size / 1048576).toFixed(1)} MB · ${a.permissions.length} permissions requested`;
  $("info").append(h);
  const all = document.createElement("details");
  all.innerHTML = "<summary>All requested permissions</summary>";
  const pre = document.createElement("pre");
  pre.textContent = a.permissions.join("\n") || "(none)";
  all.append(pre);
  $("info").append(all);

  const list = $("actions");
  list.innerHTML = "";
  if (!state.actions.length) list.textContent = "Nothing to grant beyond installing.";
  for (const act of state.actions) {
    const row = document.createElement("label");
    row.className = "action" + (act.risky ? " risky" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = act.on;
    cb.addEventListener("change", () => (act.on = cb.checked));
    const text = document.createElement("span");
    text.innerHTML = "<b></b><small></small>";
    text.querySelector("b").textContent = act.label + (act.risky ? " ⚠" : "");
    text.querySelector("small").textContent = act.detail + (act.headUnitOnly ? " (head unit only)" : "");
    row.append(cb, text);
    list.append(row);
  }
}

// ---------- install / grant / open (independent steps) ----------
async function busy(fn) {
  state.busy = true; refresh();
  try { await fn(); } catch (e) { log(`Failed: ${e.message}`, "err"); } finally { state.busy = false; refresh(); }
}

/** Installed version of the package, or null. `pm path` / `dumpsys` contain no "install", so they run directly. */
async function installedVersion(pkg) {
  const path = await sh(`pm path ${pkg}`, { quiet: true });
  if (!/^package:/m.test(path)) return null;
  const dump = await sh(`dumpsys package ${pkg} | grep -m 2 -E "versionCode=|versionName="`, { quiet: true });
  return { code: Number(dump.match(/versionCode=(\d+)/)?.[1] ?? NaN), name: dump.match(/versionName=(\S+)/)?.[1] ?? "?" };
}

async function showInstalled() {
  const v = state.apk && state.adb ? await installedVersion(state.apk.packageName).catch(() => null) : null;
  $("installed").textContent = v ? `Installed on the device: ${v.name} (${v.code})` : (state.adb && state.apk ? "Not installed on the device" : "");
  return v;
}

async function install() {
  const { apk, apkBytes } = state;
  log(`Installing ${apk.packageName} ${apk.versionName} (${(apkBytes.length / 1048576).toFixed(1)} MB)…`);
  const remote = `${TMP}/rdvr_pkg_${Date.now()}.apk`;
  await push(remote, bytesStream(apkBytes));
  log(`Copied to ${remote}.`, "muted");
  // Our own PackageInstaller-session helper (installer-dex/, run with app_process as the shell user).
  const dex = `${TMP}/rdvr_installer.dex`;
  let haveDex = false;
  try {
    const r = await fetch("rdvr-installer.dex");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await push(dex, bytesStream(new Uint8Array(await r.arrayBuffer())));
    haveDex = true;
  } catch (e) { log(`Session helper unavailable (${e.message}); using pm only.`, "muted"); }
  const helper = ["session API (app_process)", `CLASSPATH=${dex} app_process /system/bin rdvr.Installer ${remote} 2>&1`];
  const pmInstall = ["pm install", `pm install -r -d -g ${remote} 2>&1`];
  // Desay SV head units block `pm install` ("Restriction prevents installing") – seen on SOP6/7 (JApp) and on an
  // SOP4 Jaecoo J7 too – so the helper goes first on every head unit.
  const helperFirst = state.headUnit;
  const methods = [
    ...(haveDex && helperFirst ? [helper, pmInstall] : haveDex ? [pmInstall, helper] : [pmInstall]),
    ["install session", `s=$(pm install-create -r -g -S ${apkBytes.length} 2>&1); echo "$s"; id=$(echo "$s" | grep -o '\\[[0-9]*\\]' | tr -d '[]'); ` +
      `[ -n "$id" ] && pm install-write -S ${apkBytes.length} $id base.apk ${remote} 2>&1 && pm install-commit $id 2>&1`],
  ];
  let ok = false;
  for (const [label, cmd] of methods) {
    log(`— ${label}`, "muted");
    const out = await sh(cmd).catch((e) => `error: ${e.message}`);
    const v = await installedVersion(apk.packageName).catch(() => null);
    if (/Success|RDVR_INSTALLED/.test(out) && v && (!apk.versionCode || v.code === Number(apk.versionCode))) { ok = true; break; }
    if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) { log(`A version signed with another key is installed. Uninstall it first: pm uninstall ${apk.packageName}`, "err"); break; }
    if (/VERSION_DOWNGRADE/i.test(out)) { log("A newer version is installed; uninstall it first to downgrade.", "err"); break; }
  }
  await sh(`rm -f ${remote} ${dex}`, { quiet: true }).catch(() => {});
  if (ok) {
    log("Installed.", "ok");
  } else {
    log("Install failed. Device log (package manager):", "err");
    await sh(`logcat -d -b all -t 600 2>/dev/null | grep -i -E "Restriction|PackageManager|PackageInstaller|app_process|AndroidRuntime|INSTALL_|sop6|desay" | tail -n 30`).catch(() => {});
    const dl = `/sdcard/Download/${apk.packageName}-${apk.versionName || "app"}.apk`;
    await push(dl, bytesStream(apkBytes)).then(
      () => log(`Copied the APK to ${dl}: open it with the device's file manager to install it, then use "Grant & set up".`, "err"),
      (e) => log(`Couldn't copy the APK to Download: ${e.message}`, "err"));
  }
  await showInstalled();
}

async function grant() {
  const { apk } = state;
  if (!(await installedVersion(apk.packageName))) {
    log(`${apk.packageName} isn't installed on the device yet – install it first (here or from a file manager).`, "err");
    return;
  }
  for (const act of state.actions.filter((x) => x.on)) {
    if (act.headUnitOnly && !state.headUnit) { log(`— ${act.label}: skipped (not a Desay SV head unit)`, "muted"); continue; }
    log(`— ${act.label}`, "muted");
    for (const cmd of act.commands) {
      const minSdk = permissionMinSdk(cmd);
      if (state.sdk && minSdk > state.sdk) { log(`skipped ${cmd.split(" ").pop().split(".").pop()} (needs Android API ${minSdk}, device has ${state.sdk})`, "muted"); continue; }
      try { await sh(cmd); } catch (e) { log(`failed: ${e.message}`, "err"); }
    }
  }
  try {
    // Report only the runtime permissions we asked for (install-time "normal" ones are always granted).
    const runtime = state.actions.find((x) => x.id === "runtime" && x.on);
    if (runtime) {
      const dump = await sh(`dumpsys package ${apk.packageName}`, { quiet: true });
      const wanted = runtime.commands.filter((c) => !state.sdk || permissionMinSdk(c) <= state.sdk).map((c) => c.split(" ").pop());
      const ok = wanted.filter((p) => new RegExp(`${p.replace(/\./g, "\\.")}: granted=true`).test(dump));
      log(`Runtime permissions granted: ${ok.length}/${wanted.length}` + (ok.length < wanted.length ? ` (missing: ${wanted.filter((p) => !ok.includes(p)).map((p) => p.split(".").pop()).join(", ")})` : ""), ok.length === wanted.length ? "ok" : "err");
    }
  } catch {}
  log("Set-up done.", "ok");
}

/** Runtime permissions that don't exist on older Android versions (granting them fails with "Unknown permission"). */
const PERMISSION_MIN_SDK = {
  POST_NOTIFICATIONS: 33, NEARBY_WIFI_DEVICES: 33, READ_MEDIA_IMAGES: 33, READ_MEDIA_VIDEO: 33, READ_MEDIA_AUDIO: 33,
  BODY_SENSORS_BACKGROUND: 33, READ_MEDIA_VISUAL_USER_SELECTED: 34, BLUETOOTH_SCAN: 31, BLUETOOTH_CONNECT: 31,
  BLUETOOTH_ADVERTISE: 31, UWB_RANGING: 31, ACCESS_BACKGROUND_LOCATION: 29, ACTIVITY_RECOGNITION: 29, ACCESS_MEDIA_LOCATION: 29,
};
function permissionMinSdk(cmd) {
  const m = cmd.match(/^pm grant \S+ android\.permission\.(\w+)$/);
  return (m && PERMISSION_MIN_SDK[m[1]]) || 0;
}

async function openApp() {
  const pkg = state.apk.packageName;
  const out = await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1 | grep -E "Events injected|No activities"`, { quiet: true });
  log(/Events injected: 1/.test(out) ? `Opened ${pkg}.` : `Couldn't open the app (${out || "not installed or no launcher activity"}).`, /Events injected: 1/.test(out) ? "ok" : "err");
}

async function runExtra() {
  for (const line of $("extra").value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    try { await sh(line); } catch (e) { log(`failed: ${e.message}`, "err"); }
  }
}

// ---------- copy / share / save the log ----------
const logText = () => Array.from($("log").children, (d) => d.textContent).join("\n");
function logStatus(msg) { $("copy-status").textContent = msg; setTimeout(() => ($("copy-status").textContent = ""), 4000); }

/** Synchronous copy through a focused, selected textarea – works on mobile browsers where the async API is refused. */
function copyViaTextarea(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  Object.assign(ta.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", fontSize: "16px" });
  document.body.append(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

function copyLog() {
  const text = logText();
  if (!text) return logStatus("Log is empty.");
  // Try the synchronous path first, inside the tap (mobile browsers drop the gesture after an await).
  if (copyViaTextarea(text)) return logStatus(`Copied ${text.split("\n").length} lines.`);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => logStatus(`Copied ${text.split("\n").length} lines.`),
      () => logStatus(navigator.share ? "Couldn't copy – use Share log." : "Couldn't copy – use Save .txt."));
  } else logStatus(navigator.share ? "Couldn't copy – use Share log." : "Couldn't copy – use Save .txt.");
}

async function shareLog() {
  const text = logText();
  if (!text) return logStatus("Log is empty.");
  try { await navigator.share({ title: "RemoteDVR setup log", text }); } catch (e) { if (e?.name !== "AbortError") logStatus(`Share failed: ${e.message}`); }
}

function saveLog() {
  const text = logText();
  if (!text) return logStatus("Log is empty.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = `remotedvr-setup-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---------- bundled app (docs/bundle.json, written by `npm run bundle`) ----------
async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadBundle() {
  let bundle;
  try {
    const r = await fetch("bundle.json", { cache: "no-cache" });
    if (!r.ok) return; // generic installer
    bundle = await r.json();
  } catch { return; }
  state.bundle = bundle;
  document.title = bundle.title;
  $("title").textContent = bundle.title;
  $("subtitle").textContent = bundle.description;
  $("apk-label").textContent = `${bundle.apk} · version ${bundle.versionName} — or pick another APK:`;
  $("apk-download-link").href = bundle.apk;
  $("apk-download-link").textContent = `Download ${bundle.apk} (${(bundle.size / 1048576).toFixed(1)} MB)`;
  $("apk-download").hidden = false;
  log(`Loading ${bundle.apk} (${(bundle.size / 1048576).toFixed(1)} MB)…`, "muted");
  try {
    const bytes = new Uint8Array(await (await fetch(bundle.apk)).arrayBuffer());
    const hash = await sha256Hex(bytes);
    if (hash !== bundle.sha256) throw new Error(`checksum mismatch (${hash.slice(0, 12)}… ≠ ${bundle.sha256.slice(0, 12)}…)`);
    log(`${bundle.apk} ready (SHA-256 ${hash.slice(0, 16)}…).`, "ok");
    await loadApk(bytes, bundle.apk);
  } catch (e) {
    log(`Couldn't load the bundled APK: ${e.message}. Pick it manually below.`, "err");
  }
  refresh();
}

// ---------- wiring ----------
$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", disconnect);
$("apk").addEventListener("change", (e) => chooseApk(e.target.files[0]));
$("install").addEventListener("click", () => busy(install));
$("grant").addEventListener("click", () => busy(grant));
$("open-app").addEventListener("click", () => busy(openApp));
$("run-extra").addEventListener("click", runExtra);
$("clear-log").addEventListener("click", () => ($("log").textContent = ""));
$("copy-log").addEventListener("click", copyLog);
$("share-log").addEventListener("click", shareLog);
$("save-log").addEventListener("click", saveLog);
$("share-log").hidden = !navigator.share;
refresh();
loadBundle();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
