import type { ExecuteSession } from '../core/types.js';
import { GRAPH_THEME_HEAD, GRAPH_THEME_JS, graphThemePicker } from './theme.js';

/**
 * Generates a self-contained HTML page visualizing the evolution history of an execute session.
 * Uses Chart.js CDN for line charts showing evaluationScore and goalAlignment per generation.
 */
export function generateEvolutionHtml(session: ExecuteSession): string {
  const history = session.evolutionHistory;

  if (history.length === 0) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gestalt Evolution Visualization</title>
  ${GRAPH_THEME_HEAD}
  <style>
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .empty-state {
      text-align: center;
      color: var(--muted);
    }
    .empty-state h2 {
      font-size: 20px;
      margin-bottom: 8px;
      color: var(--fg);
    }
    .corner {
      position: fixed;
      top: 16px;
      right: 16px;
    }
  </style>
</head>
<body>
  <div class="corner">${graphThemePicker()}</div>
  <div class="empty-state">
    <h2>No evolution data</h2>
    <p>Session <code>${session.sessionId}</code> has not entered the evolution loop yet.</p>
  </div>
  <script>${GRAPH_THEME_JS}</script>
</body>
</html>`;
  }

  const labels = history.map((g) => `Gen ${g.generation}`);
  const evaluationScores = history.map((g) => g.evaluationScore);
  const goalAlignments = history.map((g) => g.goalAlignment);

  const labelsJson = JSON.stringify(labels);
  const evalScoresJson = JSON.stringify(evaluationScores);
  const goalAlignJson = JSON.stringify(goalAlignments);

  const lastGen = history[history.length - 1]!;
  const finalScore = lastGen.evaluationScore;
  const triedPersonas = session.lateralTriedPersonas;
  const terminationReason = session.terminationReason ?? null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gestalt Evolution Visualization — ${session.sessionId}</title>
  ${GRAPH_THEME_HEAD}
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 32px;
    }

    .page-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }

    h1 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .subtitle {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 32px;
      word-break: break-all;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
    }

    .layout {
      display: grid;
      grid-template-columns: 1fr 300px;
      gap: 24px;
      align-items: start;
    }

    .chart-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 24px;
    }

    .chart-card h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 16px;
    }

    .chart-container {
      position: relative;
      height: 320px;
    }

    .summary-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 24px;
    }

    .summary-card h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 20px;
    }

    .stat-row {
      margin-bottom: 16px;
    }

    .stat-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 15px;
      color: var(--fg);
      font-weight: 600;
    }

    .stat-value.score {
      font-size: 24px;
      color: var(--accent);
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
      margin-right: 4px;
      background: var(--card);
      box-shadow: inset 0 0 0 1px currentColor;
    }

    .badge-persona     { color: var(--gestalt-color-info-text); }
    .badge-termination { color: var(--gestalt-color-warning-text); }
    .badge-success     { color: var(--gestalt-color-success-text); }

    .stat-none {
      color: var(--muted);
      font-size: 13px;
    }

    .legend {
      display: flex;
      gap: 20px;
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .legend-dot {
      width: 12px;
      height: 3px;
      border-radius: 2px;
    }

    .s-eval { background: var(--gestalt-color-series-2); }
    .s-goal { background: var(--gestalt-color-series-3); }

    @media (max-width: 768px) {
      body {
        padding: 20px 16px;
      }

      .layout {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header class="page-head">
    <div>
      <h1>Evolution Visualization</h1>
      <div class="subtitle">Session: ${session.sessionId}</div>
    </div>
    ${graphThemePicker()}
  </header>

  <div class="layout">
    <div class="chart-card">
      <h2>Score per Generation</h2>
      <div class="chart-container">
        <canvas id="evolutionChart"></canvas>
      </div>
      <div class="legend">
        <div class="legend-item">
          <div class="legend-dot s-eval"></div>
          Evaluation Score
        </div>
        <div class="legend-item">
          <div class="legend-dot s-goal"></div>
          Goal Alignment
        </div>
      </div>
    </div>

    <div class="summary-card">
      <h2>Summary</h2>

      <div class="stat-row">
        <div class="stat-label">Total Generations</div>
        <div class="stat-value">${history.length}</div>
      </div>

      <div class="stat-row">
        <div class="stat-label">Current Generation</div>
        <div class="stat-value">${session.currentGeneration}</div>
      </div>

      <div class="stat-row">
        <div class="stat-label">Final Eval Score</div>
        <div class="stat-value score">${finalScore.toFixed(3)}</div>
      </div>

      <div class="stat-row">
        <div class="stat-label">Tried Personas</div>
        <div class="stat-value">
          ${
            triedPersonas.length > 0
              ? triedPersonas.map((p) => `<span class="badge badge-persona">${p}</span>`).join('')
              : '<span class="stat-none">none</span>'
          }
        </div>
      </div>

      <div class="stat-row">
        <div class="stat-label">Termination Reason</div>
        <div class="stat-value">
          ${
            terminationReason
              ? terminationReason === 'success'
                ? `<span class="badge badge-success">${terminationReason}</span>`
                : `<span class="badge badge-termination">${terminationReason}</span>`
              : '<span class="stat-none">in progress</span>'
          }
        </div>
      </div>
    </div>
  </div>

  <script>${GRAPH_THEME_JS}</script>
  <script>
  (function () {
    'use strict';

    const labels = ${labelsJson};
    const evalScores = ${evalScoresJson};
    const goalAlignments = ${goalAlignJson};

    const ctx = document.getElementById('evolutionChart').getContext('2d');
    const role = window.gestaltRole;

    // 캔버스는 CSS 변수를 못 읽어서 테마가 바뀔 때마다 역할 값을 다시 꺼내 칠한다
    function palette() {
      return {
        eval: role('series-2'),
        evalFill: role('series-2', 0.08),
        goal: role('series-3'),
        goalFill: role('series-3', 0.08),
        muted: role('text-muted'),
        text: role('text'),
        line: role('border'),
        surface: role('surface'),
      };
    }

    // 차트를 만들기 전 설정과 만든 뒤의 chart가 data, options 모양이 같아서 둘 다 받는다
    function paint(chart) {
      const c = palette();
      const [ev, goal] = chart.data.datasets;
      ev.borderColor = c.eval;
      ev.backgroundColor = c.evalFill;
      ev.pointBackgroundColor = c.eval;
      goal.borderColor = c.goal;
      goal.backgroundColor = c.goalFill;
      goal.pointBackgroundColor = c.goal;
      for (const axis of ['x', 'y']) {
        chart.options.scales[axis].ticks.color = c.muted;
        chart.options.scales[axis].grid.color = c.line;
      }
      const tip = chart.options.plugins.tooltip;
      tip.backgroundColor = c.surface;
      tip.borderColor = c.line;
      tip.titleColor = c.text;
      tip.bodyColor = c.muted;
    }

    const config = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Evaluation Score',
            data: evalScores,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Goal Alignment',
            data: goalAlignments,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: true,
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            ticks: {
              font: { size: 11 },
            },
            grid: {},
          },
          y: {
            min: 0,
            max: 1,
            ticks: {
              font: { size: 11 },
              stepSize: 0.2,
            },
            grid: {},
          },
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            borderWidth: 1,
          },
        },
      },
    };
    paint(config);
    // 모션 줄이기에서는 선이 자라는 진입 애니메이션 없이 최종 값을 바로 그린다
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      config.options.animation = false;
    const chart = new Chart(ctx, config);

    document.addEventListener('gestalt-theme', function () {
      paint(chart);
      chart.update('none');
    });
  })();
  </script>
</body>
</html>`;
}
