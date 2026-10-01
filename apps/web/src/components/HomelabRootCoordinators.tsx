import { HomelabEgressApprovalCoordinator } from "./HomelabEgressApprovalCoordinator";
import { HomelabSecretRequestCoordinator } from "./HomelabSecretRequestCoordinator";

/**
 * Homelab prompts that can open over any page: egress write approvals and
 * secret requests. Mounted once by the root route for authenticated sessions;
 * the one seam in upstream's `__root.tsx`.
 */
export function HomelabRootCoordinators() {
  return (
    <>
      <HomelabEgressApprovalCoordinator />
      <HomelabSecretRequestCoordinator />
    </>
  );
}
