export interface CliRunItem {
  name: string
  method: string
  url: string
  status: number | null
  durationMs: number
  passed: boolean
  error?: string
}

export interface CliRunReport {
  collectionName: string
  totalRequests: number
  passedRequests: number
  failedRequests: number
  totalDurationMs: number
  items: CliRunItem[]
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function renderJunitXmlReport(report: CliRunReport): string {
  const cases = report.items
    .map((item) => {
      const timeSec = (item.durationMs / 1000).toFixed(3)
      const caseName = escapeXml(`${item.method} ${item.name}`)
      if (item.passed) {
        return `    <testcase classname="${escapeXml(report.collectionName)}" name="${caseName}" time="${timeSec}" />`
      }
      const errMsg = escapeXml(item.error || `Unexpected status ${item.status ?? 'ERROR'}`)
      return `    <testcase classname="${escapeXml(report.collectionName)}" name="${caseName}" time="${timeSec}">\n      <failure message="${errMsg}">${errMsg}</failure>\n    </testcase>`
    })
    .join('\n')

  const totalSec = (report.totalDurationMs / 1000).toFixed(3)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${report.totalRequests}" failures="${report.failedRequests}" time="${totalSec}">\n  <testsuite name="${escapeXml(report.collectionName)}" tests="${report.totalRequests}" failures="${report.failedRequests}" time="${totalSec}">\n${cases}\n  </testsuite>\n</testsuites>\n`
}

export function renderHtmlReport(report: CliRunReport): string {
  const rows = report.items
    .map(
      (item) =>
        `<tr><td><span class="badge ${item.passed ? 'pass' : 'fail'}">${item.passed ? 'PASS' : 'FAIL'}</span></td><td><code>${escapeXml(item.method)}</code></td><td>${escapeXml(item.name)}</td><td><code>${escapeXml(item.url)}</code></td><td>${item.status ?? 'ERR'}</td><td>${item.durationMs} ms</td></tr>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(report.collectionName)} — Meofast CI Report</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f8fbff; color: #0f172a; margin: 32px; }
    .card { background: #fff; border: 1px solid #dbe7f5; border-radius: 12px; padding: 24px; max-width: 1080px; margin: 0 auto; }
    .stats { display: flex; gap: 16px; margin: 16px 0 24px; }
    .stat { background: #f1f5f9; padding: 12px 16px; border-radius: 8px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #dbe7f5; }
    .badge { padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 11px; }
    .pass { background: #dcfce7; color: #15803d; }
    .fail { background: #fee2e2; color: #b91c1c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeXml(report.collectionName)}</h1>
    <div class="stats">
      <div class="stat">Total: <strong>${report.totalRequests}</strong></div>
      <div class="stat">Passed: <strong>${report.passedRequests}</strong></div>
      <div class="stat">Failed: <strong>${report.failedRequests}</strong></div>
      <div class="stat">Duration: <strong>${report.totalDurationMs} ms</strong></div>
    </div>
    <table>
      <thead><tr><th>Result</th><th>Method</th><th>Request</th><th>URL</th><th>Status</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`
}
