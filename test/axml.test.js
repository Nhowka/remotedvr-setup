import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { parseBinaryXml, summarizeManifest } from "../src/axml.js";
import { planActions } from "../src/permissions.js";

const manifestOf = (apk) => summarizeManifest(parseBinaryXml(unzipSync(readFileSync(apk), { filter: (f) => f.name === "AndroidManifest.xml" })["AndroidManifest.xml"]));

test("RemoteDVR (our release APK, R8)", () => {
  const m = manifestOf("../RemoteDVR.apk");
  assert.equal(m.packageName, "com.nhowka.remotedvr");
  assert.equal(m.versionName, "1.0");
  assert.ok(m.permissions.includes("android.permission.ACCESS_FINE_LOCATION"));
  assert.ok(m.permissions.includes("android.permission.FOREGROUND_SERVICE"));
  const ids = planActions(m).map((a) => a.id);
  assert.ok(ids.includes("runtime"));
  assert.ok(ids.includes("battery"));
  const runtime = planActions(m).find((a) => a.id === "runtime");
  assert.ok(runtime.commands.includes("pm grant com.nhowka.remotedvr android.permission.ACCESS_FINE_LOCATION"));
});

test("JConfig (third-party APK with special components)", () => {
  const m = manifestOf("../jconfig-1.9.1.apk");
  assert.equal(m.packageName, "com.frodrigues.jconfig");
  assert.ok(m.permissions.includes("android.permission.WRITE_SECURE_SETTINGS"));
  const plan = planActions(m);
  const byId = Object.fromEntries(plan.map((a) => [a.id, a]));
  assert.ok(byId["op-SYSTEM_ALERT_WINDOW"].on);
  assert.equal(byId["dev-WRITE_SECURE_SETTINGS"].on, false); // powerful → opt-in
  assert.ok(plan.some((a) => a.id.startsWith("a11y-") && !a.on && a.risky));
  console.log(JSON.stringify({ pkg: m.packageName, perms: m.permissions.length, components: m.components, actions: plan.map((a) => `${a.on ? "[x]" : "[ ]"} ${a.label}`) }, null, 1));
});
