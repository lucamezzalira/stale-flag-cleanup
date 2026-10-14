import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const datafiles = path.join(root, "featurevisor/datafiles");
const port = Number(process.env.DATAFILE_SERVE_PORT ?? 4099);
const productionFile = path.join(
  datafiles,
  "production",
  "featurevisor-all.json",
);

async function ensureBuilt(): Promise<void> {
  try {
    await access(productionFile);
  } catch {
    const built = spawnSync(
      "pnpm",
      ["--filter", "@stale-flags/featurevisor", "build"],
      {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );
    if (built.status !== 0) {
      throw new Error("featurevisor build failed");
    }
  }
}

await ensureBuilt();

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0];
  const filePath = path.join(datafiles, urlPath.replace(/^\//, ""));
  if (!filePath.startsWith(datafiles)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end(`not found: ${urlPath}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `Datafile CDN stand-in at http://127.0.0.1:${port}/production/featurevisor-all.json`,
  );
});
