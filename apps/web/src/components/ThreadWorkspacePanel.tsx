import type { EnvironmentId, ThreadId, ThreadWorkspaceEntry } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FolderClosedIcon,
  FolderIcon,
  HouseIcon,
  LoaderIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { resolveEnvironmentHttpUrl } from "~/environments/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
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

const WORKSPACE_PANEL_WIDTH_STORAGE_KEY = "t3code:thread-workspace-panel-width:v1";
const WORKSPACE_TREE_WIDTH_STORAGE_KEY = "t3code:thread-workspace-tree-width:v1";
const DEFAULT_WORKSPACE_PANEL_WIDTH = 420;
const MIN_WORKSPACE_PANEL_WIDTH = 320;
const DEFAULT_WORKSPACE_TREE_WIDTH = 220;
const MIN_WORKSPACE_TREE_WIDTH = 190;
const MIN_WORKSPACE_EDITOR_WIDTH = 220;
const DEFAULT_CONTAINER_WORKSPACE_PATH = "/workspace";
const DEFAULT_CONTAINER_HOME_PATH = "/runtime/home";

function maxWorkspacePanelWidth(): number {
  if (typeof window === "undefined") {
    return 820;
  }
  return Math.max(MIN_WORKSPACE_PANEL_WIDTH, Math.min(960, Math.floor(window.innerWidth * 0.6)));
}

function clampWorkspacePanelWidth(width: number): number {
  return Math.max(MIN_WORKSPACE_PANEL_WIDTH, Math.min(width, maxWorkspacePanelWidth()));
}

function maxWorkspaceTreeWidth(panelWidth: number): number {
  return Math.max(MIN_WORKSPACE_TREE_WIDTH, panelWidth - MIN_WORKSPACE_EDITOR_WIDTH - 16);
}

function clampWorkspaceTreeWidth(width: number, panelWidth: number): number {
  return Math.max(MIN_WORKSPACE_TREE_WIDTH, Math.min(width, maxWorkspaceTreeWidth(panelWidth)));
}

function readPersistedWorkspacePanelWidth(): number {
  const storedWidth = getLocalStorageItem(WORKSPACE_PANEL_WIDTH_STORAGE_KEY, Schema.Finite);
  return clampWorkspacePanelWidth(storedWidth ?? DEFAULT_WORKSPACE_PANEL_WIDTH);
}

function readPersistedWorkspaceTreeWidth(panelWidth: number): number {
  const storedWidth = getLocalStorageItem(WORKSPACE_TREE_WIDTH_STORAGE_KEY, Schema.Finite);
  return clampWorkspaceTreeWidth(storedWidth ?? DEFAULT_WORKSPACE_TREE_WIDTH, panelWidth);
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

function normalizeAbsoluteContainerPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    return DEFAULT_CONTAINER_WORKSPACE_PATH;
  }
  const rawSegments = trimmed.split("/");
  const normalizedSegments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }
  return `/${normalizedSegments.join("/")}`.replace(/\/{2,}/g, "/") || "/";
}

function normalizeContainerNavigationPath(input: string, currentPath: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return currentPath;
  }
  if (trimmed === "~") {
    return DEFAULT_CONTAINER_HOME_PATH;
  }
  if (trimmed.startsWith("~/")) {
    return normalizeAbsoluteContainerPath(`${DEFAULT_CONTAINER_HOME_PATH}/${trimmed.slice(2)}`);
  }
  if (trimmed.startsWith("/")) {
    return normalizeAbsoluteContainerPath(trimmed);
  }
  return normalizeAbsoluteContainerPath(`${currentPath}/${trimmed}`);
}

function dirnameContainerPath(pathValue: string): string {
  const normalizedPath = normalizeAbsoluteContainerPath(pathValue);
  if (normalizedPath === "/") {
    return "/";
  }
  const segments = normalizedPath.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
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
  const hasChildren = props.node.children.length > 0;
  const isExpanded = hasChildren && props.expandedDirectories.has(props.node.path);
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
        {isDirectory && hasChildren ? (
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
      {isDirectory && hasChildren && isExpanded
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
  const [currentPath, setCurrentPath] = useState(DEFAULT_CONTAINER_WORKSPACE_PATH);
  const [pathDraft, setPathDraft] = useState(DEFAULT_CONTAINER_WORKSPACE_PATH);
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
  const [panelWidth, setPanelWidth] = useState(() => readPersistedWorkspacePanelWidth());
  const [treeWidth, setTreeWidth] = useState(() =>
    readPersistedWorkspaceTreeWidth(readPersistedWorkspacePanelWidth()),
  );
  const selectedPathRef = useRef<string | null>(null);
  const panelResizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const treeResizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  selectedPathRef.current = selectedPath;

  const stopDocumentResizeState = useCallback(() => {
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  useEffect(() => {
    setSearchQuery("");
    setCurrentPath(DEFAULT_CONTAINER_WORKSPACE_PATH);
    setPathDraft(DEFAULT_CONTAINER_WORKSPACE_PATH);
    setExpandedDirectories(new Set());
    setSelectedPath(null);
    setSelectedKind(null);
    setEditorValue("");
    setSavedValue("");
    setSyncedFilePath(null);
    setTreeInitialized(false);
    setContextMenu(null);
  }, [props.environmentId, props.threadId]);

  useEffect(() => {
    setTreeWidth((current) => clampWorkspaceTreeWidth(current, panelWidth));
  }, [panelWidth]);

  useEffect(() => {
    setLocalStorageItem(WORKSPACE_PANEL_WIDTH_STORAGE_KEY, panelWidth, Schema.Finite);
  }, [panelWidth]);

  useEffect(() => {
    setLocalStorageItem(WORKSPACE_TREE_WIDTH_STORAGE_KEY, treeWidth, Schema.Finite);
  }, [treeWidth]);

  useEffect(() => {
    const onWindowResize = () => {
      setPanelWidth((current) => clampWorkspacePanelWidth(current));
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

  useEffect(
    () => () => {
      stopDocumentResizeState();
    },
    [stopDocumentResizeState],
  );

  const entriesQuery = useQuery(
    threadWorkspaceEntriesQueryOptions({
      environmentId: props.environmentId,
      threadId: props.threadId,
      basePath: currentPath,
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
    if (!entriesQuery.data?.basePath) {
      return;
    }
    setCurrentPath(entriesQuery.data.basePath);
    setPathDraft(entriesQuery.data.basePath);
  }, [entriesQuery.data?.basePath]);

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
    setContextMenu(null);
    if (node.kind === "directory") {
      setCurrentPath(node.path);
      setPathDraft(node.path);
      setTreeInitialized(false);
      setExpandedDirectories(new Set());
      setSelectedPath(null);
      setSelectedKind(null);
      setEditorValue("");
      setSavedValue("");
      setSyncedFilePath(null);
      return;
    }
    setSelectedPath(node.path);
    setSelectedKind(node.kind);
    if (node.parentPath) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.add(node.parentPath!);
        return next;
      });
    }
    setSyncedFilePath(null);
  }, []);

  const refreshWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadWorkspaceQueryKeys.all });
  }, [queryClient]);

  const openWorkspaceHome = useCallback(() => {
    setCurrentPath(DEFAULT_CONTAINER_WORKSPACE_PATH);
    setPathDraft(DEFAULT_CONTAINER_WORKSPACE_PATH);
    setTreeInitialized(false);
    setExpandedDirectories(new Set());
    setSelectedPath(null);
    setSelectedKind(null);
    setEditorValue("");
    setSavedValue("");
    setSyncedFilePath(null);
  }, []);

  const openParentDirectory = useCallback(() => {
    const nextPath = dirnameContainerPath(currentPath);
    setCurrentPath(nextPath);
    setPathDraft(nextPath);
    setTreeInitialized(false);
    setExpandedDirectories(new Set());
    setSelectedPath(null);
    setSelectedKind(null);
    setEditorValue("");
    setSavedValue("");
    setSyncedFilePath(null);
  }, [currentPath]);

  const submitPathDraft = useCallback(() => {
    const nextPath = normalizeContainerNavigationPath(pathDraft, currentPath);
    setCurrentPath(nextPath);
    setPathDraft(nextPath);
    setTreeInitialized(false);
    setExpandedDirectories(new Set());
    setSelectedPath(null);
    setSelectedKind(null);
    setEditorValue("");
    setSavedValue("");
    setSyncedFilePath(null);
  }, [currentPath, pathDraft]);

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
        id: "open-folder",
        label: "Open folder",
        onSelect: () => selectNode(contextMenu.node),
      });
    }
    return items;
  }, [contextMenu, downloadFile, selectNode]);

  const handlePanelResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      panelResizeStateRef.current = {
        pointerId: event.pointerId,
        startWidth: panelWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [panelWidth],
  );

  const handlePanelResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = panelResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      setPanelWidth(
        clampWorkspacePanelWidth(resizeState.startWidth + (resizeState.startX - event.clientX)),
      );
    },
    [],
  );

  const handlePanelResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = panelResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      panelResizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopDocumentResizeState();
    },
    [stopDocumentResizeState],
  );

  const handleTreeResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      treeResizeStateRef.current = {
        pointerId: event.pointerId,
        startWidth: treeWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [treeWidth],
  );

  const handleTreeResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = treeResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      setTreeWidth(
        clampWorkspaceTreeWidth(
          resizeState.startWidth + (event.clientX - resizeState.startX),
          panelWidth,
        ),
      );
    },
    [panelWidth],
  );

  const handleTreeResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = treeResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      treeResizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopDocumentResizeState();
    },
    [stopDocumentResizeState],
  );

  return (
    <aside
      className="relative flex min-h-0 shrink-0 border-l border-border bg-background/96"
      style={{ width: `${panelWidth}px` }}
    >
      <button
        type="button"
        aria-label="Resize file manager panel"
        className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border/80 hover:after:bg-foreground/60"
        onPointerDown={handlePanelResizePointerDown}
        onPointerMove={handlePanelResizePointerMove}
        onPointerUp={handlePanelResizePointerEnd}
        onPointerCancel={handlePanelResizePointerEnd}
      />
      <div
        className="flex min-h-0 flex-col border-r border-border"
        style={{ width: `${treeWidth}px` }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Thread Filesystem</div>
            <div className="truncate text-[11px] text-muted-foreground">
              Real paths inside the runtime container
            </div>
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
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              submitPathDraft();
            }}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={openWorkspaceHome}
              aria-label="Open workspace root"
            >
              <HouseIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={openParentDirectory}
              aria-label="Open parent directory"
              disabled={currentPath === "/"}
            >
              <ArrowUpIcon className="size-3.5" />
            </Button>
            <Input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder="/workspace"
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              aria-label="Container path"
            />
            <Button type="submit" variant="outline" size="xs">
              Go
            </Button>
          </form>
          <div className="mt-2 text-[11px] text-muted-foreground">{currentPath}</div>
        </div>
        <div className="border-b border-border px-3 py-2">
          <label className="relative block">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter current directory"
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
                ? "No entries in this directory match that filter."
                : "This directory is empty."}
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

      <button
        type="button"
        aria-label="Resize workspace file tree"
        className="relative z-10 w-2 shrink-0 cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border/80 hover:after:bg-foreground/60"
        onPointerDown={handleTreeResizePointerDown}
        onPointerMove={handleTreeResizePointerMove}
        onPointerUp={handleTreeResizePointerEnd}
        onPointerCancel={handleTreeResizePointerEnd}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedKind !== "file" || !selectedPath ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Browse to a directory or select a file to view or edit it here.
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
