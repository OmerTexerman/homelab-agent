import { assert, describe, it } from "@effect/vitest";

import {
  buildProjectSurveyPrompt,
  normalizeProjectDescription,
  surveyThreadTitle,
} from "./surveyPrompt.ts";

describe("buildProjectSurveyPrompt", () => {
  it("quotes the description and names the tools to record findings with", () => {
    const prompt = buildProjectSurveyPrompt({
      projectTitle: "Media",
      description: "Jellyfin, Sonarr on the media VM 192.168.1.40\nNAS at nas.lan",
    });
    assert.include(prompt, '"Media"');
    assert.include(prompt, "> Jellyfin, Sonarr on the media VM 192.168.1.40\n> NAS at nas.lan");
    for (const tool of ["homelab_memory_add", "homelab_entity_record", "homelab_entity_verify"]) {
      assert.include(prompt, tool);
    }
    assert.include(prompt, "ask the user rather than guessing");
    assert.include(prompt, "Finish with a short summary");
    assert.notInclude(prompt, "hasn't said what it covers");
  });

  it("asks what the project covers when there is no description", () => {
    for (const description of [null, "", "   \n "]) {
      const prompt = buildProjectSurveyPrompt({ projectTitle: "Media", description });
      assert.include(prompt, "hasn't said what it covers");
      assert.include(prompt, "Start by asking the user");
      assert.notInclude(prompt, "> ");
    }
  });
});

describe("survey helpers", () => {
  it("normalizes blank descriptions to none", () => {
    assert.isNull(normalizeProjectDescription(undefined));
    assert.isNull(normalizeProjectDescription("  "));
    assert.equal(normalizeProjectDescription("  NAS at nas.lan \n"), "NAS at nas.lan");
  });

  it("titles the thread after the project, within bounds", () => {
    assert.equal(surveyThreadTitle("Media"), "Survey: Media");
    assert.equal(surveyThreadTitle("  "), "Survey: project");
    const long = surveyThreadTitle("x".repeat(300));
    assert.equal(long.length, 120);
    assert.isTrue(long.endsWith("…"));
  });
});
