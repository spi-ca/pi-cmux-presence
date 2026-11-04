import { expect, test } from "bun:test";

test("dateSemVer metadata matches the newest versioned changelog heading", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const changelog = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text();

  expect(manifest.version).toBe("2026.1104.2");
  expect(Bun.semver.satisfies(manifest.version, ">0.1.1")).toBe(true);
  expect(changelog.match(/^## \[([^\]]+)\]/m)?.[1]).toBe(manifest.version);
  expect(changelog).toContain("\n## [0.1.1]\n");
});
