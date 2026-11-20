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
  $("install").disabled = !connected || !state.apk;
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
    const [model, release, sdk, fingerprint] = await Promise.all([
      sh("getprop ro.product.model", { quiet: true }),
      sh("getprop ro.build.version.release", { quiet: true }),
      sh("getprop ro.build.version.sdk", { quiet: true }),
      sh("getprop ro.build.fingerprint", { quiet: true }),
    ]);
    state.headUnit = /DesaySV/i.test(fingerprint);
    state.device = `${model} · Android ${release} (API ${sdk})` + (state.headUnit ? " · Desay SV head unit" : "");
    log(`Connected: ${state.device}`, "ok");
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

async function installAndGrant() {
  const { apk, apkBytes } = state;
  $("install").disabled = true;
  try {
    log(`Installing ${apk.packageName} (${(apkBytes.length / 1048576).toFixed(1)} MB)…`);
    // Push, then `pm install` from the device (see NEEDS_SCRIPT): a streamed install is refused by Desay SV head units.
    const remote = `${TMP}/rdvr_pkg_${Date.now()}.apk`;
    await push(remote, bytesStream(apkBytes));
    const out = await sh(`pm install -r -g ${remote} 2>&1; rm -f ${remote}`);
    if (!/^Success/m.test(out)) throw new Error(out || "no output from pm");
    log("Installed.", "ok");
  } catch (e) {
    log(`Install failed: ${e.message}`, "err");
    if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(e.message)) log(`A version signed with another key is installed. Uninstall it first: pm uninstall ${apk.packageName}`, "err");
    if (/VERSION_DOWNGRADE/i.test(e.message)) log("A newer version is installed; uninstall it first to downgrade.", "err");
    refresh();
    return;
  }
  for (const act of state.actions.filter((x) => x.on)) {
    if (act.headUnitOnly && !state.headUnit) { log(`— ${act.label}: skipped (not a Desay SV head unit)`, "muted"); continue; }
    log(`— ${act.label}`, "muted");
    for (const cmd of act.commands) {
      try { await sh(cmd); } catch (e) { log(`failed: ${e.message}`, "err"); }
    }
  }
  try {
    // Report only the runtime permissions we asked for (install-time "normal" ones are always granted).
    const runtime = state.actions.find((x) => x.id === "runtime");
    if (runtime) {
      const dump = await sh(`dumpsys package ${apk.packageName}`, { quiet: true });
      const wanted = runtime.commands.map((c) => c.split(" ").pop());
      const ok = wanted.filter((p) => new RegExp(`${p.replace(/\./g, "\\.")}: granted=true`).test(dump));
      log(`Runtime permissions granted: ${ok.length}/${wanted.length}` + (ok.length < wanted.length ? ` (missing: ${wanted.filter((p) => !ok.includes(p)).map((p) => p.split(".").pop()).join(", ")})` : ""), ok.length === wanted.length ? "ok" : "err");
    }
  } catch {}
  log("Done.", "ok");
  if ($("launch").checked) {
    const out = await sh(`monkey -p ${apk.packageName} -c android.intent.category.LAUNCHER 1 2>&1 | grep -E "Events injected|No activities"`, { quiet: true });
    log(/Events injected: 1/.test(out) ? `Opened ${apk.packageName}.` : `Couldn't open the app (${out || "no launcher activity"}).`, /Events injected: 1/.test(out) ? "ok" : "err");
  }
  refresh();
}

async function runExtra() {
  for (const line of $("extra").value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    try { await sh(line); } catch (e) { log(`failed: ${e.message}`, "err"); }
  }
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
$("install").addEventListener("click", installAndGrant);
$("run-extra").addEventListener("click", runExtra);
$("clear-log").addEventListener("click", () => ($("log").textContent = ""));
refresh();
loadBundle();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
