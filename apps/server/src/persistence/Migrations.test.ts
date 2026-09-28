import { describe, expect, it } from "vite-plus/test";

import { migrationEntries } from "./Migrations.ts";

// Homelab fork invariant: upstream syncs renumber fork migrations, and a
// duplicated or out-of-order id silently skips a migration on existing
// databases (the migrator only runs ids above the latest recorded one).
describe("migrationEntries", () => {
  it("uses strictly increasing, unique ids", () => {
    const ids = migrationEntries.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id, index) => {
      if (index > 0) expect(id).toBeGreaterThan(ids[index - 1]!);
    });
  });

  it("uses unique migration names", () => {
    const names = migrationEntries.map(([, name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });
});
