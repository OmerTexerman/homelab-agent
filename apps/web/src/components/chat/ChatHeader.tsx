import { memo } from "react";
import { FolderClosedIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";

interface ChatHeaderProps {
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  workspaceAvailable: boolean;
  workspaceOpen: boolean;
  onToggleTerminal: () => void;
  onToggleWorkspace: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadTitle,
  activeProjectName,
  terminalAvailable,
  terminalOpen,
  workspaceAvailable,
  workspaceOpen,
  onToggleTerminal,
  onToggleWorkspace,
}: ChatHeaderProps) {
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={workspaceOpen}
                onPressedChange={onToggleWorkspace}
                aria-label="Toggle workspace panel"
                variant="outline"
                size="xs"
                disabled={!workspaceAvailable}
              >
                <FolderClosedIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!workspaceAvailable
              ? "File manager is unavailable."
              : workspaceOpen
                ? "Close file manager"
                : "Open file manager"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable."
              : terminalOpen
                ? "Close terminal"
                : "Open terminal"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
