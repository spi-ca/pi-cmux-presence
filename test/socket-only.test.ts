import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("production source has no process execution API or command fallback", async () => {
  const root = join(import.meta.dir, "..");
  const content = await Promise.all((await sourceFiles(join(root, "src"))).concat(join(root, "index.ts")).map((file) => fs.readFile(file, "utf8")));
  const production = content.join("\n");
  for (const forbidden of ["pi.exec", "child_process", "Bun.spawn", "spawn(", "execFile", "exec(", "execa", "setWidget(", ".ui.setStatus("]) {
    expect(production).not.toContain(forbidden);
  }
});
