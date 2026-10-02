import { describe, expect, it } from "vite-plus/test";

import {
  curatorTidyDraftFrom,
  curatorTidyInputFromDraft,
  DEFAULT_CURATOR_TIDY_SCHEDULE,
} from "./curatorTidy";
import { CHECK_TEMPLATES } from "./projectChecks";
import {
  normalizeProjectDescriptionInput,
  ONBOARDING_CHECK_TEMPLATE_ID,
  resolveSurveyChoice,
  shouldShowProjectOnboarding,
} from "./projectOnboarding";

describe("resolveSurveyChoice", () => {
  it("follows the description until the user picks", () => {
    expect(resolveSurveyChoice("", null)).toBe(false);
    expect(resolveSurveyChoice("   ", null)).toBe(false);
    expect(resolveSurveyChoice("NAS at nas.lan", null)).toBe(true);
    expect(resolveSurveyChoice("NAS at nas.lan", false)).toBe(false);
    expect(resolveSurveyChoice("", true)).toBe(true);
  });

  it("normalizes blank descriptions to none", () => {
    expect(normalizeProjectDescriptionInput(" \n ")).toBeNull();
    expect(normalizeProjectDescriptionInput("  Jellyfin  ")).toBe("Jellyfin");
  });
});

describe("shouldShowProjectOnboarding", () => {
  it("shows only once both memory and checks loaded empty", () => {
    expect(shouldShowProjectOnboarding({ memory: "empty", checks: "empty" })).toBe(true);
    expect(shouldShowProjectOnboarding({ memory: "ready", checks: "empty" })).toBe(false);
    expect(shouldShowProjectOnboarding({ memory: "empty", checks: "ready" })).toBe(false);
    expect(shouldShowProjectOnboarding({ memory: "loading", checks: "empty" })).toBe(false);
    expect(shouldShowProjectOnboarding({ memory: "empty", checks: "error" })).toBe(false);
  });

  it("opens the checks editor on an existing template", () => {
    expect(CHECK_TEMPLATES.some((template) => template.id === ONBOARDING_CHECK_TEMPLATE_ID)).toBe(
      true,
    );
  });
});

describe("curator tidy draft", () => {
  it("reads off with no stored tidy, on the default slot", () => {
    expect(curatorTidyDraftFrom(null)).toEqual({ mode: "off", weekday: 0, time: "03:00" });
  });

  it("round-trips a stored weekly tidy", () => {
    const draft = curatorTidyDraftFrom({
      enabled: true,
      schedule: { kind: "weekly", weekday: 3, time: "22:15" },
    });
    expect(draft).toEqual({ mode: "weekly", weekday: 3, time: "22:15" });
    expect(curatorTidyInputFromDraft(draft)).toEqual({
      input: { enabled: true, schedule: { kind: "weekly", weekday: 3, time: "22:15" } },
    });
  });

  it("keeps the slot when switched off, and refuses a bad time", () => {
    const off = curatorTidyDraftFrom({
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
    });
    expect(off).toEqual({
      mode: "off",
      weekday: DEFAULT_CURATOR_TIDY_SCHEDULE.weekday,
      time: "03:00",
    });
    expect(curatorTidyInputFromDraft(off)).toEqual({
      input: { enabled: false, schedule: DEFAULT_CURATOR_TIDY_SCHEDULE },
    });
    expect(curatorTidyInputFromDraft({ ...off, time: "" })).toEqual({ error: "Pick a time." });
  });
});
