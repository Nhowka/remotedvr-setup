// Bakes an APK into the page: copies it to docs/ and writes docs/bundle.json (title, version, SHA-256,
// app-specific post-install steps). Usage: npm run bundle -- <app.apk> <config.json>
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { parseBinaryXml, summarizeManifest } from "../src/axml.js";

const [apkPath, configPath] = process.argv.slice(2);
if (!apkPath || !configPath) { console.error("usage: npm run bundle -- <app.apk> <config.json>"); process.exit(1); }
const bytes = readFileSync(apkPath);
const manifest = summarizeManifest(parseBinaryXml(unzipSync(bytes, { filter: (f) => f.name === "AndroidManifest.xml" })["AndroidManifest.xml"]));
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.packageName && config.packageName !== manifest.packageName)
  throw new Error(`APK is ${manifest.packageName}, config expects ${config.packageName}`);

const name = basename(apkPath);
const old = existsSync("docs/bundle.json") ? JSON.parse(readFileSync("docs/bundle.json", "utf8")).apk : null;
if (old && old !== name) rmSync(`docs/${old}`, { force: true });
copyFileSync(apkPath, `docs/${name}`);
const bundle = {
  title: config.title,
  description: config.description,
  apk: name,
  packageName: manifest.packageName,
  versionName: manifest.versionName,
  versionCode: manifest.versionCode,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  postInstall: config.postInstall || [],
};
writeFileSync("docs/bundle.json", JSON.stringify(bundle, null, 2) + "\n");
console.log(`bundled ${name}: ${bundle.packageName} ${bundle.versionName} (${bundle.versionCode}), ${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${bundle.sha256.slice(0, 16)}…`);
