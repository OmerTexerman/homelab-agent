import { HomeOverviewPage } from "./homelab/HomeOverviewSurface";

/**
 * Homelab fork: the no-thread state is the homelab home overview (recent
 * activity, decisions waiting, runtimes, readiness, knowledge) instead of
 * upstream's "Pick a thread to continue" empty state.
 */
export function NoActiveThreadState() {
  return <HomeOverviewPage />;
}
