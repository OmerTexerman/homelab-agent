import { useMemo, useRef, useState } from "react";
import type { HomelabEntity, HomelabEntityId, HomelabRelation } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

/**
 * Dependency-free force-directed view of the knowledge graph. The layout is a
 * deterministic simulation (seeded from input order, no randomness), so the same data
 * always renders the same picture and background refetches do not make the graph jump.
 * Homelab graphs are small (tens to a few hundred nodes), so the O(n^2) repulsion pass
 * is computed once per data change in a memo rather than animated.
 */

interface GraphNode {
  readonly id: string;
  readonly entity: HomelabEntity;
  x: number;
  y: number;
  readonly degree: number;
}

interface GraphEdge {
  readonly relation: HomelabRelation;
  readonly from: GraphNode;
  readonly to: GraphNode;
}

interface GraphLayout {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * The kind vocabulary is open — agents introduce kinds organically — so every kind's
 * color is derived from its name: a deterministic hue keeps a kind the same color across
 * renders, sessions, and machines no matter which other kinds are present, with nothing
 * hard-coded to maintain.
 */
function kindHue(kind: string): number {
  let hash = 0;
  for (const char of kind) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

function kindColor(kind: string): string {
  return `hsl(${kindHue(kind)} 62% 55%)`;
}

function computeGraphLayout(
  entities: ReadonlyArray<HomelabEntity>,
  relations: ReadonlyArray<HomelabRelation>,
): GraphLayout {
  const degree = new Map<string, number>();
  for (const relation of relations) {
    degree.set(String(relation.fromEntityId), (degree.get(String(relation.fromEntityId)) ?? 0) + 1);
    degree.set(String(relation.toEntityId), (degree.get(String(relation.toEntityId)) ?? 0) + 1);
  }

  // Deterministic seed positions: nodes on a circle in input order, radius scaled by count.
  const count = Math.max(entities.length, 1);
  const seedRadius = 60 + count * 14;
  const nodes: GraphNode[] = entities.map((entity, index) => ({
    id: String(entity.id),
    entity,
    x: seedRadius * Math.cos((2 * Math.PI * index) / count),
    y: seedRadius * Math.sin((2 * Math.PI * index) / count),
    degree: degree.get(String(entity.id)) ?? 0,
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdge[] = relations.flatMap((relation) => {
    const from = nodeById.get(String(relation.fromEntityId));
    const to = nodeById.get(String(relation.toEntityId));
    return from && to && from !== to ? [{ relation, from, to }] : [];
  });

  // Cap total work so very large graphs still lay out fast: iterations shrink as n grows.
  const iterations = Math.max(60, Math.min(300, Math.floor(40_000 / Math.max(nodes.length, 1))));
  const springLength = 110;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / iterations;
    const step = 4 * cooling;

    for (let i = 0; i < nodes.length; i += 1) {
      const left = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const right = nodes[j]!;
        let dx = left.x - right.x;
        let dy = left.y - right.y;
        const distanceSq = Math.max(dx * dx + dy * dy, 1);
        const distance = Math.sqrt(distanceSq);
        // Repulsion between every pair.
        const force = Math.min(2400 / distanceSq, 8) * step;
        dx /= distance;
        dy /= distance;
        left.x += dx * force;
        left.y += dy * force;
        right.x -= dx * force;
        right.y -= dy * force;
      }
    }

    for (const edge of edges) {
      // Spring along each relation toward the target length.
      const dx = edge.to.x - edge.from.x;
      const dy = edge.to.y - edge.from.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = ((distance - springLength) / distance) * 0.06 * step;
      edge.from.x += dx * force;
      edge.from.y += dy * force;
      edge.to.x -= dx * force;
      edge.to.y -= dy * force;
    }

    for (const node of nodes) {
      // Mild centering keeps disconnected components from drifting away.
      node.x -= node.x * 0.005 * step;
      node.y -= node.y * 0.005 * step;
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  if (nodes.length === 0) {
    minX = -100;
    minY = -100;
    maxX = 100;
    maxY = 100;
  }
  const padding = 60;
  return {
    nodes,
    edges,
    bounds: {
      minX: minX - padding,
      minY: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    },
  };
}

export interface KnowledgeGraphViewProps {
  readonly entities: ReadonlyArray<HomelabEntity>;
  readonly relations: ReadonlyArray<HomelabRelation>;
  readonly staleEntityIds: ReadonlySet<string>;
  /** Lowercased search query; non-matching nodes are dimmed rather than hidden. */
  readonly query: string;
  readonly onOpenEntity: (entityId: HomelabEntityId) => void;
}

export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const { entities, relations, staleEntityIds, query, onOpenEntity } = props;
  const layout = useMemo(() => computeGraphLayout(entities, relations), [entities, relations]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, scale: 1 });
  const panState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const neighborIds = useMemo(() => {
    if (!selectedNodeId) {
      return new Set<string>();
    }
    const ids = new Set<string>([selectedNodeId]);
    for (const edge of layout.edges) {
      if (edge.from.id === selectedNodeId) {
        ids.add(edge.to.id);
      }
      if (edge.to.id === selectedNodeId) {
        ids.add(edge.from.id);
      }
    }
    return ids;
  }, [layout.edges, selectedNodeId]);

  const matchesSearch = (entity: HomelabEntity): boolean => {
    if (query.length === 0) {
      return true;
    }
    return [
      entity.name,
      entity.title,
      entity.summary,
      entity.kind,
      ...(entity.tags ?? []),
      ...(entity.aliases ?? []),
    ]
      .filter((value): value is string => value != null)
      .some((value) => value.toLowerCase().includes(query));
  };

  const selectedNode = selectedNodeId
    ? layout.nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  const presentKinds = useMemo(
    () => [...new Set(entities.map((entity) => entity.kind))].toSorted(),
    [entities],
  );

  const handleWheel: React.WheelEventHandler<SVGSVGElement> = (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    setViewTransform((previous) => ({
      ...previous,
      scale: Math.min(8, Math.max(0.2, previous.scale * factor)),
    }));
  };
  const handlePointerDown: React.PointerEventHandler<SVGSVGElement> = (event) => {
    panState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewTransform.x,
      originY: viewTransform.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove: React.PointerEventHandler<SVGSVGElement> = (event) => {
    const pan = panState.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    // Convert screen pixels to viewBox units so panning tracks the cursor at any zoom.
    const svg = svgRef.current;
    const pixelsPerUnit = svg ? svg.clientWidth / (layout.bounds.width / viewTransform.scale) : 1;
    setViewTransform((previous) => ({
      ...previous,
      x: pan.originX + (event.clientX - pan.startX) / pixelsPerUnit,
      y: pan.originY + (event.clientY - pan.startY) / pixelsPerUnit,
    }));
  };
  const handlePointerUp: React.PointerEventHandler<SVGSVGElement> = (event) => {
    if (panState.current?.pointerId === event.pointerId) {
      panState.current = null;
    }
  };

  if (layout.nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-10 text-center text-xs text-muted-foreground">
        No entities in the graph yet — promoted knowledge will appear here as nodes.
      </div>
    );
  }

  const { bounds } = layout;
  const viewBox = `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`;

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-md border border-border bg-background">
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="h-[28rem] w-full cursor-grab touch-none select-none active:cursor-grabbing"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedNodeId(null);
            }
          }}
        >
          <g
            transform={`translate(${bounds.minX + bounds.width / 2} ${bounds.minY + bounds.height / 2}) scale(${viewTransform.scale}) translate(${viewTransform.x - (bounds.minX + bounds.width / 2)} ${viewTransform.y - (bounds.minY + bounds.height / 2)})`}
          >
            {layout.edges.map((edge) => {
              const involvesSelection =
                selectedNodeId !== null &&
                (edge.from.id === selectedNodeId || edge.to.id === selectedNodeId);
              return (
                <g key={String(edge.relation.id)}>
                  <line
                    x1={edge.from.x}
                    y1={edge.from.y}
                    x2={edge.to.x}
                    y2={edge.to.y}
                    className={cn(
                      involvesSelection ? "stroke-primary/70" : "stroke-border",
                      selectedNodeId !== null && !involvesSelection ? "opacity-25" : "opacity-80",
                    )}
                    strokeWidth={involvesSelection ? 1.6 : 1}
                  >
                    <title>{`${edge.from.entity.name} ${edge.relation.kind.replaceAll("_", " ")} ${edge.to.entity.name}`}</title>
                  </line>
                  {involvesSelection ? (
                    <text
                      x={(edge.from.x + edge.to.x) / 2}
                      y={(edge.from.y + edge.to.y) / 2 - 3}
                      textAnchor="middle"
                      className="fill-muted-foreground"
                      fontSize={7}
                    >
                      {edge.relation.kind.replaceAll("_", " ")}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {layout.nodes.map((node) => {
              const dimmed =
                (selectedNodeId !== null && !neighborIds.has(node.id)) ||
                !matchesSearch(node.entity);
              const radius = 6 + Math.min(node.degree, 8) * 1.1;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x} ${node.y})`}
                  className={cn("cursor-pointer", dimmed ? "opacity-25" : "opacity-100")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedNodeId((previous) => (previous === node.id ? null : node.id));
                  }}
                >
                  {staleEntityIds.has(node.id) ? (
                    <circle
                      r={radius + 3}
                      fill="none"
                      stroke="hsl(40 90% 55%)"
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                    />
                  ) : null}
                  <circle
                    r={radius}
                    fill={kindColor(node.entity.kind)}
                    fillOpacity={node.entity.status === "deprecated" ? 0.35 : 0.9}
                    stroke={selectedNodeId === node.id ? "white" : "transparent"}
                    strokeWidth={1.5}
                  >
                    <title>{`${node.entity.name} (${node.entity.kind})`}</title>
                  </circle>
                  <text
                    y={radius + 9}
                    textAnchor="middle"
                    fontSize={8}
                    className="fill-foreground/80"
                  >
                    {node.entity.name.length > 22
                      ? `${node.entity.name.slice(0, 21)}…`
                      : node.entity.name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        {selectedNode ? (
          <div className="absolute right-2 bottom-2 w-60 space-y-1 rounded-md border border-border bg-background/95 p-2.5 shadow-sm">
            <div className="flex items-center gap-1.5">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: kindColor(selectedNode.entity.kind) }}
              />
              <span className="truncate text-xs font-medium text-foreground">
                {selectedNode.entity.title ?? selectedNode.entity.name}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {selectedNode.entity.kind.replaceAll("_", " ")}
              {selectedNode.entity.status ? ` · ${selectedNode.entity.status}` : ""}
              {` · ${selectedNode.degree} relation${selectedNode.degree === 1 ? "" : "s"}`}
            </div>
            {selectedNode.entity.summary ? (
              <div className="line-clamp-3 text-[11px] text-foreground/80">
                {selectedNode.entity.summary}
              </div>
            ) : null}
            <button
              type="button"
              className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => onOpenEntity(selectedNode.entity.id)}
            >
              View full record →
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {presentKinds.map((kind) => (
          <span
            key={kind}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(kind) }} />
            {kind.replaceAll("_", " ")}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          Scroll to zoom · drag to pan · click a node to inspect
        </span>
      </div>
    </div>
  );
}
