# RemoteDVR Setup (WebUSB installer)

Static web app (GitHub Pages) that installs an APK on an Android device over USB with ADB
(WebUSB via [Tango / ya-webadb](https://github.com/yume-chan/ya-webadb)) and grants the permissions
the APK requests. Runs entirely in the browser; the APK is never uploaded anywhere.

- Reads the APK's binary `AndroidManifest.xml` in the browser (`src/axml.js`).
- Builds a checklist (`src/permissions.js`): runtime permissions (`pm grant`), special app-ops
  (overlay, write settings, all-files, usage access, exact alarms), legacy storage app-ops, battery
  whitelist, VPN consent (`appops ACTIVATE_VPN`). Powerful items (accessibility, notification access,
  device admin, WRITE_SECURE_SETTINGS/READ_LOGS/DUMP) are listed but **off** by default.
- Pushes the APK to `/data/local/tmp` and runs `pm install -r -g` **from a pushed script**: Desay SV head units
  (Chery/Jaecoo/Omoda) close any adb command line containing `install`. Any other command containing that word is
  run the same way. Then runs the checked commands, reports the granted count, can launch the app.
- **Bundled app:** if `docs/bundle.json` exists the page loads that APK itself (SHA-256 checked) and adds its
  app-specific steps (for RemoteDVR: import the car's 360 camera libraries, head unit only). You can still pick
  another APK. Update it with `npm run bundle -- <app.apk> remotedvr.bundle.json`.

## Develop
    npm install
    npm test          # parser/plan tests against ../RemoteDVR.apk and ../jconfig-1.9.1.apk
    npm run build     # bundles src/ → docs/app.js
    npm run bundle -- ../RemoteDVR.apk remotedvr.bundle.json   # bake an APK into the page
    cd docs && python3 -m http.server 8765   # http://localhost:8765 (localhost counts as secure for WebUSB)

## Publish
GitHub Pages → "Deploy from a branch" → `main` / `/docs`. Requires HTTPS (Pages provides it); Chrome/Edge only.
