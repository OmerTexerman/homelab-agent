import type { EnvironmentId, ThreadId, ThreadWorkspaceEntry } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FolderClosedIcon,
  FolderIcon,
  LoaderIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { resolveEnvironmentHttpUrl } from "~/environments/runtime";
import {
  threadWorkspaceEntriesQueryOptions,
  threadWorkspaceQueryKeys,
  threadWorkspaceReadFileQueryOptions,
} from "~/lib/threadWorkspaceReactQuery";
import { cn } from "~/lib/utils";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

interface ThreadWorkspaceTreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: ThreadWorkspaceEntry["kind"];
  readonly parentPath?: string;
  readonly sizeBytes?: number;
  readonly children: ThreadWorkspaceTreeNode[];
}

function buildThreadWorkspaceTree(
  entries: ReadonlyArray<ThreadWorkspaceEntry>,
): ReadonlyArray<ThreadWorkspaceTreeNode> {
  const sortedEntries = [...entries].toSorted((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });

  const nodesByPath = new Map<string, ThreadWorkspaceTreeNode>();
  for (const entry of sortedEntries) {
    nodesByPath.set(entry.path, {
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      ...(entry.parentPath ? { parentPath: entry.parentPath } : {}),
      ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
      children: [],
    });
  }

  const rootNodes: ThreadWorkspaceTreeNode[] = [];
  for (const entry of sortedEntries) {
    const node = nodesByPath.get(entry.path);
    if (!node) {
      continue;
    }
    const parent = entry.parentPath ? nodesByPath.get(entry.parentPath) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownload(url: string, filename?: string) {
  const link = document.createElement("a");
  link.href = url;
  if (filename) {
    link.download = filename;
  }
  document.body.append(link);
  link.click();
  link.remove();
}

function WorkspaceContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly onSelect: () => void;
  }>;
  readonly onClose: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-50 min-w-36 rounded-lg border border-border bg-popover p-1 shadow-xl"
        style={{ left: x, top: y }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

const WorkspaceTreeItem = memo(function WorkspaceTreeItem(props: {
  readonly node: ThreadWorkspaceTreeNode;
  readonly depth: number;
  readonly expandedDirectories: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly theme: "light" | "dark";
  readonly onToggleDirectory: (path: string) => void;
  readonly onSelectNode: (node: ThreadWorkspaceTreeNode) => void;
  readonly onContextMenu: (event: React.MouseEvent, node: ThreadWorkspaceTreeNode) => void;
}) {
  const isDirectory = props.node.kind === "directory";
  const isExpanded = props.expandedDirectories.has(props.node.path);
  const isSelected = props.selectedPath === props.node.path;
  const indent = 10 + props.depth * 14;

  return (
    <>
      <button
        type="button"
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs transition-colors",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
        style={{ paddingLeft: indent }}
        onClick={() => {
          props.onSelectNode(props.node);
          if (isDirectory) {
            props.onToggleDirectory(props.node.path);
          }
        }}
        onContextMenu={(event) => props.onContextMenu(event, props.node)}
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70" />
          )
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {isDirectory ? (
          isExpanded ? (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          )
        ) : (
          <VscodeEntryIcon
            pathValue={props.node.path}
            kind="file"
            theme={props.theme}
            className="size-3.5"
          />
        )}
        <span className="min-w-0 flex-1 truncate">{props.node.name}</span>
      </button>
      {isDirectory && isExpanded
        ? props.node.children.map((child) => (
            <WorkspaceTreeItem
              key={child.path}
              node={child}
              depth={props.depth + 1}
              expandedDirectories={props.expandedDirectories}
              selectedPath={props.selectedPath}
              theme={props.theme}
              onToggleDirectory={props.onToggleDirectory}
              onSelectNode={props.onSelectNode}
              onContextMenu={props.onContextMenu}
            />
          ))
        : null}
    </>
  );
});

export const ThreadWorkspacePanel = memo(function ThreadWorkspacePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly resolvedTheme: "light" | "dark";
}) {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<ThreadWorkspaceEntry["kind"] | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [syncedFilePath, setSyncedFilePath] = useState<string | null>(null);
  const [treeInitialized, setTreeInitialized] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly node: ThreadWorkspaceTreeNode;
  } | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;

  useEffect(() => {
    setSearchQuery("");
    setExpandedDirectories(new Set());
    setSelectedPath(null);
    setSelectedKind(null);
    setEditorValue("");
    setSavedValue("");
    setSyncedFilePath(null);
    setTreeInitialized(false);
    setContextMenu(null);
  }, [props.environmentId, props.threadId]);

  const entriesQuery = useQuery(
    threadWorkspaceEntriesQueryOptions({
      environmentId: props.environmentId,
      threadId: props.threadId,
      query: searchQuery.trim(),
      enabled: props.open,
      limit: 1_000,
    }),
  );

  const tree = useMemo(
    () => buildThreadWorkspaceTree(entriesQuery.data?.entries ?? []),
    [entriesQuery.data?.entries],
  );

  useEffect(() => {
    if (treeInitialized || searchQuery.trim().length > 0 || tree.length === 0) {
      return;
    }
    setExpandedDirectories(
      new Set(tree.filter((node) => node.kind === "directory").map((node) => node.path)),
    );
    setTreeInitialized(true);
  }, [searchQuery, tree, treeInitialized]);

  const fileQuery = useQuery(
    threadWorkspaceReadFileQueryOptions({
      environmentId: props.environmentId,
      threadId: props.threadId,
      path: selectedKind === "file" ? selectedPath : null,
      enabled: props.open && selectedKind === "file" && selectedPath !== null,
    }),
  );

  useEffect(() => {
    if (!fileQuery.data || selectedKind !== "file" || fileQuery.data.path !== selectedPath) {
      return;
    }
    if (syncedFilePath === fileQuery.data.path) {
      return;
    }
    const nextValue = fileQuery.data.contents ?? "";
    setEditorValue(nextValue);
    setSavedValue(nextValue);
    setSyncedFilePath(fileQuery.data.path);
  }, [fileQuery.data, selectedKind, selectedPath, syncedFilePath]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selectNode = useCallback((node: ThreadWorkspaceTreeNode) => {
    setSelectedPath(node.path);
    setSelectedKind(node.kind);
    setContextMenu(null);
    if (node.parentPath) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.add(node.parentPath!);
        return next;
      });
    }
    if (node.kind === "file") {
      setSyncedFilePath(null);
    }
  }, []);

  const refreshWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadWorkspaceQueryKeys.all });
  }, [queryClient]);

  const downloadFile = useCallback(
    async (path: string) => {
      try {
        const downloadUrl = resolveEnvironmentHttpUrl({
          environmentId: props.environmentId,
          pathname: "/api/thread-workspace/file",
          searchParams: {
            threadId: props.threadId,
            path,
          },
        });
        const filename = path.split("/").pop() ?? path;
        triggerDownload(downloadUrl, filename);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to download file",
          description: error instanceof Error ? error.message : "Unknown download error.",
        });
      }
    },
    [props.environmentId, props.threadId],
  );

  const saveMutation = useMutation({
    mutationFn: async (contents: string) => {
      if (!selectedPathRef.current) {
        throw new Error("Select a file before saving.");
      }
      const api = ensureEnvironmentApi(props.environmentId);
      return api.threadWorkspace.writeFile({
        threadId: props.threadId,
        path: selectedPathRef.current,
        contents,
      });
    },
    onSuccess: async () => {
      setSavedValue(editorValue);
      if (selectedPathRef.current) {
        setSyncedFilePath(selectedPathRef.current);
      }
      await queryClient.invalidateQueries({ queryKey: threadWorkspaceQueryKeys.all });
      toastManager.add({
        type: "success",
        title: "Workspace file saved",
        description: selectedPathRef.current ?? undefined,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to save file",
        description: error instanceof Error ? error.message : "Unknown save error.",
      });
    },
  });

  const isDirty = selectedKind === "file" && editorValue !== savedValue;
  const selectedFileUnsupported =
    selectedKind === "file" ? fileQuery.data?.contents === null : false;
  const selectedFileSize =
    selectedKind === "file" ? (fileQuery.data?.sizeBytes ?? undefined) : undefined;

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) {
      return [];
    }
    const items: Array<{ id: string; label: string; onSelect: () => void }> = [];
    if (contextMenu.node.kind === "file") {
      items.push({
        id: "open",
        label: "Open",
        onSelect: () => selectNode(contextMenu.node),
      });
      items.push({
        id: "download",
        label: "Download",
        onSelect: () => {
          void downloadFile(contextMenu.node.path);
        },
      });
    } else {
      items.push({
        id: "toggle",
        label: expandedDirectories.has(contextMenu.node.path) ? "Collapse" : "Expand",
        onSelect: () => toggleDirectory(contextMenu.node.path),
      });
    }
    return items;
  }, [contextMenu, downloadFile, expandedDirectories, selectNode, toggleDirectory]);

  return (
    <aside className="flex min-h-0 w-[420px] min-w-[320px] max-w-[48vw] shrink-0 border-l border-border bg-background/96">
      <div className="flex min-h-0 w-[44%] min-w-[190px] flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Workspace</div>
            <div className="truncate text-[11px] text-muted-foreground">{props.threadId}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            onClick={refreshWorkspace}
            disabled={entriesQuery.isFetching}
            aria-label="Refresh workspace"
          >
            {entriesQuery.isFetching ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            onClick={props.onClose}
            aria-label="Close workspace panel"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="border-b border-border px-3 py-2">
          <label className="relative block">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search files"
              className="pl-7 text-xs"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {entriesQuery.isLoading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <LoaderIcon className="size-3.5 animate-spin" />
              Loading workspace
            </div>
          ) : entriesQuery.isError ? (
            <div className="px-2 py-3 text-xs text-destructive">
              {entriesQuery.error instanceof Error
                ? entriesQuery.error.message
                : "Unable to load workspace files."}
            </div>
          ) : tree.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {searchQuery.trim().length > 0
                ? "No files match that search."
                : "This thread workspace is empty."}
            </div>
          ) : (
            <>
              {tree.map((node) => (
                <WorkspaceTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedDirectories={expandedDirectories}
                  selectedPath={selectedPath}
                  theme={props.resolvedTheme}
                  onToggleDirectory={toggleDirectory}
                  onSelectNode={selectNode}
                  onContextMenu={(event, nextNode) => {
                    event.preventDefault();
                    selectNode(nextNode);
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      node: nextNode,
                    });
                  }}
                />
              ))}
              {entriesQuery.data?.truncated ? (
                <div className="px-2 pt-2 text-[11px] text-muted-foreground">
                  Workspace list truncated. Narrow the search to load less at once.
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedKind !== "file" || !selectedPath ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Select a file to view or edit it here.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <FileIcon className="size-4 shrink-0 text-muted-foreground/80" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{selectedPath}</div>
                <div className="text-[11px] text-muted-foreground">
                  {typeof selectedFileSize === "number" ? formatFileSize(selectedFileSize) : "File"}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  void downloadFile(selectedPath);
                }}
              >
                <DownloadIcon className="size-3.5" />
                Download
              </Button>
            </div>
            <div className="min-h-0 flex-1 p-3">
              {fileQuery.isLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <LoaderIcon className="size-4 animate-spin" />
                  Loading file
                </div>
              ) : fileQuery.isError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-3 text-sm text-destructive">
                  {fileQuery.error instanceof Error
                    ? fileQuery.error.message
                    : "Unable to load the selected file."}
                </div>
              ) : selectedFileUnsupported ? (
                <div className="flex h-full flex-col gap-2 rounded-lg border border-border bg-muted/20 px-4 py-4">
                  <div className="text-sm font-medium text-foreground">
                    This file cannot be edited in the browser yet.
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {fileQuery.data?.unsupportedReason ?? "Unsupported file."}
                  </div>
                </div>
              ) : (
                <Textarea
                  value={editorValue}
                  onChange={(event) => setEditorValue(event.target.value)}
                  className="h-full min-h-full resize-none font-mono text-[12px] leading-5"
                />
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
              <div className="text-[11px] text-muted-foreground">
                {isDirty ? "Unsaved changes" : "Saved"}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setEditorValue(savedValue)}
                  disabled={!isDirty || saveMutation.isPending}
                >
                  Revert
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => saveMutation.mutate(editorValue)}
                  disabled={!isDirty || saveMutation.isPending || selectedFileUnsupported}
                >
                  {saveMutation.isPending ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {contextMenu && contextMenuItems.length > 0 ? (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </aside>
  );
});
