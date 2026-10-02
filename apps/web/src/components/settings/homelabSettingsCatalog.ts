/**
 * Homelab settings shell policy: which settings pages the nav lists (and in
 * what order), which upstream pages and rows are hidden, and the search
 * entries for the fork pages. Upstream's settings files read it through
 * one-line hooks (`SettingsSidebarNav`, `useAvailableSettingsSearchItems`,
 * `SettingsScopeSentence`).
 */
import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
  shouldShowPrimarySourceControlUi,
  shouldShowSidebarProjectGroupingControls,
} from "../../productCapabilities";
import { shouldShowMultiEnvironmentConnections } from "./homelabConnections";
import type { SettingsPath, SettingsSearchItem } from "./settingsSearch";

export type HomelabSettingsPath =
  | "/settings/secrets"
  | "/settings/notifications"
  | "/settings/project-runtime"
  | "/settings/memory"
  | "/settings/advanced";

export const HOMELAB_SETTINGS_SECTION_LABELS: Readonly<Record<HomelabSettingsPath, string>> = {
  "/settings/secrets": "Secrets",
  "/settings/notifications": "Notifications",
  "/settings/project-runtime": HOMELAB_PRODUCT_COPY.projectRuntime.title,
  "/settings/memory": HOMELAB_PRODUCT_COPY.settings.memoryAndKnowledge,
  "/settings/advanced": HOMELAB_PRODUCT_COPY.settings.advanced,
};

/**
 * Nav order. Keybindings, Integrations, Archive and Diagnostics stay
 * reachable from Advanced and search; Source Control and Storage (git
 * worktrees) are hidden with the source-control UI.
 */
const HOMELAB_SETTINGS_NAV: ReadonlyArray<{ readonly to: SettingsPath; readonly label?: string }> =
  [
    { to: "/settings/general" },
    { to: "/settings/appearance" },
    { to: "/settings/projects" },
    { to: "/settings/providers" },
    { to: "/settings/secrets" },
    { to: "/settings/notifications" },
    { to: "/settings/connections", label: HOMELAB_PRODUCT_COPY.settings.devicesAndSessions },
    { to: "/settings/project-runtime" },
    { to: "/settings/memory" },
    { to: "/settings/snap-shot" },
    { to: "/settings/advanced" },
  ];

/** Settings pages whose every row is upstream source-control or worktree state. */
const SOURCE_CONTROL_SETTINGS_PATHS: ReadonlySet<SettingsPath> = new Set([
  "/settings/source-control",
  "/settings/storage",
]);

/** Upstream General rows the homelab product hides; their search entries go too. */
function hiddenSettingsSearchIds(): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!shouldShowPrimarySourceControlUi()) {
    hidden.add("hide-whitespace-changes");
    hidden.add("start-from-origin");
    hidden.add("worktree-submodules");
  }
  if (!shouldShowCompatibilityHostPathProjectUi()) {
    hidden.add("add-project-starts-in");
  }
  if (!shouldShowSidebarProjectGroupingControls()) {
    hidden.add("project-grouping");
  }
  if (!shouldShowPrimarySourceControlUi()) {
    hidden.add("github-routing");
  }
  if (!shouldShowMultiEnvironmentConnections()) {
    hidden.add("remote-environments");
    hidden.add("load-balancing");
  }
  return hidden;
}

interface PullRequestCapabilityEnvironment {
  readonly serverConfig: {
    readonly environment: { readonly capabilities: { readonly pullRequests?: boolean } };
  } | null;
}

/**
 * Whether any of these environments tracks pull requests. "Auto-settle merged
 * threads" only acts on merged pull requests, so its row and search entry are
 * hidden when none does (the homelab server disables pull requests).
 */
export function environmentsSupportPullRequests(
  environments: ReadonlyArray<PullRequestCapabilityEnvironment>,
): boolean {
  return environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
}

export function isHomelabSettingsPathVisible(path: SettingsPath): boolean {
  return shouldShowPrimarySourceControlUi() || !SOURCE_CONTROL_SETTINGS_PATHS.has(path);
}

export function isHomelabSettingsSearchIdVisible(id: string): boolean {
  return !hiddenSettingsSearchIds().has(id);
}

/** Maps upstream's derived nav list onto the homelab order and labels. */
export function homelabSettingsNavItems<T extends { readonly to: SettingsPath; label: string }>(
  upstreamItems: ReadonlyArray<T>,
): T[] {
  const byPath = new Map(upstreamItems.map((item) => [item.to, item] as const));
  return HOMELAB_SETTINGS_NAV.flatMap((entry) => {
    const item = byPath.get(entry.to);
    if (!item || !isHomelabSettingsPathVisible(entry.to)) return [];
    return [entry.label ? { ...item, label: entry.label } : item];
  });
}

/** Search entries for the fork pages; they have no anchors of their own. */
export const HOMELAB_SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "secrets",
    title: "Secrets",
    to: "/settings/secrets",
    searchTerms: [
      "secret references credentials tokens passwords broker brokered delivery allowed hosts egress activity write approvals",
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    to: "/settings/notifications",
    searchTerms: [
      "ntfy push alerts phone approvals questions failed turns scheduled checks time zone",
    ],
  },
  {
    id: "project-runtime",
    title: HOMELAB_PRODUCT_COPY.projectRuntime.title,
    to: "/settings/project-runtime",
    searchTerms: ["runtime container cli updates provider versions ownership"],
  },
  {
    id: "memory-and-knowledge",
    title: HOMELAB_PRODUCT_COPY.settings.memoryAndKnowledge,
    to: "/settings/memory",
    searchTerms: ["curator knowledge graph memory skills estate bootstrap tidy schedule"],
  },
  {
    id: "advanced",
    title: HOMELAB_PRODUCT_COPY.settings.advanced,
    to: "/settings/advanced",
    searchTerms: ["archived keybindings integrations diagnostics"],
  },
];

/** Upstream's available search items plus the fork pages, minus hidden surfaces. */
export function withHomelabSettingsSearchItems(
  items: ReadonlyArray<SettingsSearchItem>,
  options: { readonly environments?: ReadonlyArray<PullRequestCapabilityEnvironment> } = {},
): ReadonlyArray<SettingsSearchItem> {
  const hiddenIds = new Set(hiddenSettingsSearchIds());
  if (options.environments && !environmentsSupportPullRequests(options.environments)) {
    hiddenIds.add("auto-settle-merged-threads");
  }
  return [...items, ...HOMELAB_SETTINGS_SEARCH_ITEMS].filter(
    (item) => isHomelabSettingsPathVisible(item.to) && !hiddenIds.has(item.id),
  );
}

/** Fork pages are server-global; they have no project/environment scope to pick. */
export const HOMELAB_UNSCOPED_SETTINGS_PATHS: ReadonlyArray<HomelabSettingsPath> = [
  "/settings/secrets",
  "/settings/notifications",
  "/settings/project-runtime",
  "/settings/memory",
  "/settings/advanced",
];
