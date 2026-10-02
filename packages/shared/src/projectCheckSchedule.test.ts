// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  describeCheckSchedule,
  isValidTimeZone,
  nextCheckRunAt,
  normalizeCheckSchedule,
  zonedWallTimeToEpochMs,
} from "./projectCheckSchedule.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("normalizeCheckSchedule", () => {
  it("raises intervals below 15 minutes and lowers ones above a week", () => {
    expect(normalizeCheckSchedule({ kind: "interval", everyMinutes: 5 })).toEqual({
      kind: "interval",
      everyMinutes: 15,
    });
    expect(normalizeCheckSchedule({ kind: "interval", everyMinutes: 99_999 })).toEqual({
      kind: "interval",
      everyMinutes: 7 * 24 * 60,
    });
    const daily = { kind: "daily", time: "09:00" } as const;
    expect(normalizeCheckSchedule(daily)).toBe(daily);
  });
});

describe("nextCheckRunAt", () => {
  it("counts intervals from the anchor, clamped to the minimum", () => {
    const anchor = at("2026-05-01T10:00:00.000Z");
    expect(iso(nextCheckRunAt({ kind: "interval", everyMinutes: 60 }, anchor, "UTC"))).toBe(
      "2026-05-01T11:00:00.000Z",
    );
    expect(iso(nextCheckRunAt({ kind: "interval", everyMinutes: 1 }, anchor, "UTC"))).toBe(
      "2026-05-01T10:15:00.000Z",
    );
  });

  it("runs daily later today, or tomorrow once today's time has passed", () => {
    const schedule = { kind: "daily", time: "09:00" } as const;
    expect(iso(nextCheckRunAt(schedule, at("2026-05-01T08:59:00.000Z"), "UTC"))).toBe(
      "2026-05-01T09:00:00.000Z",
    );
    // Strictly after: a run at 09:00 schedules the next one for tomorrow.
    expect(iso(nextCheckRunAt(schedule, at("2026-05-01T09:00:00.000Z"), "UTC"))).toBe(
      "2026-05-02T09:00:00.000Z",
    );
  });

  it("uses the zone's wall clock", () => {
    // 09:00 in Berlin (UTC+2 in May) is 07:00Z.
    expect(
      iso(
        nextCheckRunAt(
          { kind: "daily", time: "09:00" },
          at("2026-05-01T00:00:00.000Z"),
          "Europe/Berlin",
        ),
      ),
    ).toBe("2026-05-01T07:00:00.000Z");
  });

  it("finds the next matching weekday", () => {
    // 2026-05-06 is a Wednesday; the next Monday is 2026-05-11.
    const monday = { kind: "weekly", weekday: 1, time: "09:00" } as const;
    expect(iso(nextCheckRunAt(monday, at("2026-05-06T12:00:00.000Z"), "UTC"))).toBe(
      "2026-05-11T09:00:00.000Z",
    );
    // From Monday's run itself, a week later.
    expect(iso(nextCheckRunAt(monday, at("2026-05-11T09:00:00.000Z"), "UTC"))).toBe(
      "2026-05-18T09:00:00.000Z",
    );
    // Earlier the same Monday: that day.
    expect(iso(nextCheckRunAt(monday, at("2026-05-11T08:00:00.000Z"), "UTC"))).toBe(
      "2026-05-11T09:00:00.000Z",
    );
  });

  describe("daylight saving (America/New_York, 2026)", () => {
    const zone = "America/New_York";

    it("keeps the wall-clock time across the spring change", () => {
      // 09:00 EST on Mar 7 is 14:00Z; 09:00 EDT on Mar 8 is 13:00Z.
      expect(
        iso(nextCheckRunAt({ kind: "daily", time: "09:00" }, at("2026-03-07T14:00:00.000Z"), zone)),
      ).toBe("2026-03-08T13:00:00.000Z");
    });

    it("runs a time inside the spring-forward gap an hour later", () => {
      // 02:30 doesn't exist on Mar 8; it runs at 03:30 EDT (07:30Z).
      expect(
        iso(nextCheckRunAt({ kind: "daily", time: "02:30" }, at("2026-03-07T17:00:00.000Z"), zone)),
      ).toBe("2026-03-08T07:30:00.000Z");
    });

    it("runs a repeated fall-back time at its first occurrence, once", () => {
      // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST) on Nov 1.
      const schedule = { kind: "daily", time: "01:30" } as const;
      const first = nextCheckRunAt(schedule, at("2026-10-31T16:00:00.000Z"), zone);
      expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
      // The second 01:30 is not a second run; the next one is Nov 2.
      expect(iso(nextCheckRunAt(schedule, first, zone))).toBe("2026-11-02T06:30:00.000Z");
    });
  });
});

describe("zonedWallTimeToEpochMs", () => {
  it("maps ordinary wall times", () => {
    expect(
      iso(
        zonedWallTimeToEpochMs(
          { year: 2026, month: 1, day: 15, hour: 12, minute: 0 },
          "America/New_York",
        ),
      ),
    ).toBe("2026-01-15T17:00:00.000Z");
  });
});

describe("describeCheckSchedule", () => {
  it.each([
    [{ kind: "interval", everyMinutes: 30 }, "Every 30 minutes"],
    [{ kind: "interval", everyMinutes: 60 }, "Every hour"],
    [{ kind: "interval", everyMinutes: 360 }, "Every 6 hours"],
    [{ kind: "interval", everyMinutes: 1440 }, "Every day"],
    [{ kind: "interval", everyMinutes: 5 }, "Every 15 minutes"],
    [{ kind: "daily", time: "07:30" }, "Daily at 07:30"],
    [{ kind: "weekly", weekday: 1, time: "09:00" }, "Weekly on Monday at 09:00"],
  ] as const)("%j reads %s", (schedule, words) => {
    expect(describeCheckSchedule(schedule)).toBe(words);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
