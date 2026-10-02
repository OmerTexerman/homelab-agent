import { describe, expect, it } from "vite-plus/test";

import {
  forecastConflicts,
  maxMigrationId,
  unexpectedActiveWorkflows,
  proposeMigrationIds,
  rewriteBlacksmithRunners,
} from "./upstream-sync.ts";

describe("upstream-sync", () => {
  it("forecasts conflicts only for files both sides changed, largest fork diff first", () => {
    const numstat = ["10\t5\tapps/a.ts", "100\t0\tapps/b.ts", "3\t3\tapps/fork-only.ts"].join("\n");
    expect(forecastConflicts(numstat, ["apps/a.ts", "apps/b.ts", "apps/upstream-only.ts"])).toEqual(
      [
        { path: "apps/b.ts", forkLines: 100 },
        { path: "apps/a.ts", forkLines: 15 },
      ],
    );
  });

  it("rewrites Blacksmith runners and leaves hosted runners alone", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: blacksmith-8vcpu-ubuntu-2404",
      "  b:",
      '    runs-on: "blacksmith-4vcpu-ubuntu-2404" # fast',
      "  c:",
      "    runs-on: ubuntu-24.04",
    ].join("\n");
    expect(rewriteBlacksmithRunners(yaml)).toBe(
      [
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-24.04",
        "  b:",
        "    runs-on: ubuntu-24.04 # fast",
        "  c:",
        "    runs-on: ubuntu-24.04",
      ].join("\n"),
    );
  });

  it("proposes migration ids above the fork's current maximum", () => {
    expect(
      proposeMigrationIds(
        [
          "apps/server/src/persistence/Migrations/043_B.ts",
          "apps/server/src/persistence/Migrations/042_A.ts",
          "apps/server/src/persistence/Migrations/042_A.test.ts",
          "apps/server/src/other.ts",
        ],
        50,
      ),
    ).toEqual([
      { upstreamFile: "apps/server/src/persistence/Migrations/042_A.ts", proposedId: 51 },
      { upstreamFile: "apps/server/src/persistence/Migrations/043_B.ts", proposedId: 52 },
    ]);
  });

  it("reads the highest registered migration id", () => {
    const source = [
      "export const migrationEntries = [",
      '  [1, "A", A],',
      '  [50, "B", B],',
      "] as const;",
    ].join("\n");
    expect(maxMigrationId(source)).toBe(50);
  });

  it("flags active workflows outside the fork's allowlist", () => {
    expect(
      unexpectedActiveWorkflows([
        { path: ".github/workflows/ci.yml", state: "active" },
        { path: ".github/workflows/promote-prod.yml", state: "active" },
        { path: ".github/workflows/runtime-smoke.yml", state: "active" },
        { path: ".github/workflows/upstream-sync-report.yml", state: "active" },
        { path: ".github/workflows/windows-tests.yml", state: "active" },
        { path: ".github/workflows/release.yml", state: "disabled_manually" },
        { path: "dynamic/dependabot/dependabot-updates", state: "active" },
      ]),
    ).toEqual([".github/workflows/windows-tests.yml"]);
  });
});
