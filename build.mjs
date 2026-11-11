// 빌드: 아이콘 생성 -> manifest에 update_url/버전 넣기 -> CRX3 서명 -> docs/ 에 crx와 update.xml 출력
// 사용: node build.mjs   (build.config.json 의 pagesBase 필요)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const crx3 = require("crx3");

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
// build.config.local.json(.gitignore에 있음)이 있으면 그 값이 우선한다. 내 PC 경로(keyPath 등)는 여기에 둔다.
const localCfgPath = path.join(root, "build.config.local.json");
const cfg = {
  ...readJson(path.join(root, "build.config.json")),
  ...(fs.existsSync(localCfgPath) ? readJson(localCfgPath) : {}),
};
if (!cfg.pagesBase || /example\.github\.io/.test(cfg.pagesBase)) {
  console.warn("주의: pagesBase가 예시 주소입니다. build.config.json에 실제 GitHub Pages 주소를 넣고 다시 빌드하세요.");
}
const pagesBase = cfg.pagesBase.replace(/\/?$/, "/");
// 개인 키는 저장소에도, 원드라이브에도 두지 않는다
const keyPath = cfg.keyPath || "C:\\로컬개발\\keys\\tablog.pem";

const src = path.join(root, "extension");
const out = path.join(root, "build", "ext");
const docs = path.join(root, "docs");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(docs, { recursive: true });

// 1) 아이콘: 16x16 도트 몽당연필 (크기별로 정수배 확대)
const PENCIL = [
  "................",
  "................",
  "................",
  "................",
  "..KKKKKKKKKK....",
  ".KPPPKSSYYYYKK..",
  "KPPPPKSSYYYYWWK.",
  "KPPPPKSSYEYEWWGK",
  "KPPPPKSSRYYYRWGK",
  "KPPPPKSSOOOOWWK.",
  ".KPPPKSSOOOOKK..",
  "..KKKKKKKKKK....",
  "................",
  "................",
  "................",
  "................",
];
const COLORS = {
  K: [0x3b, 0x2a, 0x1f], P: [0xf4, 0x8f, 0xb1], S: [0xb0, 0xbe, 0xc5],
  Y: [0xff, 0xd5, 0x4f], O: [0xf9, 0xa8, 0x25], W: [0xf1, 0xc2, 0x7d],
  G: [0x42, 0x42, 0x42], E: [0x21, 0x21, 0x21], R: [0xff, 0x8a, 0x80],
};
function png(size) {
  const scale = size / 16;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const ch = PENCIL[Math.floor(y / scale)][Math.floor(x / scale)];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (ch === ".") continue;
      const [r, g, b] = COLORS[ch];
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), png(s));

// 2) 확장 프로그램 파일 복사 + manifest 에 update_url
for (const f of ["background.js", "schema.json"]) fs.copyFileSync(path.join(src, f), path.join(out, f));
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
manifest.update_url = pagesBase + "update.xml";
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

// 3) 서명 (키가 없으면 새로 만든다)
const keyExisted = fs.existsSync(keyPath);
fs.mkdirSync(path.dirname(keyPath), { recursive: true });
const files = fs.readdirSync(out).map((f) => path.join(out, f));
const info = await crx3(files, {
  keyPath,
  crxPath: path.join(docs, "tablog.crx"),
  xmlPath: path.join(docs, "update.xml"),
  appVersion: manifest.version,
  crxURL: pagesBase + "tablog.crx",
  browserVersion: manifest.minimum_chrome_version,
});

const appId = info && info.appId;
fs.writeFileSync(path.join(docs, "extension-id.txt"), String(appId) + "\n");
fs.writeFileSync(path.join(docs, ".nojekyll"), "");
console.log("버전:", manifest.version);
console.log("확장 프로그램 ID:", appId);
console.log("update.xml:", pagesBase + "update.xml");
console.log(keyExisted ? "기존 키 사용" : "새 키 생성: " + keyPath + "  (꼭 백업하세요)");
