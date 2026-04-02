import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import express, { type Request, type Response } from 'express';
import { ok, err, type Result } from 'neverthrow';
import open from 'open';
import type { Logger } from 'pino';
import { readGraph, serializeGraph } from '../graph/serializer.js';
import type { DependencyGraph, GraphEdge } from '../graph/types.js';
import {
  GraphvizRenderer,
  groupEdges,
  computeComponents,
  filterGraphToNodes,
} from './graphRenderer.js';
import type { ComponentResult } from './graphRenderer.js';
import type { ParameterInfo, TypeInfo } from '../graph/types.js';
import { FieldFactory, renderFormHtml } from './formGenerator.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServerOptions {
  readonly port: number;
  readonly graphPath: string;
  readonly autoOpen: boolean;
  readonly logger?: Logger;
}

export interface ServerInstance {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface ServerError {
  readonly kind: 'ServerError';
  readonly code: 'PORT_IN_USE' | 'GRAPH_NOT_FOUND' | 'RENDER_FAILED' | 'UNKNOWN';
  readonly message: string;
  readonly cause?: unknown;
}

function makeServerError(code: ServerError['code'], message: string, cause?: unknown): ServerError {
  return { kind: 'ServerError', code, message, cause };
}

// ---------------------------------------------------------------------------
// Internal response types
// ---------------------------------------------------------------------------

interface NodeSummary {
  id: string;
  kind: string;
  name: string;
  filePath: string;
}

interface ContextLine {
  lineNumber: number;
  text: string;
  isTarget: boolean;
}

interface EdgeContextItem {
  kind: GraphEdge['kind'];
  from: string;
  to: string;
  line?: number;
  contextLines?: ContextLine[];
  zedUrl?: string;
  importedNames?: readonly string[];
  isTypeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Call-path types
// ---------------------------------------------------------------------------

interface CallPathStep {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly line?: number;
  readonly parameters: readonly ParameterInfo[];
  readonly isTarget: boolean;
}

// ---------------------------------------------------------------------------
// Call-path computation (reverse traversal through call edges)
// ---------------------------------------------------------------------------

const MAX_CALL_PATHS = 25;
const MAX_CALL_DEPTH = 10;

function findCallPaths(
  graph: DependencyGraph,
  targetNodeId: string,
): { readonly paths: readonly (readonly CallPathStep[])[]; readonly truncated: boolean } {
  // Build reverse call map: callee -> [callers]
  const reverseCallMap = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'call') continue;
    const list = reverseCallMap.get(edge.to) ?? [];
    list.push(edge.from);
    reverseCallMap.set(edge.to, list);
  }

  function buildStep(nodeId: string, isTarget: boolean): CallPathStep {
    const node = graph.nodes.get(nodeId);
    return {
      nodeId,
      name: node?.name ?? nodeId,
      kind: node?.kind ?? 'unknown',
      filePath: node?.filePath ?? '',
      ...(node?.kind === 'function' ? { line: node.line } : {}),
      parameters: node?.kind === 'function' ? node.parameters : [],
      isTarget,
    };
  }

  const paths: (readonly CallPathStep[])[] = [];
  let truncated = false;

  // DFS backward from target; pathFromTarget grows as we go up the call stack
  function dfs(
    nodeId: string,
    pathFromTarget: readonly string[],
    visitedInPath: ReadonlySet<string>,
  ): void {
    if (paths.length >= MAX_CALL_PATHS) {
      truncated = true;
      return;
    }
    if (pathFromTarget.length >= MAX_CALL_DEPTH) {
      truncated = true;
      return;
    }

    const callers = (reverseCallMap.get(nodeId) ?? []).filter((c) => !visitedInPath.has(c));

    if (callers.length === 0) {
      // nodeId is a root (no unvisited callers) — emit path root→target
      const fullPath = [...pathFromTarget, nodeId].reverse();
      paths.push(fullPath.map((id, i) => buildStep(id, i === fullPath.length - 1)));
      return;
    }

    for (const caller of callers) {
      if (paths.length >= MAX_CALL_PATHS) {
        truncated = true;
        return;
      }
      const newVisited = new Set(visitedInPath);
      newVisited.add(caller);
      dfs(caller, [...pathFromTarget, nodeId], newVisited);
    }
  }

  dfs(targetNodeId, [], new Set([targetNodeId]));

  // If no call edges reach this node, return a single-step path
  if (paths.length === 0) {
    paths.push([buildStep(targetNodeId, true)]);
  }

  return { paths, truncated };
}

// ---------------------------------------------------------------------------
// Source-context helper
// ---------------------------------------------------------------------------

function readSourceContext(
  absFilePath: string,
  targetLine: number,
  contextRadius: number,
): ContextLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(absFilePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const zeroIdx = targetLine - 1;
  const start = Math.max(0, zeroIdx - contextRadius);
  const end = Math.min(lines.length - 1, zeroIdx + contextRadius);
  const result: ContextLine[] = [];
  for (let i = start; i <= end; i++) {
    result.push({ lineNumber: i + 1, text: lines[i] ?? '', isTarget: i === zeroIdx });
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML-safe JSON embed helper
// ---------------------------------------------------------------------------

function safeJsonEmbed(data: unknown): string {
  return JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
}

// ---------------------------------------------------------------------------
// HTML page builder
// ---------------------------------------------------------------------------

function buildHtmlPage(
  graph: DependencyGraph,
  svgContent: string,
  components: ComponentResult,
  initialVisibleClusterIds: readonly string[],
): string {
  const nodeCount = graph.nodes.size;
  const edgeCount = graph.edges.length;
  const functionCount = Array.from(graph.nodes.values()).filter(
    (n) => n.kind === 'function',
  ).length;
  const classCount = Array.from(graph.nodes.values()).filter((n) => n.kind === 'class').length;
  const interfaceCount = Array.from(graph.nodes.values()).filter(
    (n) => n.kind === 'interface',
  ).length;

  // ── Embed graph data for client-side filtering, edge mapping, clustering ─
  const nodeData: Array<{ id: string; kind: string; filePath: string }> = Array.from(
    graph.nodes.values(),
  ).map((n) => ({ id: n.id, kind: n.kind, filePath: n.filePath }));

  const edgeGroupData = groupEdges(graph).map((g) => ({
    id: Buffer.from(`${g.from}\x00${g.to}`).toString('base64url'),
    from: g.from,
    to: g.to,
    count: g.edges.length,
  }));

  // nodeClusterMap: nodeId -> clusterId (for effective-orphan detection)
  const clusterData: Record<string, string> = {};
  for (const [nodeId, clusterId] of components.nodeClusterMap) {
    clusterData[nodeId] = clusterId;
  }

  const clusterInfoData = components.clusters.map((c) => ({
    id: c.id,
    label: c.label,
    hasEntrypoint: c.hasEntrypoint,
    isOrphan: c.isOrphan,
    nodeCount: c.nodeIds.size,
  }));

  const embeddedScript = `
var __graphNodes__ = ${safeJsonEmbed(nodeData)};
var __edgeGroupData__ = ${safeJsonEmbed(edgeGroupData)};
var __nodeClusterData__ = ${safeJsonEmbed(clusterData)};
var __clusterInfo__ = ${safeJsonEmbed(clusterInfoData)};
var __initialVisibleClusters__ = ${safeJsonEmbed(initialVisibleClusterIds)};
`.trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ts-investigator</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Helvetica, Arial, sans-serif;
      background: #0f0f23;
      color: #e2e8f0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      padding: 8px 16px;
      background: #13132b;
      border-bottom: 1px solid #2d2d5a;
      z-index: 10;
    }

    header h1 {
      font-size: 15px;
      font-weight: 700;
      color: #818cf8;
      letter-spacing: 0.04em;
      white-space: nowrap;
      margin-right: 4px;
    }

    header h1 span { color: #475569; font-weight: 400; }

    .stats {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .stat-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 20px;
      font-weight: 600;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }

    .stat-badge.nodes  { background: #1e1e3a; color: #94a3b8; border: 1px solid #3a3a5a; }
    .stat-badge.edges  { background: #1e1e3a; color: #94a3b8; border: 1px solid #3a3a5a; }
    .stat-badge.fn     { background: #1a2a3a; color: #4A90D9; border: 1px solid #2a4a6a; }
    .stat-badge.cls    { background: #2a1e0e; color: #E67E22; border: 1px solid #5a3a10; }
    .stat-badge.iface  { background: #0e2018; color: #27AE60; border: 1px solid #1a5030; }

    /* ── Filter widget ──────────────────────────────────────────────────── */
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-left: auto;
      flex-wrap: wrap;
    }

    .filter-bar-label {
      font-size: 10px;
      color: #3a3a6a;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      white-space: nowrap;
    }

    .filter-divider {
      width: 1px;
      height: 14px;
      background: #2d2d5a;
      margin: 0 2px;
    }

    /* Default state = nodes ARE VISIBLE (pill is "on" / bright) */
    .filter-pill {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 20px;
      font-weight: 700;
      letter-spacing: 0.04em;
      cursor: pointer;
      border: 1px solid #3a5a7a;
      background: #1a2a3a;
      color: #7ab0d9;
      transition: background 0.12s, color 0.12s, border-color 0.12s, opacity 0.12s;
      white-space: nowrap;
      user-select: none;
    }

    .filter-pill:hover { border-color: #818cf8; color: #c0d8f0; }

    /* "hiding" state = nodes are HIDDEN (pill is dimmed + strikethrough) */
    .filter-pill.hiding {
      background: #0f0f1e;
      color: #2a3a4a;
      border-color: #1e1e3a;
      text-decoration: line-through;
      opacity: 0.6;
    }

    .filter-pill.hiding:hover {
      opacity: 0.9;
      color: #5a8aaa;
      border-color: #3a5a7a;
      text-decoration: none;
    }

    /* ── Layout ─────────────────────────────────────────────────────────── */
    main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    #graph-container {
      flex: 1;
      overflow: hidden;
      position: relative;
      background: #1a1a2e;
      cursor: grab;
      user-select: none;
    }

    #graph-container:active { cursor: grabbing; }

    #svg-layer {
      display: inline-block;
      transform-origin: 0 0;
      transition: transform 0.08s ease-out;
      will-change: transform;
    }

    #graph-container svg { display: block; }

    /* ── Zoom controls ───────────────────────────────────────────────────── */
    #zoom-controls {
      position: absolute;
      bottom: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      z-index: 20;
    }

    .zoom-btn {
      width: 32px;
      height: 32px;
      border: 1px solid #3a3a5a;
      border-radius: 6px;
      background: #13132b;
      color: #94a3b8;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .zoom-btn:hover { background: #1e1e4a; color: #e2e8f0; border-color: #818cf8; }
    .zoom-btn:active { background: #2a2a6a; }

    .zoom-btn.wide {
      width: 48px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.03em;
    }

    #zoom-level {
      font-size: 10px;
      color: #475569;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-align: center;
      min-width: 32px;
      margin-top: 2px;
    }

    /* ── SVG node interactivity ──────────────────────────────────────────── */
    #graph-container svg .node {
      cursor: pointer;
      transition: filter 0.15s, opacity 0.25s;
    }

    #graph-container svg .node:hover {
      filter: brightness(1.3) drop-shadow(0 0 6px rgba(129,140,248,0.6));
    }

    #graph-container svg .node.selected {
      filter: brightness(1.4) drop-shadow(0 0 10px rgba(129,140,248,0.9)) !important;
    }

    /* Effective orphans — visible nodes whose edges are all hidden by filters */
    #graph-container svg .node.effective-orphan {
      opacity: 0.45;
    }
    #graph-container svg .node.effective-orphan polygon,
    #graph-container svg .node.effective-orphan ellipse,
    #graph-container svg .node.effective-orphan path {
      stroke-dasharray: 5,3;
    }

    /* ── Highlight animations ────────────────────────────────────────────── */
    @keyframes edge-pulse-out {
      0%, 100% { stroke-opacity: 1.0; }
      50%       { stroke-opacity: 0.2; }
    }
    @keyframes edge-pulse-in {
      0%, 100% { stroke-opacity: 1.0; }
      50%       { stroke-opacity: 0.2; }
    }
    @keyframes node-pulse-glow {
      0%, 100% { filter: brightness(1.4) drop-shadow(0 0 10px rgba(129,140,248,0.9)); }
      50%       { filter: brightness(1.1) drop-shadow(0 0 4px  rgba(129,140,248,0.25)); }
    }
    @keyframes node-pulse-glow-2 {
      0%, 100% { filter: brightness(1.25) drop-shadow(0 0 8px rgba(129,140,248,0.65)); }
      50%       { filter: brightness(1.05) drop-shadow(0 0 2px rgba(129,140,248,0.15)); }
    }

    /* Outgoing edges — blue, intensity fades with depth */
    .edge.highlight-out-1 > path, .edge.highlight-out-1 > polygon {
      stroke: #4A90D9 !important; stroke-width: 2.8 !important;
      animation: edge-pulse-out 1.3s ease-in-out infinite;
    }
    .edge.highlight-out-2 > path, .edge.highlight-out-2 > polygon {
      stroke: #2d6ea8 !important; stroke-width: 2.0 !important;
      animation: edge-pulse-out 1.9s ease-in-out infinite;
    }
    .edge.highlight-out-3 > path, .edge.highlight-out-3 > polygon {
      stroke: #1a4870 !important; stroke-width: 1.5 !important;
    }
    .edge.highlight-out-4 > path, .edge.highlight-out-4 > polygon {
      stroke: #0f2d48 !important; stroke-width: 1.2 !important;
    }

    /* Incoming edges — green, intensity fades with depth */
    .edge.highlight-in-1 > path, .edge.highlight-in-1 > polygon {
      stroke: #27AE60 !important; stroke-width: 2.8 !important;
      animation: edge-pulse-in 1.3s ease-in-out infinite;
    }
    .edge.highlight-in-2 > path, .edge.highlight-in-2 > polygon {
      stroke: #1a7a44 !important; stroke-width: 2.0 !important;
      animation: edge-pulse-in 1.9s ease-in-out infinite;
    }
    .edge.highlight-in-3 > path, .edge.highlight-in-3 > polygon {
      stroke: #0e4c2a !important; stroke-width: 1.5 !important;
    }
    .edge.highlight-in-4 > path, .edge.highlight-in-4 > polygon {
      stroke: #082e1a !important; stroke-width: 1.2 !important;
    }

    /* SVG edge transitions */
    #graph-container svg .edge { transition: opacity 0.25s ease; }
    #graph-container svg .edge > path,
    #graph-container svg .edge > polygon { transition: stroke 0.2s, stroke-width 0.2s; }

    /* Highlighted nodes by depth */
    .node.highlight-node-1 { animation: node-pulse-glow 1.3s ease-in-out infinite; }
    .node.highlight-node-2 { animation: node-pulse-glow-2 1.9s ease-in-out infinite; }
    .node.highlight-node-3 { filter: brightness(1.15) drop-shadow(0 0 5px rgba(129,140,248,0.35)) !important; }
    .node.highlight-node-4 { filter: brightness(1.07) drop-shadow(0 0 3px rgba(129,140,248,0.18)) !important; }

    /* Dim everything not highlighted when highlighting is active */
    #graph-container.highlighting .node:not(.selected):not([class*="highlight-node-"]) {
      opacity: 0.18;
    }
    #graph-container.highlighting .edge:not([class*="highlight-out-"]):not([class*="highlight-in-"]) {
      opacity: 0.05;
    }

    /* ── Highlight depth indicator ───────────────────────────────────────── */
    #highlight-depth-indicator {
      display: none;
      font-size: 10px;
      font-weight: 700;
      color: #475569;
      letter-spacing: 0.05em;
      text-align: center;
      background: #0d0d20;
      border: 1px solid #1e1e3a;
      border-radius: 4px;
      padding: 2px 0;
      margin-top: 3px;
      width: 32px;
      cursor: default;
      user-select: none;
    }

    #highlight-depth-indicator.active {
      color: #818cf8;
      border-color: #3030aa;
    }

    /* Edge count badge hover hint */
    #graph-container svg .edge text { pointer-events: none; }
    #graph-container svg .edge text.count-badge {
      pointer-events: all;
      cursor: pointer;
    }

    /* ── Detail panel ────────────────────────────────────────────────────── */
    #detail-panel {
      width: 340px;
      flex-shrink: 0;
      background: #16163a;
      border-left: 1px solid #2d2d5a;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    #detail-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid #2d2d5a;
      flex-shrink: 0;
    }

    #detail-panel-header h2 {
      font-size: 12px;
      font-weight: 600;
      color: #818cf8;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    #close-panel-btn {
      background: none;
      border: none;
      color: #475569;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 4px;
      transition: color 0.15s;
    }

    #close-panel-btn:hover { color: #e2e8f0; }

    #detail-content {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }

    #detail-loading {
      display: none;
      padding: 20px 16px;
      font-size: 13px;
      color: #475569;
      font-style: italic;
    }

    #detail-placeholder {
      padding: 20px 16px;
      font-size: 13px;
      color: #475569;
      font-style: italic;
    }

    /* ── Cluster bar ─────────────────────────────────────────────────────── */
    #cluster-bar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 16px;
      background: #0a0a18;
      border-bottom: 1px solid #181828;
      overflow-x: auto;
      scrollbar-width: thin;
    }

    #cluster-bar::-webkit-scrollbar { height: 3px; }
    #cluster-bar::-webkit-scrollbar-thumb { background: #1e1e3a; border-radius: 2px; }

    .cluster-bar-label {
      font-size: 10px;
      color: #2a2a4a;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
      margin-right: 4px;
      flex-shrink: 0;
    }

    .cluster-btn {
      font-size: 10px;
      padding: 3px 10px;
      border-radius: 4px;
      border: 1px solid #181828;
      background: #0a0a18;
      color: #2a3a4a;
      cursor: pointer;
      white-space: nowrap;
      font-weight: 600;
      letter-spacing: 0.03em;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .cluster-btn:hover { border-color: #2a4a6a; color: #5a8aaa; }

    .cluster-btn.active {
      background: #0a1220;
      border-color: #1a3a5a;
      color: #3a7ab0;
    }

    .cluster-btn.active.is-entrypoint {
      background: #0e0e28;
      border-color: #30307a;
      color: #818cf8;
    }

    .cluster-btn.active.is-orphan {
      background: #0c0c1e;
      border-color: #1e1e38;
      color: #3a3a6a;
    }

    /* ── Call path styles ────────────────────────────────────────────────── */
    .call-path {
      margin: 0 14px 10px;
      border: 1px solid #1e2a3a;
      border-radius: 6px;
      overflow: hidden;
    }

    .call-path-step {
      display: flex;
      flex-direction: column;
      padding: 7px 10px;
      border-bottom: 1px solid #141e2a;
      position: relative;
    }

    .call-path-step:last-child { border-bottom: none; }

    .call-path-step.is-target {
      background: #0e1a2a;
      border-left: 2px solid #818cf8;
    }

    .call-path-step-name {
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
    }

    .call-path-step.is-target .call-path-step-name { color: #818cf8; }

    .call-path-step-meta {
      font-size: 10px;
      color: #3a4a5a;
      font-family: monospace;
      margin-top: 2px;
      word-break: break-all;
    }

    .call-path-step-params {
      font-size: 10px;
      color: #475569;
      margin-top: 4px;
      font-family: monospace;
    }

    .call-path-step-params span {
      display: inline-block;
      background: #0a1018;
      border: 1px solid #1e2a3a;
      border-radius: 3px;
      padding: 1px 5px;
      margin: 1px 2px 1px 0;
      color: #64748b;
    }

    .call-path-step-params span em { color: #4A90D9; font-style: normal; }

    .call-path-arrow {
      font-size: 14px;
      color: #2d3a4a;
      padding: 0 10px;
      text-align: center;
      background: #090d14;
      line-height: 16px;
      padding: 3px 0;
    }

    .call-path-zed {
      font-size: 10px;
      color: #2a5a8a;
      text-decoration: none;
      margin-left: auto;
      padding: 1px 5px;
      border-radius: 3px;
      border: 1px solid #1a3a5a;
      flex-shrink: 0;
    }

    .call-path-zed:hover { color: #4A90D9; border-color: #2a5a8a; }

    /* ── Call-paths modal ───────────────────────────────────────────────── */
    #call-paths-modal {
      position: fixed;
      inset: 0;
      z-index: 9000;
      display: none;
      align-items: center;
      justify-content: center;
    }

    #call-paths-modal.open { display: flex; }

    #call-paths-modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
    }

    #call-paths-modal-dialog {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      background: #0d0d20;
      border: 1px solid #2d2d5a;
      border-radius: 10px;
      width: 92vw;
      max-width: 1400px;
      height: 88vh;
      box-shadow: 0 24px 80px rgba(0,0,0,0.7);
      overflow: hidden;
    }

    #call-paths-modal-header {
      flex-shrink: 0;
      display: flex;
      align-items: baseline;
      gap: 12px;
      padding: 14px 20px;
      border-bottom: 1px solid #1e1e3a;
      background: #0a0a1a;
    }

    #call-paths-modal-header h2 {
      font-size: 14px;
      font-weight: 700;
      color: #818cf8;
      letter-spacing: 0.03em;
      margin: 0;
    }

    #call-paths-modal-subtitle {
      font-size: 11px;
      color: #3a3a6a;
      flex: 1;
    }

    #call-paths-modal-close {
      background: none;
      border: 1px solid #2d2d5a;
      border-radius: 5px;
      color: #475569;
      cursor: pointer;
      font-size: 16px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.12s, border-color 0.12s;
      flex-shrink: 0;
    }

    #call-paths-modal-close:hover { color: #e2e8f0; border-color: #818cf8; }

    #call-paths-modal-body {
      flex: 1;
      display: flex;
      flex-direction: row;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      overflow-x: auto;
      overflow-y: auto;
    }

    .cp-modal-card {
      flex-shrink: 0;
      width: 260px;
      background: #0a0a18;
      border: 1px solid #1e2a3a;
      border-radius: 7px;
      overflow: hidden;
      align-self: flex-start;
    }

    .cp-modal-card-header {
      padding: 7px 11px;
      background: #0f0f28;
      border-bottom: 1px solid #141e2a;
      font-size: 10px;
      font-weight: 700;
      color: #3a3a6a;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .cp-modal-card-header span { color: #2a2a4a; font-weight: 400; }

    #call-paths-expand-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 700;
      color: #3a4a6a;
      background: #0a0a1e;
      border: 1px solid #1e2a40;
      border-radius: 4px;
      padding: 2px 7px;
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: color 0.12s, border-color 0.12s;
    }

    #call-paths-expand-btn:hover { color: #818cf8; border-color: #3030aa; }

    /* ── Shared detail-panel content styles ──────────────────────────────── */
    .detail-section { padding: 14px 14px 0; }
    .detail-section + .detail-section { border-top: 1px solid #1e1e3a; margin-top: 10px; padding-top: 10px; }

    .edge-item {
      background: #1a1a3a;
      border: 1px solid #2d2d5a;
      border-radius: 6px;
      padding: 10px 12px;
      margin: 10px 14px 0;
    }

    .edge-item:last-child { margin-bottom: 14px; }

    .edge-item-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }

    .edge-kind-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      background: #0f0f23;
      padding: 1px 6px;
      border-radius: 3px;
      border: 1px solid #2d2d5a;
    }

    .edge-line-info { font-size: 11px; color: #475569; }

    .zed-link {
      font-size: 11px;
      color: #4A90D9;
      text-decoration: none;
      padding: 1px 5px;
      border-radius: 3px;
      border: 1px solid #2a4a6a;
      transition: background 0.12s, color 0.12s;
    }

    .zed-link:hover { background: #1a2a3a; color: #7ab0e8; }

    .source-context {
      margin-top: 6px;
      background: #0f0f23;
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 11px;
      font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
      overflow-x: auto;
      line-height: 1.6;
    }

    .context-line { display: block; white-space: pre; }
    .context-line.target { color: #f0c040; background: rgba(240,192,64,0.08); }
    .context-line:not(.target) { color: #475569; }
    .context-line-num {
      display: inline-block;
      min-width: 28px;
      text-align: right;
      padding-right: 10px;
      color: #2d3a4a;
      user-select: none;
    }
    .context-line.target .context-line-num { color: #7a6010; }

    /* ── Misc ─────────────────────────────────────────────────────────────── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0f0f23; }
    ::-webkit-scrollbar-thumb { background: #2d2d5a; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #4a4a8a; }

    .error-notice {
      padding: 16px;
      background: #2a1018;
      border: 1px solid #5a1a28;
      border-radius: 6px;
      color: #fc8181;
      font-size: 13px;
      margin: 12px;
    }
  </style>
</head>
<body>
  <header>
    <h1>ts&#x2011;investigator <span>/ ${escapeHtml(graph.projectRoot.split('/').pop() ?? graph.projectRoot)}</span></h1>
    <div class="stats">
      <span class="stat-badge nodes">${nodeCount} nodes</span>
      <span class="stat-badge edges">${edgeCount} edges</span>
      ${functionCount > 0 ? `<span class="stat-badge fn">${functionCount} fn</span>` : ''}
      ${classCount > 0 ? `<span class="stat-badge cls">${classCount} class</span>` : ''}
      ${interfaceCount > 0 ? `<span class="stat-badge iface">${interfaceCount} iface</span>` : ''}
    </div>
    <div class="filter-bar">
      <span class="filter-bar-label">Show:</span>
      <button class="filter-pill" data-filter="function" title="Toggle function nodes">fn</button>
      <button class="filter-pill" data-filter="class" title="Toggle class nodes">class</button>
      <button class="filter-pill" data-filter="interface" title="Toggle interface nodes">interface</button>
      <button class="filter-pill" data-filter="typeAlias" title="Toggle type alias nodes">type</button>
      <button class="filter-pill" data-filter="module" title="Toggle module nodes">module</button>
      <div class="filter-divider"></div>
      <button class="filter-pill hiding" data-filter="tests" title="Toggle test files">tests</button>
      <button class="filter-pill hiding" data-filter="fixtures" title="Toggle fixture files">fixtures</button>
      <button class="filter-pill hiding" data-filter="mocks" title="Toggle mock files">mocks</button>
    </div>
  </header>
  <div id="cluster-bar">
    <!-- Populated by JS from __clusterInfo__ -->
  </div>
  <main>
    <div id="graph-container">
      <div id="svg-layer">
        ${svgContent}
      </div>
      <div id="zoom-controls">
        <button class="zoom-btn" id="zoom-in-btn"    title="Zoom in (+ or =)">+</button>
        <button class="zoom-btn wide" id="zoom-fit-btn"   title="Fit to screen (F)">fit</button>
        <button class="zoom-btn wide" id="zoom-reset-btn" title="Reset to 100% (0)">1:1</button>
        <button class="zoom-btn" id="zoom-out-btn"   title="Zoom out (\u2212)">\u2212</button>
        <span id="zoom-level">100%</span>
        <span id="highlight-depth-indicator" title="Scroll over selected node to change depth">d:1</span>
      </div>
    </div>
    <div id="call-paths-modal">
      <div id="call-paths-modal-backdrop"></div>
      <div id="call-paths-modal-dialog">
        <div id="call-paths-modal-header">
          <h2>Call Paths</h2>
          <span id="call-paths-modal-subtitle"></span>
          <button id="call-paths-modal-close" title="Close (Esc)">\u2715</button>
        </div>
        <div id="call-paths-modal-body"></div>
      </div>
    </div>
    <div id="detail-panel" style="display:none;">
      <div id="detail-panel-header">
        <h2 id="detail-panel-title">Node Detail</h2>
        <button id="close-panel-btn" title="Close panel">&#x2715;</button>
      </div>
      <div id="detail-loading">Loading&hellip;</div>
      <div id="detail-content">
        <div id="detail-placeholder">Click a node or edge count to inspect it.</div>
      </div>
    </div>
  </main>

  <script>${embeddedScript}</script>
  <script>
    (function () {
      'use strict';

      // ── Utilities ─────────────────────────────────────────────────────────
      function escapeHtml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function clamp(val, lo, hi) { return Math.max(lo, Math.min(hi, val)); }

      // ── Zoom ──────────────────────────────────────────────────────────────
      var MIN_ZOOM = 0.1, MAX_ZOOM = 4.0, ZOOM_STEP = 0.15;
      var currentZoom = 1.0, panX = 0, panY = 0;
      var svgLayer        = document.getElementById('svg-layer');
      var zoomLevelEl     = document.getElementById('zoom-level');
      var graphContainer  = document.getElementById('graph-container');

      function applyTransform() {
        if (svgLayer) {
          svgLayer.style.transform =
            'translate(' + panX + 'px, ' + panY + 'px) scale(' + currentZoom + ')';
        }
        if (zoomLevelEl) zoomLevelEl.textContent = Math.round(currentZoom * 100) + '%';
      }

      function zoomBy(delta, originX, originY) {
        var next = clamp(currentZoom + delta, MIN_ZOOM, MAX_ZOOM);
        if (next === currentZoom) return;
        var ox = (originX === undefined) ? (graphContainer ? graphContainer.clientWidth / 2 : 0) : originX;
        var oy = (originY === undefined) ? (graphContainer ? graphContainer.clientHeight / 2 : 0) : originY;
        var scale = next / currentZoom;
        panX = ox + (panX - ox) * scale;
        panY = oy + (panY - oy) * scale;
        currentZoom = next;
        applyTransform();
      }

      function zoomIn(ox, oy)  { zoomBy(+ZOOM_STEP, ox, oy); }
      function zoomOut(ox, oy) { zoomBy(-ZOOM_STEP, ox, oy); }
      function zoomReset()     { currentZoom = 1.0; panX = 0; panY = 0; applyTransform(); }

      function zoomFit() {
        if (!svgLayer || !graphContainer) return;
        var svg = svgLayer.querySelector('svg');
        if (!svg) return;
        var vb = svg.getAttribute('viewBox');
        var svgW, svgH;
        if (vb) {
          var parts = vb.trim().split(/[\s,]+/);
          svgW = parseFloat(parts[2] || '0');
          svgH = parseFloat(parts[3] || '0');
        } else {
          svgW = svg.scrollWidth;
          svgH = svg.scrollHeight;
        }
        if (!svgW || !svgH) return;
        var pad = 32;
        var cW = graphContainer.clientWidth, cH = graphContainer.clientHeight;
        currentZoom = clamp(Math.min((cW - pad) / svgW, (cH - pad) / svgH), MIN_ZOOM, MAX_ZOOM);
        panX = (cW - svgW * currentZoom) / 2;
        panY = (cH - svgH * currentZoom) / 2;
        applyTransform();
      }

      var zoomInBtn    = document.getElementById('zoom-in-btn');
      var zoomOutBtn   = document.getElementById('zoom-out-btn');
      var zoomResetBtn = document.getElementById('zoom-reset-btn');
      var zoomFitBtn   = document.getElementById('zoom-fit-btn');
      if (zoomInBtn)    zoomInBtn.addEventListener('click',    function(e) { e.stopPropagation(); zoomIn(); });
      if (zoomOutBtn)   zoomOutBtn.addEventListener('click',   function(e) { e.stopPropagation(); zoomOut(); });
      if (zoomResetBtn) zoomResetBtn.addEventListener('click', function(e) { e.stopPropagation(); zoomReset(); });
      if (zoomFitBtn)   zoomFitBtn.addEventListener('click',   function(e) { e.stopPropagation(); zoomFit(); });

      if (graphContainer) {
        graphContainer.addEventListener('wheel', function(e) {
          e.preventDefault();
          // If cursor is over the selected node, change highlight depth instead of zooming
          if (selectedNode && e.target instanceof Element && e.target.closest('.node') === selectedNode) {
            var delta = e.deltaY < 0 ? 1 : -1;
            highlightDepth = Math.max(1, Math.min(10, highlightDepth + delta));
            var nid = selectedNode.getAttribute('id');
            if (nid) updateHighlights(nid);
            return;
          }
          var rect = graphContainer.getBoundingClientRect();
          zoomBy(e.deltaY < 0 ? +ZOOM_STEP : -ZOOM_STEP, e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });
      }

      document.addEventListener('keydown', function(e) {
        var tag = (e.target instanceof Element) ? e.target.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === '+' || e.key === '=')       { e.preventDefault(); zoomIn(); }
        else if (e.key === '-' || e.key === '_')  { e.preventDefault(); zoomOut(); }
        else if (e.key === '0')                   { e.preventDefault(); zoomReset(); }
        else if (e.key === 'f' || e.key === 'F')  { e.preventDefault(); zoomFit(); }
      });

      // Drag-to-pan
      (function() {
        var dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
        if (!graphContainer) return;
        graphContainer.addEventListener('mousedown', function(e) {
          if (e.button !== 0) return;
          if (e.target instanceof Element &&
              (e.target.closest('.node') || e.target.closest('.edge') || e.target.closest('#zoom-controls'))) return;
          dragging = true;
          dragStartX = e.clientX; dragStartY = e.clientY;
          panStartX = panX; panStartY = panY;
          graphContainer.style.cursor = 'grabbing';
          e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
          if (!dragging) return;
          panX = panStartX + (e.clientX - dragStartX);
          panY = panStartY + (e.clientY - dragStartY);
          applyTransform();
        });
        window.addEventListener('mouseup', function() {
          if (!dragging) return;
          dragging = false;
          if (graphContainer) graphContainer.style.cursor = 'grab';
        });
      })();

      // ── Filter system ──────────────────────────────────────────────────────
      // Patterns used to classify a node's filePath into a file category.
      var FILE_CATEGORY_PATTERNS = {
        tests:    /(\.(test|spec)\.(ts|tsx|js|jsx)$|(^|[/\\\\])(tests?|__tests?__|spec)[/\\\\])/i,
        fixtures: /((^|[/\\\\])fixtures?[/\\\\]|\.fixture\.(ts|tsx|js|jsx)$)/i,
        mocks:    /((^|[/\\\\])(__mocks__|mocks?)[/\\\\]|\.mock\.(ts|tsx|js|jsx)$)/i,
      };

      // Build nodeInfoMap from embedded data: nodeId -> {kind, fileCategory}
      var nodeInfoMap = {};
      (__graphNodes__ || []).forEach(function(n) {
        var cat = null;
        var fp = n.filePath;
        if (FILE_CATEGORY_PATTERNS.tests.test(fp))    cat = 'tests';
        else if (FILE_CATEGORY_PATTERNS.fixtures.test(fp)) cat = 'fixtures';
        else if (FILE_CATEGORY_PATTERNS.mocks.test(fp))    cat = 'mocks';
        nodeInfoMap[n.id] = { kind: n.kind, fileCategory: cat };
      });

      // Build nodeToEdgeIds: nodeId -> [svgEdgeElementId, ...]
      var nodeToEdgeIds = {};
      (__edgeGroupData__ || []).forEach(function(eg) {
        if (!nodeToEdgeIds[eg.from]) nodeToEdgeIds[eg.from] = [];
        if (!nodeToEdgeIds[eg.to])   nodeToEdgeIds[eg.to]   = [];
        nodeToEdgeIds[eg.from].push(eg.id);
        nodeToEdgeIds[eg.to].push(eg.id);
      });

      // Pre-build element lookup maps — rebuilt after every cluster re-render.
      var edgeElementMap = {};
      function rebuildEdgeElementMap() {
        edgeElementMap = {};
        document.querySelectorAll('#graph-container svg g').forEach(function(el) {
          var eid = el.getAttribute('id');
          if (eid) edgeElementMap[eid] = el;
        });
      }

      var nodeElementMap = {};
      function rebuildNodeElementMap() {
        nodeElementMap = {};
        document.querySelectorAll('#graph-container svg .node').forEach(function(el) {
          var nid = el.getAttribute('id');
          if (nid) nodeElementMap[nid] = el;
        });
      }

      rebuildEdgeElementMap();
      rebuildNodeElementMap();

      // ── Highlight system ──────────────────────────────────────────────────
      var MAX_HIGHLIGHT_DEPTH_CSS = 4;   // CSS classes only go to depth 4
      var highlightDepth = 1;            // current user-selected depth

      function showDepthIndicator(depth) {
        var el = document.getElementById('highlight-depth-indicator');
        if (!el) return;
        el.style.display = 'block';
        el.classList.add('active');
        el.textContent = 'd:' + depth;
        el.title = 'Highlight depth ' + depth + ' \u2014 scroll over selected node to change';
      }

      function hideDepthIndicator() {
        var el = document.getElementById('highlight-depth-indicator');
        if (!el) return;
        el.style.display = 'none';
        el.classList.remove('active');
      }

      // Traverse the visible graph from nodeId up to maxDepth hops.
      // Returns { outEdges: {svgId: depth}, inEdges: {svgId: depth}, nodes: {nodeId: depth} }
      function computeHighlights(nodeId, maxDepth) {
        var outEdges = {}, inEdges = {}, highlightedNodes = {};
        var frontier = [nodeId];
        var visited  = {};
        visited[nodeId] = true;

        for (var depth = 1; depth <= maxDepth; depth++) {
          var nextFrontier = [];

          frontier.forEach(function(nid) {
            var edgeIds = nodeToEdgeIds[nid] || [];
            edgeIds.forEach(function(eid) {
              var edgeEl = edgeElementMap[eid];
              if (!edgeEl || edgeEl.style.display === 'none') return;

              var group = edgeSvgIdToGroup[eid];
              if (!group) return;

              var isOutgoing = group.from === nid;
              var peer = isOutgoing ? group.to : group.from;

              var peerEl = nodeElementMap[peer];
              if (!peerEl || peerEl.style.display === 'none') return;

              // Record edge (first encounter wins — shallower depth)
              if (isOutgoing) { if (outEdges[eid] === undefined) outEdges[eid] = depth; }
              else            { if (inEdges[eid]  === undefined) inEdges[eid]  = depth; }

              if (!visited[peer]) {
                visited[peer] = true;
                if (highlightedNodes[peer] === undefined) highlightedNodes[peer] = depth;
                nextFrontier.push(peer);
              }
            });
          });

          frontier = nextFrontier;
          if (frontier.length === 0) break;
        }

        return { outEdges: outEdges, inEdges: inEdges, nodes: highlightedNodes };
      }

      function applyHighlights(highlights, rootNodeId) {
        var cssDepth = function(d) { return Math.min(d, MAX_HIGHLIGHT_DEPTH_CSS); };

        Object.keys(highlights.outEdges).forEach(function(eid) {
          var el = edgeElementMap[eid];
          if (el) el.classList.add('highlight-out-' + cssDepth(highlights.outEdges[eid]));
        });
        Object.keys(highlights.inEdges).forEach(function(eid) {
          var el = edgeElementMap[eid];
          if (el) el.classList.add('highlight-in-' + cssDepth(highlights.inEdges[eid]));
        });
        Object.keys(highlights.nodes).forEach(function(nid) {
          var el = nodeElementMap[nid];
          if (el) el.classList.add('highlight-node-' + cssDepth(highlights.nodes[nid]));
        });

        if (graphContainer) graphContainer.classList.add('highlighting');
      }

      function clearAllHighlights() {
        ['edge', 'node'].forEach(function(cls) {
          document.querySelectorAll('#graph-container svg .' + cls).forEach(function(el) {
            var toRemove = [];
            el.classList.forEach(function(c) { if (c.startsWith('highlight-')) toRemove.push(c); });
            toRemove.forEach(function(c) { el.classList.remove(c); });
          });
        });
        if (graphContainer) graphContainer.classList.remove('highlighting');
        hideDepthIndicator();
      }

      function updateHighlights(nodeId) {
        clearAllHighlights();
        var h = computeHighlights(nodeId, highlightDepth);
        applyHighlights(h, nodeId);
        showDepthIndicator(highlightDepth);
      }

      // ── Call-paths modal ──────────────────────────────────────────────────
      var lastCallPathsData = null;

      function renderCallPathsFull(data, nodeLabel) {
        if (!data || !data.paths || data.paths.length === 0) {
          return '<div style="padding:20px;color:#475569;font-style:italic;">No call paths found.</div>';
        }
        var html = '';
        if (data.truncated) {
          html += '<div style="flex-basis:100%;padding:8px 12px;margin-bottom:4px;background:#1a1208;'
            + 'border:1px solid #3a2800;border-radius:5px;font-size:11px;color:#7a5a00;">'
            + '\u26a0\ufe0f Results truncated at ' + data.paths.length + ' paths. '
            + 'Increase MAX_CALL_PATHS in the server to see more.</div>';
        }
        data.paths.forEach(function(pathSteps, idx) {
          html += '<div class="cp-modal-card">';
          html += '<div class="cp-modal-card-header">Path ' + (idx + 1)
            + ' <span>(' + pathSteps.length + ' step' + (pathSteps.length !== 1 ? 's' : '') + ')</span></div>';
          pathSteps.forEach(function(step, stepIdx) {
            if (stepIdx > 0) html += '<div class="call-path-arrow">\u2193</div>';
            var absPath = step.filePath;
            var zedUrl = step.line ? 'zed://file/' + escapeHtml(absPath) + ':' + step.line : null;
            html += '<div class="call-path-step' + (step.isTarget ? ' is-target' : '') + '">';
            html += '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">';
            html += '<span class="call-path-step-name">' + escapeHtml(step.name) + '</span>';
            html += '<span class="edge-kind-badge">' + escapeHtml(step.kind) + '</span>';
            if (zedUrl) html += '<a class="call-path-zed" href="' + escapeHtml(zedUrl) + '">\u2197 Zed</a>';
            html += '</div>';
            html += '<div class="call-path-step-meta">' + escapeHtml(step.filePath)
              + (step.line ? ':' + step.line : '') + '</div>';
            if (step.parameters && step.parameters.length > 0) {
              html += '<div class="call-path-step-params">';
              step.parameters.forEach(function(param) {
                var constraint = typeInfoToConstraint(param.typeInfo);
                html += '<span>' + escapeHtml(param.name) + (param.isOptional ? '?' : '')
                  + ': <em>' + escapeHtml(constraint) + '</em>'
                  + (param.defaultValue ? ' = ' + escapeHtml(param.defaultValue) : '') + '</span>';
              });
              html += '</div>';
            }
            html += '</div>';
          });
          html += '</div>';
        });
        return html;
      }

      function openCallPathsModal(data, nodeId) {
        var modal    = document.getElementById('call-paths-modal');
        var body     = document.getElementById('call-paths-modal-body');
        var subtitle = document.getElementById('call-paths-modal-subtitle');
        if (!modal || !body) return;
        var label = nodeId ? nodeId.split('#').pop() || nodeId : '';
        if (subtitle) {
          subtitle.textContent = (label ? '\u2192 ' + label + ' \u2014 ' : '')
            + data.paths.length + (data.truncated ? '+' : '') + ' path'
            + (data.paths.length !== 1 ? 's' : '');
        }
        body.innerHTML = renderCallPathsFull(data, label);
        modal.classList.add('open');
      }

      function closeCallPathsModal() {
        var modal = document.getElementById('call-paths-modal');
        if (modal) modal.classList.remove('open');
      }

      // Close on backdrop click
      var modalBackdrop = document.getElementById('call-paths-modal-backdrop');
      if (modalBackdrop) modalBackdrop.addEventListener('click', closeCallPathsModal);
      var modalCloseBtn = document.getElementById('call-paths-modal-close');
      if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeCallPathsModal);
      // Close on Escape key
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          var modal = document.getElementById('call-paths-modal');
          if (modal && modal.classList.contains('open')) { closeCallPathsModal(); return; }
        }
      });

      // ── Cluster switching ─────────────────────────────────────────────────
      var visibleClusters = new Set(__initialVisibleClusters__ || []);

      function buildClusterButtons() {
        var bar = document.getElementById('cluster-bar');
        if (!bar) return;
        bar.innerHTML = '<span class="cluster-bar-label">Clusters</span>';
        (__clusterInfo__ || []).forEach(function(c) {
          var isActive = visibleClusters.has(c.id);
          var btn = document.createElement('button');
          btn.className = 'cluster-btn'
            + (isActive       ? ' active'        : '')
            + (c.hasEntrypoint ? ' is-entrypoint' : '')
            + (c.isOrphan      ? ' is-orphan'     : '');
          btn.setAttribute('data-cluster', c.id);
          btn.setAttribute('title',
            c.label + ' \u2014 ' + c.nodeCount + ' node' + (c.nodeCount !== 1 ? 's' : '')
            + (c.hasEntrypoint ? ' (entrypoint)' : c.isOrphan ? ' (orphaned)' : ''));
          btn.textContent = c.label + ' (' + c.nodeCount + ')';
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (visibleClusters.has(c.id)) {
              if (visibleClusters.size > 1) visibleClusters.delete(c.id);
            } else {
              visibleClusters.add(c.id);
            }
            buildClusterButtons();
            switchClusters(Array.from(visibleClusters));
          });
          bar.appendChild(btn);
        });
      }

      function switchClusters(clusterIds) {
        var svgLayer = document.getElementById('svg-layer');
        if (!svgLayer) return;
        // Clear highlights, selection, and panel before swapping SVG
        clearAllHighlights();
        highlightDepth = 1;
        if (selectedNode) { selectedNode.classList.remove('selected'); selectedNode = null; }
        if (panel) panel.style.display = 'none';
        svgLayer.innerHTML =
          '<div style="padding:24px;color:#3a3a6a;font-size:12px;font-style:italic;">Rendering\u2026</div>';

        fetch('/api/render?clusters=' + encodeURIComponent(clusterIds.join(',')))
          .then(function(r) {
            if (!r.ok) throw new Error('Render request failed: ' + r.status);
            return r.text();
          })
          .then(function(svg) {
            svgLayer.innerHTML = svg;
            rebuildEdgeElementMap();
            rebuildNodeElementMap();
            attachNodeHandlers();
            attachEdgeLabelHandlers();
            applyFilters();
            zoomFit();
          })
          .catch(function(e) {
            svgLayer.innerHTML =
              '<div class="error-notice" style="margin:20px;">Render failed: '
              + escapeHtml(String(e)) + '</div>';
          });
      }

      // hiddenSet: category/kind key -> true when those nodes are hidden
      // Tests, fixtures, and mocks are hidden by default.
      var hiddenSet = { tests: true, fixtures: true, mocks: true };

      function isNodeHidden(nodeId) {
        var info = nodeInfoMap[nodeId];
        if (!info) return false;
        if (info.fileCategory !== null && hiddenSet[info.fileCategory]) return true;
        if (hiddenSet[info.kind]) return true;
        return false;
      }

      function applyFilters() {
        // Compute the set of hidden node ids
        var hiddenNodeIds = {};
        Object.keys(nodeInfoMap).forEach(function(nodeId) {
          if (isNodeHidden(nodeId)) hiddenNodeIds[nodeId] = true;
        });

        // Show/hide SVG node elements
        document.querySelectorAll('#graph-container svg .node').forEach(function(el) {
          var nid = el.getAttribute('id');
          if (nid) el.style.display = hiddenNodeIds[nid] ? 'none' : '';
        });

        // Collect edge element ids whose either endpoint is hidden
        var hiddenEdgeIds = {};
        Object.keys(hiddenNodeIds).forEach(function(nid) {
          var eids = nodeToEdgeIds[nid] || [];
          eids.forEach(function(eid) { hiddenEdgeIds[eid] = true; });
        });

        // Show/hide SVG edge elements
        document.querySelectorAll('#graph-container svg .edge').forEach(function(el) {
          var eid = el.getAttribute('id');
          if (eid) el.style.display = hiddenEdgeIds[eid] ? 'none' : '';
        });

        // If the currently selected node became hidden, close the panel
        if (selectedNode) {
          var selId = selectedNode.getAttribute('id');
          if (selId && hiddenNodeIds[selId]) hidePanel();
        }

        // Update effective-orphan styling after every filter change
        updateEffectiveOrphans();
      }

      // Wire filter pill click handlers
      document.querySelectorAll('.filter-pill').forEach(function(pill) {
        pill.addEventListener('click', function(e) {
          e.stopPropagation();
          var cat = pill.getAttribute('data-filter');
          if (!cat) return;
          if (hiddenSet[cat]) {
            delete hiddenSet[cat];
            pill.classList.remove('hiding');
          } else {
            hiddenSet[cat] = true;
            pill.classList.add('hiding');
          }
          applyFilters();
        });
      });

      // ── Effective-orphan detection ─────────────────────────────────────────
      // A visible node is "effectively orphaned" when all its connected edges are
      // hidden by the current filter state. Called after every applyFilters().
      function updateEffectiveOrphans() {
        document.querySelectorAll('#graph-container svg .node').forEach(function(nodeEl) {
          if (nodeEl.style.display === 'none') {
            nodeEl.classList.remove('effective-orphan');
            return;
          }
          var nid = nodeEl.getAttribute('id');
          if (!nid) return;

          var edgeIds = nodeToEdgeIds[nid] || [];
          if (edgeIds.length === 0) {
            // Truly isolated — already in the Graphviz orphan cluster box;
            // skip the dynamic class so we don't double-dim them.
            nodeEl.classList.remove('effective-orphan');
            return;
          }

          var hasVisibleEdge = edgeIds.some(function(eid) {
            var edgeEl = edgeElementMap[eid];
            return edgeEl && edgeEl.style.display !== 'none';
          });

          if (hasVisibleEdge) {
            nodeEl.classList.remove('effective-orphan');
          } else {
            nodeEl.classList.add('effective-orphan');
          }
        });
      }

      // ── Detail panel ──────────────────────────────────────────────────────
      var panel      = document.getElementById('detail-panel');
      var content    = document.getElementById('detail-content');
      var loading    = document.getElementById('detail-loading');
      var closeBtn   = document.getElementById('close-panel-btn');
      var panelTitle = document.getElementById('detail-panel-title');
      var selectedNode = null;

      function showPanel(title) {
        if (panel) panel.style.display = 'flex';
        if (panelTitle) panelTitle.textContent = title || 'Node Detail';
      }

      function hidePanel() {
        if (panel) panel.style.display = 'none';
        if (selectedNode) { selectedNode.classList.remove('selected'); selectedNode = null; }
        clearAllHighlights();
        highlightDepth = 1;
      }

      function setLoading(on) {
        if (loading) loading.style.display = on ? 'block' : 'none';
        if (content) content.style.visibility = on ? 'hidden' : 'visible';
      }

      function setContent(html) {
        if (content) content.innerHTML = html;
      }

      if (closeBtn) closeBtn.addEventListener('click', hidePanel);

      if (graphContainer) {
        graphContainer.addEventListener('click', function(evt) {
          if (evt.target === graphContainer ||
              (evt.target instanceof SVGElement && evt.target.tagName === 'svg')) {
            hidePanel();
          }
        });
      }

      // ── Edge count badge click handlers ───────────────────────────────────
      // Build id -> group map from embedded data
      var edgeSvgIdToGroup = {};
      (__edgeGroupData__ || []).forEach(function(eg) {
        edgeSvgIdToGroup[eg.id] = { from: eg.from, to: eg.to, count: eg.count };
      });

      // ── TypeInfo → human-readable constraint string ────────────────────────
      function typeInfoToConstraint(ti) {
        if (!ti) return '?';
        switch (ti.kind) {
          case 'primitive':    return ti.name;
          case 'literal':      return JSON.stringify(ti.value);
          case 'array':        return typeInfoToConstraint(ti.elementType) + '[]';
          case 'tuple':        return '[' + ti.elements.map(typeInfoToConstraint).join(', ') + ']';
          case 'union':        return ti.members.map(typeInfoToConstraint).join(' | ');
          case 'intersection': return ti.members.map(typeInfoToConstraint).join(' & ');
          case 'reference':
            return ti.name + (ti.typeArguments && ti.typeArguments.length
              ? '<' + ti.typeArguments.map(typeInfoToConstraint).join(', ') + '>'
              : '');
          case 'object':
            if (!ti.properties || ti.properties.length === 0) return '{}';
            return '{ ' + ti.properties.slice(0, 4).map(function(p) {
              return p.name + (p.isOptional ? '?' : '') + ': ' + typeInfoToConstraint(p.typeInfo);
            }).join(', ') + (ti.properties.length > 4 ? ', …' : '') + ' }';
          case 'function':
            return '(' + (ti.parameters || []).map(function(p) {
              return p.name + ': ' + typeInfoToConstraint(p.typeInfo);
            }).join(', ') + ') => ' + typeInfoToConstraint(ti.returnType);
          case 'unknown':      return ti.raw || '?';
          default:             return '?';
        }
      }

      // ── Call-path renderer (compact — detail panel) ───────────────────────
      function renderCallPaths(data) {
        if (!data || !data.paths || data.paths.length === 0) {
          return '<div style="padding:10px 14px;font-size:12px;color:#475569;font-style:italic;">'
            + 'No call paths found leading to this node.</div>';
        }

        var html = '<div style="padding:0 14px 4px;">'
          + '<div style="display:flex;align-items:center;justify-content:space-between;margin:12px 0 6px;">'
          + '<p style="font-size:10px;font-weight:700;color:#3a3a6a;text-transform:uppercase;'
          + 'letter-spacing:0.08em;margin:0;">Call Paths ('
          + data.paths.length + (data.truncated ? '+' : '') + ')</p>'
          + '<button id="call-paths-expand-btn" title="View all paths in full detail">'
          + '\u2922 Expand</button>'
          + '</div></div>';

        if (data.truncated) {
          html += '<div style="margin:0 14px 6px;padding:5px 8px;background:#1a1208;'
            + 'border:1px solid #3a2800;border-radius:4px;font-size:10px;color:#7a5a00;">'
            + '\u26a0\ufe0f Truncated — expand to see all ' + data.paths.length + '+ paths.</div>';
        }

        data.paths.forEach(function(pathSteps, pathIdx) {
          html += '<div class="call-path">';

          pathSteps.forEach(function(step, stepIdx) {
            // Arrow between steps
            if (stepIdx > 0) {
              html += '<div class="call-path-arrow">\u2193</div>';
            }

            var absPath = step.filePath;
            var zedUrl = step.line
              ? 'zed://file/' + escapeHtml(absPath) + ':' + step.line
              : null;

            html += '<div class="call-path-step' + (step.isTarget ? ' is-target' : '') + '">';
            html += '<div style="display:flex;align-items:center;gap:6px;">';
            html += '<span class="call-path-step-name">' + escapeHtml(step.name) + '</span>';
            html += '<span class="edge-kind-badge">' + escapeHtml(step.kind) + '</span>';
            if (zedUrl) {
              html += '<a class="call-path-zed" href="' + escapeHtml(zedUrl) + '">\u2197 Zed</a>';
            }
            html += '</div>';

            // File + line
            html += '<div class="call-path-step-meta">'
              + escapeHtml(step.filePath)
              + (step.line ? ':' + step.line : '')
              + '</div>';

            // Parameters with type constraints
            if (step.parameters && step.parameters.length > 0) {
              html += '<div class="call-path-step-params">';
              step.parameters.forEach(function(param) {
                var constraint = typeInfoToConstraint(param.typeInfo);
                html += '<span>'
                  + escapeHtml(param.name)
                  + (param.isOptional ? '?' : '')
                  + ': <em>' + escapeHtml(constraint) + '</em>'
                  + (param.defaultValue ? ' = ' + escapeHtml(param.defaultValue) : '')
                  + '</span>';
              });
              html += '</div>';
            }

            html += '</div>'; // .call-path-step
          });

          html += '</div>'; // .call-path
        });

        return html;
      }

      // Renders a labelled section of edge items (used in node detail view).
      // direction: 'Outgoing' | 'Incoming' — controls which end is shown as the peer label.
      function renderEdgeSectionHtml(items, direction) {
        if (!items || items.length === 0) return '';
        var html = '<div style="padding:0 14px;">'
          + '<p style="font-size:10px;font-weight:700;color:#3a3a6a;text-transform:uppercase;'
          + 'letter-spacing:0.08em;margin:12px 0 4px;">'
          + escapeHtml(direction) + ' (' + items.length + ')</p></div>';

        items.forEach(function(item) {
          var peerId = direction === 'Outgoing' ? item.to : item.from;
          var peerLabel = (peerId || '').split('#').pop() || peerId;

          html += '<div class="edge-item">';
          html += '<div class="edge-item-header">';
          html += '<span style="font-size:11px;color:#818cf8;font-weight:600;'
            + 'word-break:break-all;flex:1;min-width:0;">' + escapeHtml(peerLabel) + '</span>';
          html += '<span class="edge-kind-badge">' + escapeHtml(item.kind) + '</span>';
          if (item.line !== undefined && item.line !== null) {
            html += '<span class="edge-line-info">line ' + escapeHtml(String(item.line)) + '</span>';
          }
          if (item.zedUrl) {
            html += '<a class="zed-link" href="' + escapeHtml(item.zedUrl)
              + '" title="Open in Zed">\u2197 Zed</a>';
          }
          html += '</div>';

          if (item.importedNames && item.importedNames.length > 0) {
            html += '<p style="font-size:11px;color:#64748b;margin-bottom:6px;">'
              + 'Imports: <code style="color:#818cf8;">'
              + item.importedNames.map(escapeHtml).join(', ') + '</code>'
              + (item.isTypeOnly ? ' <em style="color:#475569;">(type only)</em>' : '')
              + '</p>';
          }

          if (item.contextLines && item.contextLines.length > 0) {
            html += '<div class="source-context">';
            item.contextLines.forEach(function(line) {
              var cls = 'context-line' + (line.isTarget ? ' target' : '');
              html += '<span class="' + cls + '">'
                + '<span class="context-line-num">' + escapeHtml(String(line.lineNumber)) + '</span>'
                + escapeHtml(line.text) + '</span>';
            });
            html += '</div>';
          }
          html += '</div>';
        });
        return html;
      }

      function renderEdgeDetails(items, fromId, toId) {
        var fromLabel = fromId.split('#').pop() || fromId;
        var toLabel   = toId.split('#').pop()   || toId;

        var html = '<div style="padding:12px 14px 6px;">'
          + '<p style="font-size:13px;font-weight:700;color:#818cf8;margin-bottom:3px;">'
          + escapeHtml(fromLabel) + ' \u2192 ' + escapeHtml(toLabel) + '</p>'
          + '<p style="font-size:11px;color:#475569;margin-bottom:0;">'
          + items.length + ' edge' + (items.length !== 1 ? 's' : '') + ' between these nodes'
          + '</p></div>';

        items.forEach(function(item) {
          html += '<div class="edge-item">';

          // Header row: kind badge + line info + Zed link
          html += '<div class="edge-item-header">';
          html += '<span class="edge-kind-badge">' + escapeHtml(item.kind) + '</span>';

          if (item.line !== undefined && item.line !== null) {
            html += '<span class="edge-line-info">line ' + escapeHtml(String(item.line)) + '</span>';
          }

          if (item.zedUrl) {
            html += '<a class="zed-link" href="' + escapeHtml(item.zedUrl) + '" title="Open in Zed editor">'
              + '\u2197 Zed</a>';
          }
          html += '</div>';

          // Import names
          if (item.importedNames && item.importedNames.length > 0) {
            html += '<p style="font-size:11px;color:#64748b;margin-bottom:6px;">'
              + 'Imports: <code style="color:#818cf8;">'
              + item.importedNames.map(escapeHtml).join(', ')
              + '</code>'
              + (item.isTypeOnly ? ' <em style="color:#475569;">(type only)</em>' : '')
              + '</p>';
          }

          // Source context
          if (item.contextLines && item.contextLines.length > 0) {
            html += '<div class="source-context">';
            item.contextLines.forEach(function(line) {
              var cls = 'context-line' + (line.isTarget ? ' target' : '');
              html += '<span class="' + cls + '">'
                + '<span class="context-line-num">' + escapeHtml(String(line.lineNumber)) + '</span>'
                + escapeHtml(line.text)
                + '</span>';
            });
            html += '</div>';
          }

          html += '</div>'; // .edge-item
        });

        return html;
      }

      function showEdgeDetails(fromId, toId) {
        showPanel('Edge Details');
        setLoading(true);
        fetch('/api/edges?from=' + encodeURIComponent(fromId) + '&to=' + encodeURIComponent(toId))
          .then(function(r) { return r.json(); })
          .then(function(items) {
            setLoading(false);
            setContent(renderEdgeDetails(items, fromId, toId));
          })
          .catch(function(e) {
            setLoading(false);
            setContent('<div class="error-notice">Failed to load edge details: ' + escapeHtml(String(e)) + '</div>');
          });
      }

      function attachEdgeLabelHandlers() {
        document.querySelectorAll('#graph-container svg .edge').forEach(function(edgeEl) {
          var eid = edgeEl.getAttribute('id');
          if (!eid) return;
          var group = edgeSvgIdToGroup[eid];
          if (!group || group.count <= 1) return;

          // Find the text element containing the count badge (×N)
          edgeEl.querySelectorAll('text').forEach(function(textEl) {
            var txt = textEl.textContent || '';
            if (txt.indexOf('\u00d7') === -1) return; // not a count badge

            // Style as clickable
            textEl.classList.add('count-badge');
            textEl.setAttribute('style',
              'cursor:pointer;fill:#f0c040;font-weight:bold;pointer-events:all;');

            textEl.addEventListener('click', function(evt) {
              evt.stopPropagation();
              if (selectedNode) { selectedNode.classList.remove('selected'); selectedNode = null; }
              showEdgeDetails(group.from, group.to);
            });
          });
        });
      }

      // ── Node click handlers ───────────────────────────────────────────────
      function showNodeDetail(nodeId) {
        showPanel('Node Detail');
        setLoading(true);

        // Fetch param form, edge data, and call paths in parallel
        var formReq      = fetch('/api/form/'        + encodeURIComponent(nodeId));
        var edgesReq     = fetch('/api/node-edges/'  + encodeURIComponent(nodeId));
        var callPathsReq = fetch('/api/call-paths/'  + encodeURIComponent(nodeId));

        Promise.all([formReq, edgesReq, callPathsReq])
          .then(function(responses) {
            return Promise.all([
              responses[0].status === 200 ? responses[0].text()  : Promise.resolve(null),
              responses[1].ok             ? responses[1].json()  : Promise.resolve({ node: null, outgoing: [], incoming: [] }),
              responses[2].ok             ? responses[2].json()  : Promise.resolve({ paths: [], truncated: false }),
            ]);
          })
          .then(function(results) {
            var formHtml      = results[0];
            var edgeData      = results[1];
            var callPathsData = results[2];
            var n             = edgeData.node;
            var html          = '';

            // ── Node header ────────────────────────────────────────────────
            if (n) {
              html += '<div style="padding:12px 14px 10px;border-bottom:1px solid #1e1e3a;">'
                + '<p style="font-size:14px;font-weight:700;color:#818cf8;margin:0 0 4px;">'
                + escapeHtml(n.name) + '</p>'
                + '<p style="font-size:11px;color:#64748b;font-weight:600;margin:0 0 4px;">'
                + escapeHtml(n.kind) + '</p>'
                + '<p style="font-size:11px;color:#475569;font-family:monospace;'
                + 'word-break:break-all;margin:0;">' + escapeHtml(n.filePath) + '</p>'
                + '</div>';
            }

            // ── Parameter form (function nodes only) ───────────────────────
            if (formHtml) {
              html += '<div style="border-bottom:1px solid #1e1e3a;">' + formHtml + '</div>';
            }

            // ── Call paths ─────────────────────────────────────────────────
            var callPathsHtml = renderCallPaths(callPathsData);
            if (callPathsHtml) {
              html += '<div style="border-bottom:1px solid #1e1e3a;">' + callPathsHtml + '</div>';
            }

            // ── Outgoing / incoming edges ──────────────────────────────────
            var outHtml = renderEdgeSectionHtml(edgeData.outgoing, 'Outgoing');
            var inHtml  = renderEdgeSectionHtml(edgeData.incoming, 'Incoming');

            if (outHtml || inHtml) {
              html += outHtml + inHtml + '<div style="height:14px;"></div>';
            } else if (!formHtml) {
              html += '<div style="padding:14px;font-size:12px;color:#475569;font-style:italic;">'
                + 'No connections found for this node.</div>';
            }

            if (!html) html = '<div class="error-notice">Node not found.</div>';

            setLoading(false);
            setContent(html);

            // Store call-paths data and wire the expand button now that it's in the DOM
            lastCallPathsData = callPathsData;
            var expandBtn = document.getElementById('call-paths-expand-btn');
            if (expandBtn) {
              expandBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (lastCallPathsData) openCallPathsModal(lastCallPathsData, nodeId);
              });
            }
          })
          .catch(function(e) {
            setLoading(false);
            setContent('<div class="error-notice">Failed to load node detail: '
              + escapeHtml(String(e)) + '</div>');
          });
      }

      function attachNodeHandlers() {
        document.querySelectorAll('#graph-container svg .node').forEach(function(el) {
          el.addEventListener('click', function(evt) {
            evt.stopPropagation();
            var nodeId = el.getAttribute('id');
            if (!nodeId) return;
            // Switching to a new node resets depth to 1
            if (selectedNode !== el) highlightDepth = 1;
            if (selectedNode) selectedNode.classList.remove('selected');
            el.classList.add('selected');
            selectedNode = el;
            updateHighlights(nodeId);
            showNodeDetail(nodeId);
          });
        });
      }

      // ── Bootstrap ─────────────────────────────────────────────────────────
      buildClusterButtons();
      attachNodeHandlers();
      attachEdgeLabelHandlers();
      applyFilters();   // hides test/fixture/mock nodes + runs updateEffectiveOrphans
      rebuildNodeElementMap();
      zoomFit();

    })();
  </script>
</body>
</html>`;
}

/** Escapes a string for safe inclusion in HTML text/attribute content (server-side). */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(
  options: ServerOptions,
): Promise<Result<ServerInstance, ServerError>> {
  const log = options.logger;

  // ── 1. Load graph ──────────────────────────────────────────────────────
  log?.info({ graphPath: options.graphPath }, 'Reading dependency graph');

  const graphResult = readGraph(options.graphPath);
  if (graphResult.isErr()) {
    const fsCode = graphResult.error.code;
    const code: ServerError['code'] =
      fsCode === 'IO_ERROR' || fsCode === 'VALIDATION_FAILED' ? 'GRAPH_NOT_FOUND' : 'UNKNOWN';
    return err(
      makeServerError(
        code,
        `Failed to read graph file at ${options.graphPath}: ${graphResult.error.message}`,
        graphResult.error,
      ),
    );
  }
  const graph = graphResult.value;
  log?.info({ nodeCount: graph.nodes.size, edgeCount: graph.edges.length }, 'Graph loaded');

  // ── 2. Compute components & scope initial render to entrypoint clusters ─
  const components = computeComponents(graph);
  const entrypointClusters = components.clusters.filter((c) => c.hasEntrypoint);
  const initialClusterIds =
    entrypointClusters.length > 0
      ? entrypointClusters.map((c) => c.id)
      : components.clusters.map((c) => c.id);

  const initialNodeIds = new Set<string>();
  for (const cluster of components.clusters) {
    if (initialClusterIds.includes(cluster.id)) {
      for (const nodeId of cluster.nodeIds) initialNodeIds.add(nodeId);
    }
  }
  const initialGraph = filterGraphToNodes(graph, initialNodeIds);
  log?.info(
    { clusters: initialClusterIds, nodeCount: initialNodeIds.size },
    'Initial render scope',
  );

  // ── 3. Render SVG ──────────────────────────────────────────────────────
  log?.info('Rendering graph SVG');
  const renderer = new GraphvizRenderer();
  const renderResult = await renderer.render(initialGraph);
  if (renderResult.isErr()) {
    return err(
      makeServerError(
        'RENDER_FAILED',
        `SVG rendering failed: ${renderResult.error.message}`,
        renderResult.error,
      ),
    );
  }
  const svgContent = renderResult.value;
  log?.info('SVG rendered successfully');

  // ── 4. Serialize graph for API ─────────────────────────────────────────
  const serializedResult = serializeGraph(graph);
  const graphJson = serializedResult.isOk()
    ? serializedResult.value
    : JSON.stringify({ error: 'serialization failed' });

  // ── 5. Build HTML page ─────────────────────────────────────────────────
  const htmlPage = buildHtmlPage(graph, svgContent, components, initialClusterIds);

  // ── 5. Wire up Express ────────────────────────────────────────────────
  const app = express();
  const fieldFactory = new FieldFactory();

  // GET / — full interactive page
  app.get('/', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlPage);
  });

  // GET /api/graph — full serialized graph JSON
  app.get('/api/graph', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(graphJson);
  });

  // GET /api/nodes — lightweight node summaries for client-side use
  app.get('/api/nodes', (_req: Request, res: Response) => {
    const summaries: NodeSummary[] = Array.from(graph.nodes.values()).map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      filePath: n.filePath,
    }));
    res.json(summaries);
  });

  // GET /api/form/:nodeId — returns HTML form for function nodes
  app.get('/api/form/:nodeId', (req: Request, res: Response) => {
    const nodeId = decodeURIComponent(req.params['nodeId'] ?? '');
    if (!nodeId) {
      res.status(400).json({ error: 'Missing nodeId' });
      return;
    }
    const node = graph.nodes.get(nodeId);
    if (node === undefined) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    if (node.kind !== 'function') {
      res.status(404).json({ error: 'Node is not a function' });
      return;
    }
    const formDescriptor = fieldFactory.parametersToForm(node);
    const formHtml = renderFormHtml(formDescriptor);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(formHtml);
  });

  // GET /api/clusters — list all clusters with metadata
  app.get('/api/clusters', (_req: Request, res: Response) => {
    res.json(
      components.clusters.map((c) => ({
        id: c.id,
        label: c.label,
        hasEntrypoint: c.hasEntrypoint,
        isOrphan: c.isOrphan,
        nodeCount: c.nodeIds.size,
      })),
    );
  });

  // GET /api/render?clusters=ep_0,cmp_1,... — re-render SVG for a specific set of clusters
  app.get('/api/render', async (req: Request, res: Response) => {
    const rawClusters = req.query['clusters'];
    const requestedIds =
      typeof rawClusters === 'string' && rawClusters.trim()
        ? rawClusters
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null;

    const validIds = new Set(components.clusters.map((c) => c.id));
    const safeIds = requestedIds
      ? requestedIds.filter((id) => validIds.has(id))
      : Array.from(validIds);

    if (safeIds.length === 0) {
      res.status(400).json({ error: 'No valid cluster IDs provided' });
      return;
    }

    const nodeIds = new Set<string>();
    for (const cluster of components.clusters) {
      if (safeIds.includes(cluster.id)) {
        for (const nodeId of cluster.nodeIds) nodeIds.add(nodeId);
      }
    }

    const filteredGraph = filterGraphToNodes(graph, nodeIds);
    const renderResult = await renderer.render(filteredGraph);

    if (renderResult.isErr()) {
      res.status(500).json({ error: renderResult.error.message });
      return;
    }

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.send(renderResult.value);
  });

  // GET /api/call-paths/:nodeId — all call paths (root→node) with parameter info
  app.get('/api/call-paths/:nodeId', (req: Request, res: Response) => {
    const nodeId = decodeURIComponent(req.params['nodeId'] ?? '');
    if (!nodeId) {
      res.status(400).json({ error: 'Missing nodeId' });
      return;
    }
    if (!graph.nodes.has(nodeId)) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    res.json(findCallPaths(graph, nodeId));
  });

  // GET /api/node-edges/:nodeId — all in/out edges for a node with source context
  app.get('/api/node-edges/:nodeId', (req: Request, res: Response) => {
    const nodeId = decodeURIComponent(req.params['nodeId'] ?? '');
    if (!nodeId) {
      res.status(400).json({ error: 'Missing nodeId' });
      return;
    }
    const node = graph.nodes.get(nodeId);
    if (node === undefined) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    function edgeToItem(edge: GraphEdge): EdgeContextItem {
      const item: EdgeContextItem = { kind: edge.kind, from: edge.from, to: edge.to };
      if (edge.kind === 'import') {
        item.importedNames = edge.importedNames;
        item.isTypeOnly = edge.isTypeOnly;
      }
      const lineNum = edge.kind === 'call' ? edge.line : undefined;
      if (lineNum !== undefined) {
        const sourceNode = graph.nodes.get(edge.from);
        if (sourceNode !== undefined) {
          item.line = lineNum;
          const absFilePath = path.isAbsolute(sourceNode.filePath)
            ? sourceNode.filePath
            : path.join(graph.projectRoot, sourceNode.filePath);
          item.contextLines = readSourceContext(absFilePath, lineNum, 3);
          item.zedUrl = 'zed://file/' + absFilePath + ':' + String(lineNum);
        }
      }
      return item;
    }

    res.json({
      node: { id: node.id, kind: node.kind, name: node.name, filePath: node.filePath },
      outgoing: graph.edges.filter((e) => e.from === nodeId).map(edgeToItem),
      incoming: graph.edges.filter((e) => e.to === nodeId).map(edgeToItem),
    });
  });

  // GET /api/edges?from=<nodeId>&to=<nodeId>
  // Returns all edges between two nodes, with source context and Zed URLs.
  app.get('/api/edges', (req: Request, res: Response) => {
    const rawFrom = req.query['from'];
    const rawTo = req.query['to'];

    if (typeof rawFrom !== 'string' || typeof rawTo !== 'string' || !rawFrom || !rawTo) {
      res.status(400).json({ error: 'Query parameters "from" and "to" are required' });
      return;
    }

    const fromId = decodeURIComponent(rawFrom);
    const toId = decodeURIComponent(rawTo);

    const matchingEdges = graph.edges.filter((e) => e.from === fromId && e.to === toId);
    if (matchingEdges.length === 0) {
      res.status(404).json({ error: 'No edges found between these nodes' });
      return;
    }

    const fromNode = graph.nodes.get(fromId);

    const items: EdgeContextItem[] = matchingEdges.map((edge) => {
      const item: EdgeContextItem = { kind: edge.kind, from: edge.from, to: edge.to };

      if (edge.kind === 'import') {
        item.importedNames = edge.importedNames;
        item.isTypeOnly = edge.isTypeOnly;
      }

      // Source context: only meaningful for edges with a line number
      const lineNum = edge.kind === 'call' ? edge.line : undefined;

      if (lineNum !== undefined && fromNode !== undefined) {
        item.line = lineNum;
        const absFilePath = path.isAbsolute(fromNode.filePath)
          ? fromNode.filePath
          : path.join(graph.projectRoot, fromNode.filePath);
        item.contextLines = readSourceContext(absFilePath, lineNum, 3);
        item.zedUrl = 'zed://file/' + absFilePath + ':' + String(lineNum);
      }

      return item;
    });

    res.json(items);
  });

  // GET /api/source?file=<relOrAbsPath>&line=<n>&context=<n>
  // Low-level endpoint to read source context for arbitrary files/lines.
  app.get('/api/source', (req: Request, res: Response) => {
    const rawFile = req.query['file'];
    const rawLine = req.query['line'];
    const rawContext = req.query['context'];

    if (typeof rawFile !== 'string' || !rawFile) {
      res.status(400).json({ error: 'Query parameter "file" is required' });
      return;
    }

    const lineNum = typeof rawLine === 'string' ? parseInt(rawLine, 10) : 1;
    const radius = typeof rawContext === 'string' ? Math.min(parseInt(rawContext, 10), 20) : 3;

    if (isNaN(lineNum) || lineNum < 1) {
      res.status(400).json({ error: '"line" must be a positive integer' });
      return;
    }

    const absPath = path.isAbsolute(rawFile) ? rawFile : path.join(graph.projectRoot, rawFile);

    const contextLines = readSourceContext(absPath, lineNum, radius);
    if (contextLines.length === 0) {
      res.status(404).json({ error: 'File not found or could not be read', path: absPath });
      return;
    }

    res.json({
      filePath: absPath,
      line: lineNum,
      contextLines,
      zedUrl: 'zed://file/' + absPath + ':' + String(lineNum),
    });
  });

  // 404 fallback
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── 6. Start HTTP server ──────────────────────────────────────────────
  return new Promise((resolve) => {
    const httpServer = http.createServer(app);

    httpServer.once('error', (cause: NodeJS.ErrnoException) => {
      const code = cause.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'UNKNOWN';
      resolve(
        err(
          makeServerError(
            code,
            code === 'PORT_IN_USE'
              ? `Port ${options.port} is already in use`
              : `Server failed to start: ${cause.message}`,
            cause,
          ),
        ),
      );
    });

    httpServer.listen(options.port, () => {
      const url = `http://localhost:${options.port}`;
      log?.info({ url }, 'ts-investigator server started');

      if (options.autoOpen) {
        void open(url);
      }

      const instance: ServerInstance = {
        port: options.port,
        url,
        close: (): Promise<void> =>
          new Promise((res, rej) => {
            httpServer.close((e) => (e !== undefined ? rej(e) : res()));
          }),
      };

      resolve(ok(instance));
    });
  });
}
