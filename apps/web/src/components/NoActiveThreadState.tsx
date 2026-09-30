import { HomelabHomeOverview } from "./homelab/HomelabHomeOverview";

/**
 * Homelab fork: the no-thread state is the homelab home page (what needs you,
 * running work, projects, recent threads) instead of upstream's "Pick a
 * thread to continue" empty state.
 */
export function NoActiveThreadState() {
  return <HomelabHomeOverview />;
}
