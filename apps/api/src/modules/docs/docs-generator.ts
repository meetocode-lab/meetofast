import type { HttpMethod, KeyValueItem, RequestBodyConfig } from '@meofast/shared'

export interface DocEndpointItem {
  id: string
  folderName: string | null
  name: string
  description: string
  protocol: string
  method: HttpMethod
  url: string
  headers: KeyValueItem[]
  queryParams: KeyValueItem[]
  pathVariables: KeyValueItem[]
  body: RequestBodyConfig
  jsonSchema: string
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function exportCollectionStaticHtml(col: {
  name: string
  description: string
  endpoints: DocEndpointItem[]
}): string {
  const endpointCards = col.endpoints
    .map((ep) => {
      const curlHeaders = ep.headers
        .filter((h) => h.enabled && h.key)
        .map((h) => ` \\\n  -H "${escapeHtml(h.key)}: ${escapeHtml(h.value)}"`)
        .join('')
      const curlBody =
        ep.body.mode !== 'none' && ep.body.raw
          ? ` \\\n  -d '${escapeHtml(ep.body.raw)}'`
          : ''
      const curlSnippet = `curl -X ${ep.method} "${escapeHtml(ep.url)}"${curlHeaders}${curlBody}`

      const paramsRows = [...ep.pathVariables, ...ep.queryParams]
        .filter((p) => p.enabled && p.key)
        .map(
          (p) =>
            `<tr><td><code>${escapeHtml(p.key)}</code></td><td><code>${escapeHtml(p.value)}</code></td><td>${escapeHtml(p.description || '—')}</td></tr>`,
        )
        .join('')

      return `
      <article class="endpoint-card" id="ep-${escapeHtml(ep.id)}">
        <div class="ep-head">
          <span class="method method-${ep.method.toLowerCase()}">${escapeHtml(ep.method)}</span>
          <code class="ep-url">${escapeHtml(ep.url)}</code>
        </div>
        <h3>${escapeHtml(ep.name)}</h3>
        ${ep.description ? `<p class="desc">${escapeHtml(ep.description)}</p>` : ''}
        ${
          paramsRows
            ? `<h4>Parameters</h4><table><thead><tr><th>Name</th><th>Example</th><th>Description</th></tr></thead><tbody>${paramsRows}</tbody></table>`
            : ''
        }
        ${
          ep.body.mode !== 'none' && ep.body.raw
            ? `<h4>Request Body (${escapeHtml(ep.body.mode.toUpperCase())})</h4><pre>${escapeHtml(ep.body.raw)}</pre>`
            : ''
        }
        <h4>cURL Example</h4>
        <pre>${curlSnippet}</pre>
      </article>`
    })
    .join('\n')

  const navItems = col.endpoints
    .map(
      (ep) =>
        `<a href="#ep-${escapeHtml(ep.id)}" class="nav-link"><span class="method-sm method-${ep.method.toLowerCase()}">${escapeHtml(ep.method)}</span><span>${escapeHtml(ep.name)}</span></a>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(col.name)} — API Documentation</title>
  <style>
    :root {
      --bg: #f8fbff; --surface: #ffffff; --border: #dbe7f5;
      --text: #0f172a; --muted: #475569; --primary: #2563eb;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); display: flex; min-height: 100vh; }
    aside { width: 280px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; flex-shrink: 0; }
    aside h2 { margin: 0 0 16px; font-size: 16px; }
    .nav-link { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; text-decoration: none; color: var(--text); font-size: 13px; margin-bottom: 4px; }
    .nav-link:hover { background: #eff6ff; color: var(--primary); }
    main { flex: 1; padding: 32px 40px; max-width: 1080px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    .lead { color: var(--muted); margin: 0 0 28px; font-size: 14px; }
    .endpoint-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 20px; }
    .ep-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .ep-url { font-size: 13px; background: #f1f5f9; padding: 4px 10px; border-radius: 6px; }
    .method, .method-sm { font-family: monospace; font-weight: 700; border-radius: 6px; padding: 3px 8px; font-size: 11px; }
    .method-get { background: #dcfce7; color: #15803d; }
    .method-post { background: #dbeafe; color: #1d4ed8; }
    .method-put, .method-patch { background: #fef3c7; color: #b45309; }
    .method-delete { background: #fee2e2; color: #b91c1c; }
    h3 { margin: 6px 0; font-size: 17px; }
    h4 { margin: 16px 0 8px; font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.04em; }
    .desc { color: var(--muted); font-size: 13px; margin: 4px 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <aside>
    <h2>${escapeHtml(col.name)}</h2>
    ${navItems}
  </aside>
  <main>
    <h1>${escapeHtml(col.name)}</h1>
    <p class="lead">${escapeHtml(col.description || 'API reference generated by Meofast.')}</p>
    ${endpointCards}
  </main>
</body>
</html>`
}
