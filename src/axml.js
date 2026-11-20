// Minimal parser for Android's binary XML (AndroidManifest.xml inside an APK).
// Enough to read the package name, version, requested permissions and components with a
// `android:permission` (VPN / accessibility / notification listener / device admin).

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;

// Framework attribute resource ids (used when attribute name strings are stripped/obfuscated).
const ATTR_IDS = {
  0x01010003: "name",
  0x01010006: "permission",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x01010001: "label",
};

function readStringPool(view, start) {
  const count = view.getUint32(start + 8, true);
  const flags = view.getUint32(start + 16, true);
  const stringsStart = view.getUint32(start + 20, true);
  const utf8 = (flags & 0x100) !== 0;
  const strings = new Array(count);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < count; i++) {
    let p = start + stringsStart + view.getUint32(start + 28 + i * 4, true);
    if (utf8) {
      // char length (1-2 bytes), then byte length (1-2 bytes)
      let len = bytes[p++];
      if (len & 0x80) p++;
      len = bytes[p++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | bytes[p++];
      strings[i] = new TextDecoder("utf-8").decode(bytes.subarray(p, p + len));
    } else {
      let len = view.getUint16(p, true); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | view.getUint16(p, true); p += 2; }
      let s = "";
      for (let k = 0; k < len; k++) s += String.fromCharCode(view.getUint16(p + k * 2, true));
      strings[i] = s;
    }
  }
  return strings;
}

/** Parses binary XML into a tree of {tag, attrs, children}. */
export function parseBinaryXml(buffer) {
  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  if (view.getUint16(0, true) !== RES_XML) throw new Error("not a binary XML file");
  let strings = [];
  let resMap = [];
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  let off = view.getUint16(2, true);
  while (off + 8 <= view.byteLength) {
    const type = view.getUint16(off, true);
    const size = view.getUint32(off + 4, true);
    if (size < 8) break;
    if (type === RES_STRING_POOL) {
      strings = readStringPool(view, off);
    } else if (type === RES_XML_RESOURCE_MAP) {
      const n = (size - view.getUint16(off + 2, true)) / 4;
      resMap = [];
      for (let i = 0; i < n; i++) resMap.push(view.getUint32(off + 8 + i * 4, true));
    } else if (type === RES_XML_START_ELEMENT) {
      const nameIdx = view.getUint32(off + 20, true);
      const attrStart = view.getUint16(off + 24, true);
      const attrSize = view.getUint16(off + 26, true);
      const attrCount = view.getUint16(off + 28, true);
      const el = { tag: strings[nameIdx], attrs: {}, children: [] };
      for (let i = 0; i < attrCount; i++) {
        const a = off + 16 + attrStart + i * attrSize;
        const nIdx = view.getUint32(a + 4, true);
        let name = strings[nIdx] || "";
        if ((!name || name.length === 0) && resMap[nIdx] !== undefined) name = ATTR_IDS[resMap[nIdx]] || `0x${resMap[nIdx].toString(16)}`;
        const raw = view.getUint32(a + 8, true);
        const dataType = view.getUint8(a + 15);
        const data = view.getUint32(a + 16, true);
        let value;
        if (raw !== 0xffffffff) value = strings[raw];
        else if (dataType === 0x03) value = strings[data];
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x10) value = data | 0;
        else if (dataType === 0x01) value = `@0x${data.toString(16)}`;
        else value = data;
        el.attrs[name] = value;
      }
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT) {
      if (stack.length > 1) stack.pop();
    }
    off += size;
  }
  return root.children[0];
}

function* walk(el, parent = null) {
  yield [el, parent];
  for (const c of el.children) yield* walk(c, el);
}

/** Extracts what the installer needs from a parsed manifest. */
export function summarizeManifest(manifest) {
  const pkg = manifest.attrs.package;
  const qualify = (n) => (n && n.startsWith(".") ? pkg + n : n && !n.includes(".") ? `${pkg}.${n}` : n);
  const permissions = [];
  const components = [];
  for (const [el] of walk(manifest)) {
    if (el.tag === "uses-permission" || el.tag === "uses-permission-sdk-23") {
      if (el.attrs.name && !permissions.includes(el.attrs.name)) permissions.push(el.attrs.name);
    } else if (["service", "receiver", "activity"].includes(el.tag) && el.attrs.permission) {
      components.push({ kind: el.tag, name: qualify(el.attrs.name), permission: el.attrs.permission });
    }
  }
  return {
    packageName: pkg,
    versionName: manifest.attrs.versionName ?? "",
    versionCode: manifest.attrs.versionCode ?? "",
    permissions,
    components,
  };
}
