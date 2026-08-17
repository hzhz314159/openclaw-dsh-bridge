// @deepseek-ai/dsh-openclaw-bridge/scripts/pack.mjs
// 零依赖打包：把插件目录打包为 npm 风格 tgz（tar.gz）+ 源码 zip 两份发布件。
// 用法：node scripts/pack.mjs [输出目录]   （缺省输出到平台桌面）
// 依赖：仅 node 内置模块（fs/path/zlib/crypto）。无 npm/外部工具要求。
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { gzipSync, deflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const NAME = PKG.name.replace(/^@[^/]+\//, "");
const VERSION = PKG.version;

const SKIP = new Set(["node_modules", ".git", "dist", "pack.js", "pack.mjs"]);
const SKIP_EXT = new Set([".tgz", ".zip"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push({ path: full, type: "dir", size: 0 });
      walk(full, out);
    } else {
      if (SKIP_EXT.has(extOf(entry))) continue;
      out.push({ path: full, type: "file", size: st.size });
    }
  }
  return out;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

// ---- tar（ustar） ----
const ZERO = Buffer.alloc(512);
function tarEntry(name, { type = "0", size = 0, mode = 0o644, mtime = 1700000000 }) {
  const hdr = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, "utf8");
  if (nameBuf.length > 100) throw new Error("tar name too long: " + name);
  nameBuf.copy(hdr, 0);
  writeOctal(hdr, 100, mode, 7);
  writeOctal(hdr, 108, 0, 7);   // uid
  writeOctal(hdr, 116, 0, 7);   // gid
  writeOctal(hdr, 124, size, 12);
  writeOctal(hdr, 136, mtime, 12);
  hdr[156] = type.charCodeAt(0);
  hdr.write("ustar\u000000", 257, "utf8");
  hdr.write("dsh", 265, "utf8"); // uname
  hdr.write("dsh", 297, "utf8"); // gname
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += hdr[i];
  writeOctal(hdr, 148, sum, 6);
  return hdr;
}

function writeOctal(buf, off, val, len) {
  const s = val.toString(8);
  buf.write(s.padStart(len - 1, "0"), off, "ascii");
  buf[off + len - 1] = 0;
}

function buildTar(entries, prefix) {
  const chunks = [];
  for (const e of entries) {
    const rel = relative(ROOT, e.path).split(sep).join("/");
    const name = prefix ? prefix + "/" + rel : rel;
    if (e.type === "dir") {
      chunks.push(tarEntry(name + "/", { type: "5", mode: 0o755 }));
      continue;
    }
    const data = readFileSync(e.path);
    chunks.push(tarEntry(name, { size: data.length }));
    chunks.push(data);
    const pad = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(ZERO, ZERO);
  return Buffer.concat(chunks);
}

// ---- zip（CRC32 + deflate） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(mtime = new Date(1700000000000)) {
  const d = new Date(mtime);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries, rootName) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const rel = relative(ROOT, e.path).split(sep).join("/");
    const name = rootName + "/" + rel + (e.type === "dir" ? "/" : "");
    const nameBuf = Buffer.from(name, "utf8");
    const data = e.type === "dir" ? Buffer.alloc(0) : readFileSync(e.path);
    const { time, date } = dosDateTime();
    const crc = crc32(data);
    const comp = e.type === "file" && data.length > 0 ? deflateRawSync(data) : data;
    // local header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, comp);
    // central dir
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// ---- main ----
const outDir = process.argv[2] || join(homedir(), "Desktop");
mkdirSync(outDir, { recursive: true });

const entries = walk(ROOT);
const baseName = `${NAME}-${VERSION}`;
const tgzName = join(outDir, baseName + ".tgz");
const zipName = join(outDir, baseName + "-src.zip");

const tar = buildTar(entries, "package");
writeFileSync(tgzName, gzipSync(tar));
console.log(`tgz  -> ${tgzName}  (${(await statSync(tgzName).size / 1024).toFixed(1)} KiB, ${entries.filter((e) => e.type === "file").length} files)`);

const zip = buildZip(entries, baseName);
writeFileSync(zipName, zip);
console.log(`zip  -> ${zipName}  (${(await statSync(zipName).size / 1024).toFixed(1)} KiB)`);

// 验证：列出 tgz 内容清单（前 10 条 + 统计）
const listing = [];
for (const e of entries) listing.push(relative(ROOT, e.path).split(sep).join("/"));
console.log(`打包清单（${listing.length} 项）: ${listing.slice(0, 5).join(", ")} …`);