import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { RePairFailedSurface } from "../components/homelab/RePairFailedSurface";
import {
  isPrimaryEnvironmentPairingCredentialRejectedError,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
} from "../environments/primary";
import { describeRePairFailure } from "../homelab/rePairFailure";

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
        const failure = await submitServerAuthCredential(token).then(
          () => null,
          (error: unknown) => {
            console.error("Pairing token exchange failed; keeping the current session.", error);
            return { error };
          },
        );
        if (failure === null) {
          // Hard reload so every session-state consumer picks up the
          // re-scoped session cookie.
          window.location.replace("/");
          return new Promise<never>(() => {});
        }
        return {
          authGateState,
          rePairErrorMessage: describeRePairFailure(
            failure.error,
            isPrimaryEnvironmentPairingCredentialRejectedError,
          ),
        };
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
  const routeContext = Route.useRouteContext();
  const { authGateState } = routeContext;
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "authenticated") {
    // Only reached when an already-paired device's re-pair link was rejected.
    return (
      <RePairFailedSurface
        message={
          "rePairErrorMessage" in routeContext
            ? routeContext.rePairErrorMessage
            : describeRePairFailure(null, () => false)
        }
        onContinue={() => void navigate({ to: "/", replace: true })}
      />
    );
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
