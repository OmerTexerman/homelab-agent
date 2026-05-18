import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  Code2Icon,
  DiffIcon,
  DownloadIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderTreeIcon,
  PrinterIcon,
  TerminalSquareIcon,
  TextIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverClose,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  HOMELAB_PRODUCT_COPY,
  shouldShowEditorOpenInControls,
  shouldShowPrimarySourceControlUi,
  shouldShowRuntimeWorkspaceExplorer,
} from "../../productCapabilities";
import type { ChatExportFormat } from "../../chatExport";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  workspaceExplorerAvailable: boolean;
  workspaceExplorerOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onExportChat: (format: ChatExportFormat) => void;
  onToggleTerminal: () => void;
  onToggleWorkspaceExplorer: () => void;
  onToggleDiff: () => void;
}

export const CHAT_EXPORT_FORMAT_OPTIONS: ReadonlyArray<{
  readonly format: ChatExportFormat;
  readonly label: string;
  readonly description: string;
  readonly Icon: typeof FileTextIcon;
}> = [
  {
    format: "markdown",
    label: "Markdown",
    description: "Readable transcript for docs, notes, and project memory review.",
    Icon: FileTextIcon,
  },
  {
    format: "json",
    label: "JSON",
    description: "Structured versioned data for tools, reprocessing, and audit trails.",
    Icon: FileJsonIcon,
  },
  {
    format: "text",
    label: "Plain text",
    description: "Searchable flat transcript that works anywhere.",
    Icon: TextIcon,
  },
  {
    format: "html",
    label: "HTML",
    description: "Self-contained offline page with print-friendly styling.",
    Icon: Code2Icon,
  },
  {
    format: "pdf",
    label: "PDF",
    description: "Open a print view and save to PDF from the browser.",
    Icon: PrinterIcon,
  },
];

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly editorOpenInControls?: boolean;
}): boolean {
  return (
    input.editorOpenInControls !== false &&
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  workspaceExplorerAvailable,
  workspaceExplorerOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportChat,
  onToggleTerminal,
  onToggleWorkspaceExplorer,
  onToggleDiff,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showSourceControlUi = shouldShowPrimarySourceControlUi();
  const showRuntimeWorkspaceExplorer = shouldShowRuntimeWorkspaceExplorer();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    editorOpenInControls: shouldShowEditorOpenInControls(),
  });

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
        {showSourceControlUi && activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {showSourceControlUi && activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="icon-xs"
                variant="outline"
                className="shrink-0"
                aria-label="Export chat"
                title="Export chat"
              />
            }
          >
            <DownloadIcon className="size-3" />
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-80 p-0">
            <div className="space-y-3">
              <div className="space-y-1">
                <PopoverTitle className="text-base">Export Chat</PopoverTitle>
                <PopoverDescription className="text-xs">
                  Export the full thread with messages, work logs, decisions, plans, metadata, and
                  changed files.
                </PopoverDescription>
              </div>
              <div className="grid gap-1">
                {CHAT_EXPORT_FORMAT_OPTIONS.map(({ format, label, description, Icon }) => (
                  <PopoverClose
                    key={format}
                    render={
                      <button
                        className="flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                        type="button"
                      />
                    }
                    onClick={() => onExportChat(format)}
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-xs leading-5 text-muted-foreground">
                        {description}
                      </span>
                    </span>
                  </PopoverClose>
                ))}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
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
              ? HOMELAB_PRODUCT_COPY.projectRuntime.terminalUnavailableDescription
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        {showRuntimeWorkspaceExplorer ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={workspaceExplorerOpen}
                  onPressedChange={onToggleWorkspaceExplorer}
                  aria-label="Toggle runtime workspace explorer"
                  variant="outline"
                  size="xs"
                  disabled={!workspaceExplorerAvailable}
                >
                  <FolderTreeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!workspaceExplorerAvailable
                ? HOMELAB_PRODUCT_COPY.projectRuntime.workspaceExplorerUnavailableDescription
                : "Toggle runtime workspace explorer"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {showSourceControlUi ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle diff panel"
                  variant="outline"
                  size="xs"
                  disabled={!isGitRepo && !diffOpen}
                >
                  <DiffIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!isGitRepo && !diffOpen
                ? "Diff panel is unavailable because this project is not a git repository."
                : diffToggleShortcutLabel
                  ? `Toggle diff panel (${diffToggleShortcutLabel})`
                  : "Toggle diff panel"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});
