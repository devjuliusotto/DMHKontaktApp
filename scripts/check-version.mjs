import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expected = process.argv[2];
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readMatch(relativePath, pattern, label) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`${label} konnte nicht aus ${relativePath} gelesen werden.`);
  }
  return match[1];
}

const versions = new Map([
  ["package.json", readJson("package.json").version],
  ["package-lock.json", readJson("package-lock.json").version],
  ["package-lock.json packages[\"\"]", readJson("package-lock.json").packages[""].version],
  ["src-tauri/tauri.conf.json", readJson("src-tauri/tauri.conf.json").version],
  [
    "src-tauri/Cargo.toml",
    readMatch("src-tauri/Cargo.toml", /^\[package\][\s\S]*?^version = "([^"]+)"/m, "Cargo-Version")
  ],
  [
    "src-tauri/Cargo.lock",
    readMatch(
      "src-tauri/Cargo.lock",
      /\[\[package\]\]\r?\nname = "agendakontakte"\r?\nversion = "([^"]+)"/,
      "Cargo-Lock-Version"
    )
  ]
]);

for (const [file, version] of versions) {
  if (!semverPattern.test(version)) {
    throw new Error(`${file} enthält keine gültige SemVer-Version: ${version}`);
  }
}

const uniqueVersions = new Set(versions.values());
if (uniqueVersions.size !== 1) {
  throw new Error(
    `Versionsnummern stimmen nicht überein:\n${[...versions]
      .map(([file, version]) => `- ${file}: ${version}`)
      .join("\n")}`
  );
}

const [current] = uniqueVersions;
if (expected && current !== expected) {
  throw new Error(`Erwartete Version ${expected}, im Quellcode steht aber ${current}.`);
}

console.log(`Version konsistent: ${current}`);
