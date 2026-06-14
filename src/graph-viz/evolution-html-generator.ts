import type { ExecuteSession } from '../core/types.js';

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
  <style>
    body {
      background: #0d1117;
      color: #e6edf3;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .empty-state {
      text-align: center;
      color: #8b949e;
    }
    .empty-state h2 {
      font-size: 20px;
      margin-bottom: 8px;
      color: #e6edf3;
    }
  </style>
</head>
<body>
  <div class="empty-state">
    <h2>No evolution data</h2>
    <p>Session <code>${session.sessionId}</code> has not entered the evolution loop yet.</p>
  </div>
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
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
      min-height: 100vh;
      padding: 32px;
    }

    h1 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .subtitle {
      font-size: 13px;
      color: #8b949e;
      margin-bottom: 32px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
    }

    .layout {
      display: grid;
      grid-template-columns: 1fr 300px;
      gap: 24px;
      align-items: start;
    }

    .chart-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 24px;
    }

    .chart-card h2 {
      font-size: 14px;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 16px;
    }

    .chart-container {
      position: relative;
      height: 320px;
    }

    .summary-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 24px;
    }

    .summary-card h2 {
      font-size: 14px;
      font-weight: 600;
      color: #8b949e;
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
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 15px;
      color: #e6edf3;
      font-weight: 600;
    }

    .stat-value.score {
      font-size: 24px;
      color: #3b82f6;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
      margin-right: 4px;
    }

    .badge-persona {
      background: #1f4068;
      color: #58a6ff;
      border: 1px solid #388bfd40;
    }

    .badge-termination {
      background: #3d2000;
      color: #f0883e;
      border: 1px solid #f0883e40;
    }

    .badge-success {
      background: #1a3a1a;
      color: #3fb950;
      border: 1px solid #3fb95040;
    }

    .legend {
      display: flex;
      gap: 20px;
      margin-top: 12px;
      font-size: 12px;
      color: #8b949e;
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

    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <h1>Evolution Visualization</h1>
  <div class="subtitle">Session: ${session.sessionId}</div>

  <div class="layout">
    <div class="chart-card">
      <h2>Score per Generation</h2>
      <div class="chart-container">
        <canvas id="evolutionChart"></canvas>
      </div>
      <div class="legend">
        <div class="legend-item">
          <div class="legend-dot" style="background:#3b82f6;"></div>
          Evaluation Score
        </div>
        <div class="legend-item">
          <div class="legend-dot" style="background:#22c55e;"></div>
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
              : '<span style="color:#484f58;font-size:13px;">none</span>'
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
              : '<span style="color:#484f58;font-size:13px;">in progress</span>'
          }
        </div>
      </div>
    </div>
  </div>

  <script>
  (function () {
    'use strict';

    const labels = ${labelsJson};
    const evalScores = ${evalScoresJson};
    const goalAlignments = ${goalAlignJson};

    const ctx = document.getElementById('evolutionChart').getContext('2d');

    new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Evaluation Score',
            data: evalScores,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.08)',
            borderWidth: 2,
            pointBackgroundColor: '#3b82f6',
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Goal Alignment',
            data: goalAlignments,
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34, 197, 94, 0.08)',
            borderWidth: 2,
            pointBackgroundColor: '#22c55e',
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
              color: '#8b949e',
              font: { size: 11 },
            },
            grid: {
              color: '#21262d',
            },
          },
          y: {
            min: 0,
            max: 1,
            ticks: {
              color: '#8b949e',
              font: { size: 11 },
              stepSize: 0.2,
            },
            grid: {
              color: '#21262d',
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: '#161b22',
            borderColor: '#30363d',
            borderWidth: 1,
            titleColor: '#e6edf3',
            bodyColor: '#8b949e',
          },
        },
      },
    });
  })();
  </script>
</body>
</html>`;
}
