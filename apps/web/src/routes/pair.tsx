import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { submitServerAuthCredential, takePairingTokenFromUrl } from "../environments/primary";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (authGateState.status === "authenticated") {
      // An already-paired device may follow a fresh pairing link to re-scope
      // its session (for example to regain access:write). Consume the token
      // instead of bouncing to the app with the old session.
      const token = takePairingTokenFromUrl();
      if (token !== null) {
        const submitted = await submitServerAuthCredential(token).then(
          () => true,
          (error: unknown) => {
            console.error("Pairing token exchange failed; keeping the current session.", error);
            return false;
          },
        );
        if (submitted) {
          // Hard reload so every session-state consumer picks up the
          // re-scoped session cookie.
          window.location.replace("/");
          return new Promise<never>(() => {});
        }
      }
      throw redirect({ to: "/", replace: true });
    }

    if (authGateState.status === "hosted-static") {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        void navigate({ to: "/", replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
