import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const entry of fs.readdirSync(path.join(root, "packages"))) {
  fs.rmSync(path.join(root, "packages", entry, "dist"), {
    recursive: true,
    force: true,
  });
}

fs.rmSync(path.join(root, "generated"), { recursive: true, force: true });
