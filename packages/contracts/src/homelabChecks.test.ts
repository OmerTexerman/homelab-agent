import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectCheckCreateInput, ProjectCheckSchedule } from "./homelabChecks.ts";
import { HomelabNotificationSettingsUpdateInput } from "./homelabNotifications.ts";

const decodeSchedule = Schema.decodeUnknownExit(ProjectCheckSchedule);
const decodeCreate = Schema.decodeUnknownExit(ProjectCheckCreateInput);
const decodeSettings = Schema.decodeUnknownExit(HomelabNotificationSettingsUpdateInput);

describe("ProjectCheckSchedule", () => {
  it.each([
    { kind: "interval", everyMinutes: 30 },
    { kind: "daily", time: "09:00" },
    { kind: "weekly", weekday: 0, time: "23:59" },
  ])("accepts %j", (schedule) => {
    expect(decodeSchedule(schedule)._tag).toBe("Success");
  });

  it.each([
    { kind: "interval", everyMinutes: 0 },
    { kind: "daily", time: "9:00" },
    { kind: "daily", time: "24:00" },
    { kind: "weekly", weekday: 7, time: "08:00" },
    { kind: "cron", expression: "* * * * *" },
  ])("rejects %j", (schedule) => {
    expect(decodeSchedule(schedule)._tag).toBe("Failure");
  });
});

describe("ProjectCheckCreateInput", () => {
  it("trims the name and prompt and rejects empty ones", () => {
    const ok = decodeCreate({
      name: "  Disk  ",
      prompt: " Check disks ",
      schedule: { kind: "daily", time: "07:30" },
    });
    expect(ok._tag === "Success" ? ok.value.name : null).toBe("Disk");
    expect(
      decodeCreate({ name: " ", prompt: "x", schedule: { kind: "daily", time: "07:30" } })._tag,
    ).toBe("Failure");
  });
});

describe("HomelabNotificationSettingsUpdateInput", () => {
  it("takes http(s) topic URLs and null to clear", () => {
    expect(decodeSettings({ ntfyUrl: "https://ntfy.sh/homelab" })._tag).toBe("Success");
    expect(decodeSettings({ ntfyUrl: null, token: null })._tag).toBe("Success");
    expect(decodeSettings({ ntfyUrl: "ftp://ntfy.sh/homelab" })._tag).toBe("Failure");
    expect(decodeSettings({ ntfyUrl: "ntfy.sh/homelab" })._tag).toBe("Failure");
  });
});
