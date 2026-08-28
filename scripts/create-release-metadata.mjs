import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const artifacts = resolve(root, process.argv[2] || "release-artifacts");
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const get = (name) => manifest.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^(?:"|')|(?:"|')$/g, "");
const id = get("id"), version = get("version");
const protocolVersion = get("plugin_protocol_version"), minHubVersion = get("min_hub_version");
const names = (await readdir(artifacts)).filter((name) => name.endsWith(".tar.gz")).sort();
if (names.length !== 4) throw new Error(`expected four platform archives, found ${names.length}`);
const assets = await Promise.all(names.map(async (name) => {
  const match = name.match(new RegExp(`^${id}-${version}-(macos-arm64|macos-x64|windows-x64|linux-x64)\\.tar\\.gz$`));
  if (!match) throw new Error(`invalid artifact name: ${name}`);
  const bytes = await readFile(resolve(artifacts, name));
  return { target: match[1], filename: name, sha256: createHash("sha256").update(bytes).digest("hex"), supported: true };
}));
await writeFile(resolve(artifacts, "plugin-release.json"), JSON.stringify({ schema_version: 1, plugin_id: id, version, release_tag: `v${version}`, channel: "stable", plugin_protocol_version: protocolVersion, min_hub_version: minHubVersion, supported_platforms: assets.map((asset) => asset.target), assets }, null, 2) + "\n");
