import { describe, expect, it } from "vite-plus/test";

import {
  CHECK_TEMPLATES,
  checkDraftFromTemplate,
  checkInputFromDraft,
  checkStatusBadge,
  DEFAULT_SCHEDULE_DRAFT,
  EMPTY_CHECK_DRAFT,
  scheduleDraftFrom,
  scheduleFromDraft,
} from "./projectChecks";

describe("scheduleFromDraft", () => {
  it("builds each schedule form", () => {
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE_DRAFT, kind: "interval", every: "2", unit: "hours" }),
    ).toEqual({ schedule: { kind: "interval", everyMinutes: 120 } });
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE_DRAFT, kind: "daily", time: "06:30" })).toEqual({
      schedule: { kind: "daily", time: "06:30" },
    });
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE_DRAFT, kind: "weekly", weekday: 5, time: "18:00" }),
    ).toEqual({ schedule: { kind: "weekly", weekday: 5, time: "18:00" } });
  });

  it("refuses intervals under 15 minutes, over a week, and bad numbers", () => {
    const interval = { ...DEFAULT_SCHEDULE_DRAFT, kind: "interval" as const };
    expect(scheduleFromDraft({ ...interval, every: "10", unit: "minutes" })).toHaveProperty(
      "error",
    );
    expect(scheduleFromDraft({ ...interval, every: "169", unit: "hours" })).toHaveProperty("error");
    expect(scheduleFromDraft({ ...interval, every: "1.5", unit: "hours" })).toHaveProperty("error");
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE_DRAFT, time: "" })).toHaveProperty("error");
  });

  it("round-trips through the draft", () => {
    for (const template of CHECK_TEMPLATES) {
      expect(scheduleFromDraft(scheduleDraftFrom(template.schedule))).toEqual({
        schedule: template.schedule,
      });
    }
    expect(scheduleDraftFrom({ kind: "interval", everyMinutes: 45 })).toMatchObject({
      every: "45",
      unit: "minutes",
    });
  });
});

describe("checkInputFromDraft", () => {
  it("needs a name and a prompt, and trims both", () => {
    expect(checkInputFromDraft(EMPTY_CHECK_DRAFT)).toHaveProperty("error");
    const template = CHECK_TEMPLATES[0]!;
    const draft = checkDraftFromTemplate(EMPTY_CHECK_DRAFT, template);
    expect(checkInputFromDraft({ ...draft, name: `  ${draft.name}  ` })).toEqual({
      input: {
        name: template.name,
        prompt: template.prompt,
        schedule: template.schedule,
        notifyPolicy: "attention",
      },
    });
  });
});

describe("checkStatusBadge", () => {
  it("prefers running, then the last result", () => {
    expect(checkStatusBadge({ running: true, lastStatus: "failed", enabled: true }).label).toBe(
      "Running",
    );
    expect(checkStatusBadge({ running: false, lastStatus: "attention", enabled: true })).toEqual({
      label: "Needs attention",
      variant: "warning",
    });
    expect(checkStatusBadge({ running: false, lastStatus: null, enabled: false }).label).toBe(
      "Off",
    );
  });
});
