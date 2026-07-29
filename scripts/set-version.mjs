import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!version || !semverPattern.test(version)) {
  throw new Error("Aufruf: node scripts/set-version.mjs <SemVer>, zum Beispiel 0.1.0");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function updateJson(relativePath) {
  const target = path.join(root, relativePath);
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  data.version = version;
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function replaceRequired(relativePath, pattern, replacement) {
  const target = path.join(root, relativePath);
  const content = fs.readFileSync(target, "utf8");
  const next = content.replace(pattern, replacement);
  if (next === content) {
    const alreadyUpdated = content.includes(`version = "${version}"`);
    if (!alreadyUpdated) {
      throw new Error(`Version konnte in ${relativePath} nicht aktualisiert werden.`);
    }
  }
  fs.writeFileSync(target, next, "utf8");
}

updateJson("package.json");
{
  const target = path.join(root, "package-lock.json");
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  data.version = version;
  data.packages[""].version = version;
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
updateJson("src-tauri/tauri.conf.json");
replaceRequired(
  "src-tauri/Cargo.toml",
  /^(\[package\][\s\S]*?^version = ")[^"]+(")/m,
  `$1${version}$2`
);
replaceRequired(
  "src-tauri/Cargo.lock",
  /(\[\[package\]\]\r?\nname = "agendakontakte"\r?\nversion = ")[^"]+(")/,
  `$1${version}$2`
);

console.log(`Projektversion auf ${version} gesetzt.`);
