import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const platform = process.env.PRISM_PLATFORM;
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (!platform || !id || !version) throw new Error("release platform, id and version are required");
const destination = resolve(root, "release", `${id}-${version}-${platform}`);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const skip = new Set([".git", ".github", "release", "scripts", "test", "src", ".DS_Store", ".npmrc", ".gitignore"]);
for (const entry of await readdir(root)) {
  if (!skip.has(entry)) await cp(resolve(root, entry), resolve(destination, entry), { recursive: true });
}
console.log(destination);
