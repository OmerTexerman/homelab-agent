import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type RuntimeSessionId,
  type ThreadId,
  type ThreadRuntimeMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  Code2Icon,
  DownloadIcon,
  FileJsonIcon,
  FileTextIcon,
  GitBranchPlusIcon,
  PrinterIcon,
  TextIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
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
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  HOMELAB_PRODUCT_COPY,
  shouldShowEditorOpenInControls,
  shouldShowPrimarySourceControlUi,
} from "../../productCapabilities";
import type { ChatExportFormat } from "../../chatExport";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isStandaloneThread?: boolean | undefined;
  isCuratorThread?: boolean | undefined;
  runtimeSelectionMode?: ThreadRuntimeMode | undefined;
  projectDefaultRuntimeId?: RuntimeSessionId | null | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onExportChat: (format: ChatExportFormat) => void;
}

export const CHAT_EXPORT_FORMAT_OPTIONS: ReadonlyArray<{
  readonly format: ChatExportFormat;
  readonly label: string;
  readonly description: string;
  readonly Icon: typeof FileTextIcon;
}> = [
  {
    format: "markdown",
    label: HOMELAB_PRODUCT_COPY.chatExport.formats.markdown.label,
    description: HOMELAB_PRODUCT_COPY.chatExport.formats.markdown.description,
    Icon: FileTextIcon,
  },
  {
    format: "json",
    label: HOMELAB_PRODUCT_COPY.chatExport.formats.json.label,
    description: HOMELAB_PRODUCT_COPY.chatExport.formats.json.description,
    Icon: FileJsonIcon,
  },
  {
    format: "text",
    label: HOMELAB_PRODUCT_COPY.chatExport.formats.text.label,
    description: HOMELAB_PRODUCT_COPY.chatExport.formats.text.description,
    Icon: TextIcon,
  },
  {
    format: "html",
    label: HOMELAB_PRODUCT_COPY.chatExport.formats.html.label,
    description: HOMELAB_PRODUCT_COPY.chatExport.formats.html.description,
    Icon: Code2Icon,
  },
  {
    format: "pdf",
    label: HOMELAB_PRODUCT_COPY.chatExport.formats.pdf.label,
    description: HOMELAB_PRODUCT_COPY.chatExport.formats.pdf.description,
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

export function describeActiveThreadRuntimeMode(input: {
  readonly runtimeSelectionMode?: ThreadRuntimeMode | undefined;
  readonly isStandaloneThread?: boolean | undefined;
  readonly isCuratorThread?: boolean | undefined;
  readonly activeProjectName?: string | undefined;
  readonly projectDefaultRuntimeId?: RuntimeSessionId | null | undefined;
}): string | null {
  if (input.isCuratorThread) {
    return input.runtimeSelectionMode === "isolated"
      ? HOMELAB_PRODUCT_COPY.curator.activeThreadBadgeDescription
      : null;
  }

  if (input.isStandaloneThread) {
    return input.runtimeSelectionMode === "isolated"
      ? HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeDescription
      : null;
  }

  if (input.runtimeSelectionMode !== "isolated") {
    return null;
  }

  const sourceRuntime = input.activeProjectName
    ? `${input.activeProjectName}'s Project Runtime`
    : "the Project Runtime";
  const sourceId = input.projectDefaultRuntimeId
    ? ` Source runtime: ${input.projectDefaultRuntimeId}.`
    : "";

  return `This thread uses an isolated clone of ${sourceRuntime}. Shared runtime files stay separate unless you explicitly promote or copy work back.${sourceId}`;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isStandaloneThread,
  isCuratorThread,
  runtimeSelectionMode,
  projectDefaultRuntimeId,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportChat,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showSourceControlUi = shouldShowPrimarySourceControlUi();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    editorOpenInControls: shouldShowEditorOpenInControls(),
  });
  const isolatedRuntimeDescription = describeActiveThreadRuntimeMode({
    runtimeSelectionMode,
    isStandaloneThread,
    isCuratorThread,
    activeProjectName,
    projectDefaultRuntimeId,
  });
  const runtimeModeBadgeLabel = isCuratorThread
    ? HOMELAB_PRODUCT_COPY.curator.activeThreadBadgeLabel
    : isStandaloneThread
      ? HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeLabel
      : HOMELAB_PRODUCT_COPY.projectRuntime.activeIsolatedThreadBadgeLabel;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
        {isolatedRuntimeDescription ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="outline"
                  className="shrink-0 gap-1 border-info/35 bg-info/10 text-info-foreground"
                >
                  <GitBranchPlusIcon className="size-3" />
                  <span>{runtimeModeBadgeLabel}</span>
                </Badge>
              }
            />
            <TooltipPopup side="bottom" className="max-w-80 leading-tight">
              {isolatedRuntimeDescription}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
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
            environmentId={activeThreadEnvironmentId}
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
                aria-label={HOMELAB_PRODUCT_COPY.chatExport.action}
                title={HOMELAB_PRODUCT_COPY.chatExport.action}
              />
            }
          >
            <DownloadIcon className="size-3" />
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-80 p-0">
            <div className="space-y-3">
              <div className="space-y-1">
                <PopoverTitle className="text-base">
                  {HOMELAB_PRODUCT_COPY.chatExport.title}
                </PopoverTitle>
                <PopoverDescription className="text-xs">
                  {HOMELAB_PRODUCT_COPY.chatExport.description}
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
      </div>
    </div>
  );
});
