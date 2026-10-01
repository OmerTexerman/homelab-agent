# Sidebar project groups

The web sidebar (`apps/web/src/components/Sidebar.tsx`, upstream's
"sidebar v2") is one flat sortable list: pinned rows, the active rows, the
snoozed shelf, and the settled shelf, separated by marker items. The fork
groups the **active** section by project. Pinned rows and both shelves stay
global, so upstream's drag sections, drop planning, and shelf paging keep
working unchanged.

## Where it lives

| Piece                                                                | Role                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/homelab/sidebarProjectGroups.ts`                       | Pure logic: group order (`sortLogicalProjectsForSidebar(..., "updated_at")`, the Home order), Scratch last, curator excluded, collapse, search clustering. |
| `apps/web/src/components/sidebar/useHomelabSidebarProjectGroups.tsx` | The seam hook Sidebar.tsx calls once. Owns collapsed state, navigation, and new-thread actions.                                                            |
| `apps/web/src/components/sidebar/HomelabProjectGroupHeader.tsx`      | The header row and the search group label.                                                                                                                 |

Collapsed groups reuse the UI state store's persisted `projectExpandedById`
(the same map the legacy sidebar uses), keyed by logical project key. Scratch
uses `homelab:scratch`.

## How it hooks into Sidebar.tsx

- The partition memo's `activeThreads` is renamed `upstreamActiveThreads`; the
  hook returns `activeThreads` clustered by group, and Sidebar.tsx rebinds the
  name. Everything that reads the active order (drop planning, search input,
  section lookup) sees the grouped order.
- `visibleActive` (rows outside collapsed groups, plus the open thread)
  replaces `activeThreads` in `orderedThreads`, so jump hints, range select,
  and keyboard traversal skip collapsed rows.
- `sidebarListItems` takes `homelabGroups.activeListItems` for the active
  rows: one `homelab-group-<encoded key>` marker per group followed by its
  rows. The marker type is one extra member of `SidebarListMarker` in
  `Sidebar.logic.ts`.
- The list render loop sends group markers to `renderGroupHeader` before
  upstream's marker `switch`.
- Search results pass through `groupSearchResults`, and the results list maps
  with `mapSearchResults`, which puts a group title before each group.
- Both empty checks count `activeListItems`, so project headers render even
  when no project has threads yet.

Group headers are sortable markers that can't be picked up. Upstream's
sorting strategy hides every marker it does not lay out, so the headers
collapse during a drag and the preview is the flat list. Drop resolution only
reads the pinned/snoozed/settled markers, so a header is just another slot in
the active section.

Header runtime dots read `projectRuntimeDetailQueryOptions`, the same cached
query and 15s refresh Home uses.

## After an upstream sync

If upstream restructures the partition memo, `sidebarListItems`, or the
render loop, re-add the hook at the new spot instead of moving grouping
logic into Sidebar.tsx. `sidebarProjectGroups.test.ts` covers the pure rules.
