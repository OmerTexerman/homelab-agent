import { APP_DISPLAY_NAME } from "../../branding";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * Shown when an already-paired device opens a pairing link that the server
 * rejects. The device keeps its current session, so the way out is back to
 * the app.
 */
export function RePairFailedSurface(props: {
  readonly message: string;
  readonly onContinue: () => void;
}) {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pairing link not accepted"
        description="This device is still signed in with its current permissions."
      />
      <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
        {props.message}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={props.onContinue}>
          Continue to app
        </Button>
      </div>
    </StandalonePage>
  );
}
