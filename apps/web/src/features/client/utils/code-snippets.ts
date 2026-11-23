import { reconcileUrlAndQueryParams } from '@meofast/shared'
import type { RequestTab } from '../store/useWorkbenchStore'

export type SnippetLanguage = 'curl' | 'fetch' | 'node' | 'python' | 'go' | 'php' | 'rust'

export const SNIPPET_LANGUAGES: Array<{ value: SnippetLanguage; label: string }> = [
  { value: 'curl', label: 'cURL' },
  { value: 'fetch', label: 'JavaScript (fetch)' },
  { value: 'node', label: 'Node.js / TypeScript' },
  { value: 'python', label: 'Python (requests)' },
  { value: 'go', label: 'Go (net/http)' },
  { value: 'php', label: 'PHP (cURL)' },
  { value: 'rust', label: 'Rust (reqwest)' },
]

function buildActiveHeaders(tab: RequestTab): Array<{ key: string; value: string }> {
  const hdrs = tab.headers
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => ({ key: h.key.trim(), value: h.value }))

  if (tab.auth.type === 'bearer' && tab.auth.token) {
    hdrs.push({
      key: 'Authorization',
      value: `${tab.auth.prefix || 'Bearer'} ${tab.auth.token}`.trim(),
    })
  } else if (tab.auth.type === 'apikey' && tab.auth.in === 'header' && tab.auth.key) {
    hdrs.push({ key: tab.auth.key, value: tab.auth.value })
  } else if (tab.auth.type === 'oauth2' && tab.auth.accessToken) {
    hdrs.push({
      key: 'Authorization',
      value: `${tab.auth.headerPrefix || 'Bearer'} ${tab.auth.accessToken}`.trim(),
    })
  } else if (tab.auth.type === 'custom' && tab.auth.headerName) {
    hdrs.push({ key: tab.auth.headerName, value: tab.auth.headerValue })
  }

  const hasContentType = hdrs.some((h) => h.key.toLowerCase() === 'content-type')
  if (!hasContentType) {
    if (tab.protocol === 'graphql' || tab.body.mode === 'json') {
      hdrs.push({ key: 'Content-Type', value: 'application/json' })
    } else if (tab.body.mode === 'xml' || tab.protocol === 'soap') {
      hdrs.push({ key: 'Content-Type', value: 'application/xml' })
    } else if (tab.body.mode === 'urlencoded') {
      hdrs.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })
    }
  }
  return hdrs
}

function buildUrlWithQuery(tab: RequestTab): string {
  return reconcileUrlAndQueryParams(tab.url, tab.queryParams).url
}

function buildBodyString(tab: RequestTab): string {
  if (tab.protocol === 'graphql') {
    let vars: unknown = {}
    try {
      vars = JSON.parse(tab.graphql.variables || '{}')
    } catch {
      vars = {}
    }
    return JSON.stringify(
      {
        query: tab.graphql.query,
        variables: vars,
      },
      null,
      2,
    )
  }
  if (tab.method === 'GET' || tab.method === 'HEAD') return ''
  if (tab.body.mode === 'json' || tab.body.mode === 'xml' || tab.body.mode === 'text') {
    return tab.body.raw ?? ''
  }
  if (tab.body.mode === 'urlencoded') {
    return (tab.body.urlencoded ?? [])
      .filter((i) => i.enabled && i.key)
      .map((i) => `${encodeURIComponent(i.key)}=${encodeURIComponent(i.value)}`)
      .join('&')
  }
  return ''
}

export function generateClientSnippet(tab: RequestTab, lang: SnippetLanguage): string {
  const method = tab.protocol === 'graphql' ? 'POST' : tab.method
  const url = buildUrlWithQuery(tab)
  const headers = buildActiveHeaders(tab)
  const body = buildBodyString(tab)

  switch (lang) {
    case 'curl': {
      const parts = [`curl -X ${method} "${url}"`]
      for (const h of headers) {
        parts.push(`  -H "${h.key}: ${h.value.replace(/"/g, '\\"')}"`)
      }
      if (body) {
        parts.push(`  -d '${body.replace(/'/g, "'\\''")}'`)
      }
      return parts.join(' \\\n')
    }

    case 'fetch': {
      const hdrLines = headers
        .map((h) => `    ${JSON.stringify(h.key)}: ${JSON.stringify(h.value)},`)
        .join('\n')
      const bodyPart = body ? `\n  body: ${JSON.stringify(body)},` : ''
      return `const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)},\n  headers: {\n${hdrLines}\n  },${bodyPart}\n});\n\nconst data = await response.json();\nconsole.log(response.status, data);`
    }

    case 'node': {
      const hdrLines = headers
        .map((h) => `      ${JSON.stringify(h.key)}: ${JSON.stringify(h.value)},`)
        .join('\n')
      const bodyPart = body ? `\n    body: ${JSON.stringify(body)},` : ''
      return `async function runRequest(): Promise<void> {\n  const res = await fetch(${JSON.stringify(url)}, {\n    method: ${JSON.stringify(method)},\n    headers: {\n${hdrLines}\n    },${bodyPart}\n  });\n\n  const text = await res.text();\n  console.log({ status: res.status, body: text });\n}\n\nvoid runRequest();`
    }

    case 'python': {
      const hdrLines = headers
        .map((h) => `    ${JSON.stringify(h.key)}: ${JSON.stringify(h.value)},`)
        .join('\n')
      const dataLine = body ? `\npayload = ${JSON.stringify(body)}\n` : '\n'
      const dataArg = body ? ', data=payload' : ''
      return `import requests\n\nurl = ${JSON.stringify(url)}\nheaders = {\n${hdrLines}\n}${dataLine}\nresponse = requests.request(${JSON.stringify(method)}, url, headers=headers${dataArg}, timeout=30)\nprint(response.status_code)\nprint(response.text)`
    }

    case 'go': {
      const bodyInit = body
        ? `\tbody := strings.NewReader(${JSON.stringify(body)})\n\treq, err := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, body)`
        : `\treq, err := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, nil)`
      const imports = body
        ? `"fmt"\n\t"io"\n\t"net/http"\n\t"strings"`
        : `"fmt"\n\t"io"\n\t"net/http"`
      const hdrSet = headers
        .map((h) => `\treq.Header.Set(${JSON.stringify(h.key)}, ${JSON.stringify(h.value)})`)
        .join('\n')
      return `package main\n\nimport (\n\t${imports}\n)\n\nfunc main() {\n${bodyInit}\n\tif err != nil {\n\t\tpanic(err)\n\t}\n${hdrSet ? `${hdrSet}\n` : ''}\n\tres, err := http.DefaultClient.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer res.Body.Close()\n\n\traw, _ := io.ReadAll(res.Body)\n\tfmt.Println(res.StatusCode, string(raw))\n}`
    }

    case 'php': {
      const hdrArr = headers
        .map((h) => `    ${JSON.stringify(`${h.key}: ${h.value}`)},`)
        .join('\n')
      const postFields = body
        ? `\n  CURLOPT_POSTFIELDS => ${JSON.stringify(body)},`
        : ''
      return `<?php\n$ch = curl_init(${JSON.stringify(url)});\ncurl_setopt_array($ch, [\n  CURLOPT_CUSTOMREQUEST => ${JSON.stringify(method)},\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n${hdrArr}\n  ],${postFields}\n]);\n\n$response = curl_exec($ch);\n$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\n\necho $status . "\\n" . $response;`
    }

    case 'rust': {
      const hdrChain = headers
        .map((h) => `        .header(${JSON.stringify(h.key)}, ${JSON.stringify(h.value)})`)
        .join('\n')
      const bodyChain = body ? `\n        .body(${JSON.stringify(body)})` : ''
      return `#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n    let client = reqwest::Client::new();\n    let res = client\n        .request(reqwest::Method::from_bytes(b${JSON.stringify(method)})?, ${JSON.stringify(url)})\n${hdrChain}${bodyChain}\n        .send()\n        .await?;\n\n    println!("Status: {}", res.status());\n    println!("{}", res.text().await?);\n    Ok(())\n}`
    }
  }
}
