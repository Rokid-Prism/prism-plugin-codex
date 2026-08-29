import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const raw = manifest.match(/^command:\s*(\[[^\n]+\])$/m)?.[1];
if (!id || !raw) throw new Error("invalid manifest command");
const command = JSON.parse(raw).map((part) => part === "${runtime.node}" ? process.execPath : part);
if (command[0].startsWith("./")) command[0] = resolve(root, command[0]);
const child = spawn(command[0], command.slice(1), { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const response = await new Promise((resolveResponse, reject) => {
  const timer = setTimeout(() => reject(new Error(`probe timed out: ${stderr}`)), 15000);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const line = stdout.split("\n").find((value) => value.trim());
    if (!line) return;
    clearTimeout(timer);
    try { resolveResponse(JSON.parse(line)); } catch (error) { reject(error); }
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== 0) reject(new Error(`probe exited ${code}: ${stderr}`));
  });
  child.stdin.end('{"id":"release-probe","method":"adapter.probe","params":{}}\n');
});
if (response.id !== "release-probe" || response.ok !== true || response.payload?.plugin_id !== id) throw new Error(`invalid probe response: ${JSON.stringify(response)}`);
console.log(`protocol probe passed for ${id}; available=${Boolean(response.payload.available)}`);
