/**
 * The first message of a project's survey thread ("Survey: <project>"): an
 * agent investigates what the user said the project covers, from inside the
 * project runtime, and records what it learns for later threads.
 *
 * @module surveyPrompt
 */

/** Longest title prefix kept in a survey thread's title. */
const SURVEY_TITLE_MAX_LENGTH = 120;

export function surveyThreadTitle(projectTitle: string): string {
  const title = `Survey: ${projectTitle.trim() || "project"}`;
  return title.length > SURVEY_TITLE_MAX_LENGTH
    ? `${title.slice(0, SURVEY_TITLE_MAX_LENGTH - 1)}…`
    : title;
}

/** Blank or whitespace-only descriptions count as none. */
export function normalizeProjectDescription(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

export function buildProjectSurveyPrompt(input: {
  readonly projectTitle: string;
  readonly description: string | null;
}): string {
  const description = normalizeProjectDescription(input.description);
  const scope =
    description === null
      ? [
          `This is a new homelab project, "${input.projectTitle}", and the user hasn't said what it covers yet.`,
          "Start by asking the user which hosts and services it covers, and how to reach them. Meanwhile, inspect the runtime itself (network, DNS, mounted configs) for clues, but don't guess what belongs to the project.",
        ]
      : [
          `This is a new homelab project, "${input.projectTitle}". The user describes what it covers as:`,
          "",
          ...description.split("\n").map((line) => `> ${line}`),
        ];
  return [
    ...scope,
    "",
    "Survey it from inside this project's runtime so later threads start from facts instead of guesses:",
    "- For each host and service: is it reachable (DNS, ping, ports), what is running and which versions, and which configs, logs, or APIs you can read.",
    "- Note how each is reached (addresses, ports, URLs, paths) and what it depends on.",
    "- Look things up on the web when local evidence isn't enough to identify something.",
    "- When access is missing (credentials, SSH keys, a firewall), ask the user rather than guessing. Use `homelab_secret_request` for a credential instead of asking for it in chat.",
    "- Don't change anything: this is a read-only survey.",
    "",
    "Record what you learn as you go:",
    "- `homelab_memory_add` for project findings, gotchas, and how to reach things.",
    "- `homelab_entity_record` for each host, service, and the relations between them, in the knowledge graph.",
    "- `homelab_entity_verify` for graph entries you confirmed against the live system.",
    "",
    "Finish with a short summary: what you found, what you recorded, and what you couldn't reach or still need from the user.",
  ].join("\n");
}
