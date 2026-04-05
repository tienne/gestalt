import type { CodeGraphNode, CodeGraphEdge } from '../code-graph/types.js';
import { NodeKind, EdgeKind } from '../code-graph/types.js';

/**
 * Generates a self-contained interactive HTML visualization for a code knowledge graph.
 * Uses D3.js v7 force-directed layout with dark theme UI.
 */
export function generateVisualizationHtml(nodes: CodeGraphNode[], edges: CodeGraphEdge[]): string {
  const nodesJson = JSON.stringify(nodes);
  const edgesJson = JSON.stringify(edges);

  // NodeKind / EdgeKind enum values serialized for use in inline JS
  const nodeKindFile = NodeKind.File;
  const nodeKindFunction = NodeKind.Function;
  const nodeKindClass = NodeKind.Class;
  const edgeKindImport = EdgeKind.IMPORTS_FROM;
  const edgeKindCall = EdgeKind.CALLS;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Code Knowledge Graph</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: #0d1117;
      color: #e6edf3;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    #graph-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    /* ─── Sidebar ─────────────────────────────────────────────── */
    #sidebar {
      width: 280px;
      background: #161b22;
      border-left: 1px solid #30363d;
      display: flex;
      flex-direction: column;
      transition: transform 0.2s ease;
    }

    #sidebar-header {
      padding: 16px 20px;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #sidebar-header h2 {
      font-size: 13px;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    #sidebar-content {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
    }

    #node-placeholder {
      color: #484f58;
      font-size: 13px;
      text-align: center;
      margin-top: 40px;
      line-height: 1.6;
    }

    #node-details {
      display: none;
    }

    .detail-label {
      font-size: 10px;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 4px;
    }

    .detail-value {
      font-size: 13px;
      color: #e6edf3;
      word-break: break-all;
      margin-bottom: 16px;
      padding: 8px 10px;
      background: #0d1117;
      border-radius: 6px;
      border: 1px solid #30363d;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
    }

    .detail-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 16px;
    }

    .badge-file     { background: #1f4068; color: #58a6ff; border: 1px solid #388bfd40; }
    .badge-function { background: #1a3a1a; color: #3fb950; border: 1px solid #3fb95040; }
    .badge-class    { background: #3d2000; color: #f0883e; border: 1px solid #f0883e40; }
    .badge-type     { background: #2e1f5e; color: #bc8cff; border: 1px solid #bc8cff40; }

    #connections-section h3 {
      font-size: 11px;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
    }

    .connection-item {
      font-size: 12px;
      color: #c9d1d9;
      padding: 5px 8px;
      border-radius: 4px;
      margin-bottom: 3px;
      background: #21262d;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      border: 1px solid transparent;
      transition: border-color 0.15s;
    }

    .connection-item:hover {
      border-color: #388bfd;
    }

    .connection-item .conn-kind {
      font-size: 10px;
      color: #8b949e;
      margin-right: 4px;
    }

    /* ─── Stats Bar ───────────────────────────────────────────── */
    #stats-bar {
      position: absolute;
      top: 12px;
      left: 12px;
      display: flex;
      gap: 8px;
      pointer-events: none;
    }

    .stat-chip {
      background: #161b22cc;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 11px;
      color: #8b949e;
      backdrop-filter: blur(4px);
    }

    .stat-chip span {
      color: #e6edf3;
      font-weight: 600;
    }

    /* ─── Legend ─────────────────────────────────────────────── */
    #legend {
      position: absolute;
      bottom: 16px;
      left: 12px;
      background: #161b22cc;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 10px 14px;
      pointer-events: none;
      backdrop-filter: blur(4px);
    }

    .legend-title {
      font-size: 10px;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 5px;
      font-size: 11px;
      color: #8b949e;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .legend-line {
      width: 22px;
      height: 2px;
      flex-shrink: 0;
      border-radius: 1px;
    }

    .legend-dashed {
      background: repeating-linear-gradient(
        90deg,
        #6e7681 0, #6e7681 4px,
        transparent 4px, transparent 8px
      );
    }

    /* ─── D3 Graph Styles ────────────────────────────────────── */
    .node circle {
      cursor: pointer;
      transition: filter 0.15s;
    }

    .node circle:hover {
      filter: brightness(1.3);
    }

    .node text {
      pointer-events: none;
      user-select: none;
      font-size: 10px;
      fill: #8b949e;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
    }

    .link {
      pointer-events: none;
    }

    .link.dimmed {
      opacity: 0.08;
    }

    .node.dimmed circle {
      opacity: 0.12;
    }

    .node.dimmed text {
      opacity: 0.08;
    }

    .node.highlighted circle {
      filter: brightness(1.4) drop-shadow(0 0 6px currentColor);
    }

    .node.highlighted text {
      fill: #e6edf3;
    }

    /* ─── Controls ───────────────────────────────────────────── */
    #controls {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .ctrl-btn {
      width: 32px;
      height: 32px;
      background: #161b22cc;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #8b949e;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s;
      backdrop-filter: blur(4px);
    }

    .ctrl-btn:hover {
      background: #21262d;
      color: #e6edf3;
    }
  </style>
</head>
<body>

<div id="graph-container">
  <svg id="svg"></svg>

  <div id="stats-bar">
    <div class="stat-chip">Nodes: <span id="stat-nodes">0</span></div>
    <div class="stat-chip">Edges: <span id="stat-edges">0</span></div>
  </div>

  <div id="controls">
    <button class="ctrl-btn" id="btn-zoom-in"  title="Zoom in">+</button>
    <button class="ctrl-btn" id="btn-zoom-out" title="Zoom out">−</button>
    <button class="ctrl-btn" id="btn-reset"    title="Reset view">⌖</button>
  </div>

  <div id="legend">
    <div class="legend-title">Legend</div>
    <div class="legend-item"><div class="legend-dot" style="background:#388bfd;width:14px;height:14px;"></div> File</div>
    <div class="legend-item"><div class="legend-dot" style="background:#3fb950;"></div> Function</div>
    <div class="legend-item"><div class="legend-dot" style="background:#f0883e;"></div> Class / Type</div>
    <div class="legend-item"><div class="legend-line legend-dashed"></div> Import</div>
    <div class="legend-item"><div class="legend-line" style="background:#6e7681;"></div> Call / Other</div>
  </div>
</div>

<div id="sidebar">
  <div id="sidebar-header">
    <h2>Node Details</h2>
  </div>
  <div id="sidebar-content">
    <div id="node-placeholder">Click a node to<br/>inspect its details</div>
    <div id="node-details"></div>
  </div>
</div>

<script>
(function () {
  'use strict';

  // ─── Embedded Data ─────────────────────────────────────────────
  const RAW_NODES = ${nodesJson};
  const RAW_EDGES = ${edgesJson};

  const NODE_KIND_FILE     = ${JSON.stringify(nodeKindFile)};
  const NODE_KIND_FUNCTION = ${JSON.stringify(nodeKindFunction)};
  const NODE_KIND_CLASS    = ${JSON.stringify(nodeKindClass)};
  const EDGE_KIND_IMPORT   = ${JSON.stringify(edgeKindImport)};
  const EDGE_KIND_CALL     = ${JSON.stringify(edgeKindCall)};

  // ─── Stats ─────────────────────────────────────────────────────
  document.getElementById('stat-nodes').textContent = RAW_NODES.length;
  document.getElementById('stat-edges').textContent = RAW_EDGES.length;

  // ─── Helpers ───────────────────────────────────────────────────
  function nodeColor(kind) {
    if (kind === NODE_KIND_FILE)     return '#388bfd';
    if (kind === NODE_KIND_FUNCTION) return '#3fb950';
    if (kind === NODE_KIND_CLASS)    return '#f0883e';
    return '#bc8cff'; // Type, etc.
  }

  function nodeRadius(kind) {
    return kind === NODE_KIND_FILE ? 9 : 5;
  }

  function shortName(n) {
    if (n.kind === NODE_KIND_FILE) {
      const parts = n.filePath.split('/');
      return parts[parts.length - 1] || n.name;
    }
    return n.name.length > 22 ? n.name.slice(0, 20) + '…' : n.name;
  }

  function badgeClass(kind) {
    if (kind === NODE_KIND_FILE)     return 'badge-file';
    if (kind === NODE_KIND_FUNCTION) return 'badge-function';
    if (kind === NODE_KIND_CLASS)    return 'badge-class';
    return 'badge-type';
  }

  // ─── D3 Setup ──────────────────────────────────────────────────
  const width  = document.getElementById('graph-container').clientWidth;
  const height = document.getElementById('graph-container').clientHeight;

  const svg = d3.select('#svg')
    .attr('width',  width)
    .attr('height', height);

  const defs = svg.append('defs');

  // Arrow marker for directed edges (call edges)
  defs.append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 12)
    .attr('refY', 0)
    .attr('markerWidth', 5)
    .attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', '#4d5566');

  const zoomLayer = svg.append('g').attr('class', 'zoom-layer');

  const zoom = d3.zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => zoomLayer.attr('transform', event.transform));

  svg.call(zoom);

  // ─── Build graph data ──────────────────────────────────────────
  const nodeMap = new Map(RAW_NODES.map(n => [n.id, n]));

  // Filter edges to only those whose source and target exist
  const validEdges = RAW_EDGES.filter(e =>
    nodeMap.has(e.sourceId) && nodeMap.has(e.targetId)
  );

  const simNodes = RAW_NODES.map(n => ({ ...n }));
  const simEdges = validEdges.map(e => ({
    ...e,
    source: e.sourceId,
    target: e.targetId,
  }));

  // ─── Force Simulation ──────────────────────────────────────────
  const simulation = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink(simEdges)
      .id(d => d.id)
      .distance(d => {
        if (d.kind === EDGE_KIND_IMPORT) return 90;
        return 60;
      })
      .strength(0.4)
    )
    .force('charge', d3.forceManyBody()
      .strength(d => d.kind === NODE_KIND_FILE ? -280 : -120)
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d.kind) + 6))
    .alphaDecay(0.02);

  // ─── Render Links ─────────────────────────────────────────────
  const linkGroup = zoomLayer.append('g').attr('class', 'links');
  const link = linkGroup.selectAll('line')
    .data(simEdges)
    .join('line')
    .attr('class', 'link')
    .attr('stroke', d => d.kind === EDGE_KIND_CALL ? '#4d5566' : '#3a3f4b')
    .attr('stroke-width', d => d.kind === EDGE_KIND_CALL ? 1.2 : 0.8)
    .attr('stroke-dasharray', d => d.kind === EDGE_KIND_IMPORT ? '4 3' : null)
    .attr('stroke-opacity', d => d.kind === EDGE_KIND_CALL ? 0.7 : 0.45)
    .attr('marker-end', d => d.kind === EDGE_KIND_CALL ? 'url(#arrow)' : null);

  // ─── Render Nodes ─────────────────────────────────────────────
  const nodeGroup = zoomLayer.append('g').attr('class', 'nodes');
  const node = nodeGroup.selectAll('g')
    .data(simNodes)
    .join('g')
    .attr('class', 'node')
    .call(
      d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    )
    .on('click', onNodeClick);

  node.append('circle')
    .attr('r', d => nodeRadius(d.kind))
    .attr('fill', d => nodeColor(d.kind))
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 1.5);

  node.append('text')
    .attr('dy', d => nodeRadius(d.kind) + 11)
    .attr('text-anchor', 'middle')
    .text(d => shortName(d));

  // ─── Tick ─────────────────────────────────────────────────────
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
  });

  // ─── Click Interaction ────────────────────────────────────────
  let selectedId = null;

  function onNodeClick(event, d) {
    event.stopPropagation();

    if (selectedId === d.id) {
      // Deselect
      selectedId = null;
      resetHighlight();
      showPlaceholder();
      return;
    }

    selectedId = d.id;
    highlightNode(d);
    showDetails(d);
  }

  svg.on('click', () => {
    selectedId = null;
    resetHighlight();
    showPlaceholder();
  });

  function highlightNode(d) {
    // Find directly connected node IDs
    const connectedIds = new Set([d.id]);
    simEdges.forEach(e => {
      if (e.source.id === d.id || e.sourceId === d.id) connectedIds.add(e.target.id || e.targetId);
      if (e.target.id === d.id || e.targetId === d.id) connectedIds.add(e.source.id || e.sourceId);
    });

    node
      .classed('dimmed',      n => !connectedIds.has(n.id))
      .classed('highlighted', n => connectedIds.has(n.id));

    link
      .classed('dimmed', e => {
        const sid = e.source.id || e.sourceId;
        const tid = e.target.id || e.targetId;
        return !(connectedIds.has(sid) && connectedIds.has(tid));
      });
  }

  function resetHighlight() {
    node.classed('dimmed', false).classed('highlighted', false);
    link.classed('dimmed', false);
  }

  // ─── Sidebar: Details ─────────────────────────────────────────
  function showPlaceholder() {
    document.getElementById('node-placeholder').style.display = '';
    document.getElementById('node-details').style.display = 'none';
  }

  function showDetails(d) {
    document.getElementById('node-placeholder').style.display = 'none';

    // Gather connections
    const outgoing = [];
    const incoming = [];
    simEdges.forEach(e => {
      const sid = e.source.id || e.sourceId;
      const tid = e.target.id || e.targetId;
      if (sid === d.id) {
        const target = nodeMap.get(tid);
        if (target) outgoing.push({ node: target, kind: e.kind });
      }
      if (tid === d.id) {
        const source = nodeMap.get(sid);
        if (source) incoming.push({ node: source, kind: e.kind });
      }
    });

    const detailsEl = document.getElementById('node-details');
    detailsEl.style.display = 'block';
    detailsEl.innerHTML = \`
      <div class="detail-label">Kind</div>
      <div class="detail-badge \${badgeClass(d.kind)}">\${d.kind}</div>

      <div class="detail-label">Name</div>
      <div class="detail-value">\${escHtml(d.name)}</div>

      <div class="detail-label">File</div>
      <div class="detail-value">\${escHtml(d.filePath)}</div>

      \${d.lineStart != null ? \`
        <div class="detail-label">Lines</div>
        <div class="detail-value">\${d.lineStart}\${d.lineEnd != null ? '–' + d.lineEnd : ''}</div>
      \` : ''}

      \${outgoing.length > 0 ? \`
        <div id="connections-section">
          <h3>Outgoing (\${outgoing.length})</h3>
          \${outgoing.slice(0, 12).map(c => \`
            <div class="connection-item" data-id="\${escAttr(c.node.id)}" title="\${escAttr(c.node.name)}">
              <span class="conn-kind">\${c.kind}</span>\${escHtml(shortName(c.node))}
            </div>
          \`).join('')}
        </div>
      \` : ''}

      \${incoming.length > 0 ? \`
        <div id="connections-section" style="margin-top:12px;">
          <h3>Incoming (\${incoming.length})</h3>
          \${incoming.slice(0, 12).map(c => \`
            <div class="connection-item" data-id="\${escAttr(c.node.id)}" title="\${escAttr(c.node.name)}">
              <span class="conn-kind">\${c.kind}</span>\${escHtml(shortName(c.node))}
            </div>
          \`).join('')}
        </div>
      \` : ''}
    \`;

    // Click on connection item → jump to that node
    detailsEl.querySelectorAll('.connection-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        const target = simNodes.find(n => n.id === id);
        if (target) {
          selectedId = target.id;
          highlightNode(target);
          showDetails(target);
          panToNode(target);
        }
      });
    });
  }

  function panToNode(d) {
    const t = d3.zoomTransform(svg.node());
    const cx = width / 2 - t.k * d.x;
    const cy = height / 2 - t.k * d.y;
    svg.transition().duration(400).call(
      zoom.transform,
      d3.zoomIdentity.translate(cx, cy).scale(t.k)
    );
  }

  // ─── Controls ────────────────────────────────────────────────
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    svg.transition().duration(200).call(zoom.scaleBy, 1.4);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.4);
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    svg.transition().duration(400).call(
      zoom.transform,
      d3.zoomIdentity.translate(width / 2, height / 2).scale(1)
        .translate(-width / 2, -height / 2)
    );
  });

  // ─── Escape helpers ──────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return String(str).replace(/"/g, '&quot;');
  }

  // ─── Window resize ───────────────────────────────────────────
  window.addEventListener('resize', () => {
    const w = document.getElementById('graph-container').clientWidth;
    const h = document.getElementById('graph-container').clientHeight;
    svg.attr('width', w).attr('height', h);
    simulation.force('center', d3.forceCenter(w / 2, h / 2)).alpha(0.1).restart();
  });

})();
</script>
</body>
</html>`;
}
