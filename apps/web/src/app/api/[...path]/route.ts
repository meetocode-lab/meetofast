import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

async function forwardToHono(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params
  const baseUrl = (process.env.INTERNAL_API_URL || 'http://127.0.0.1:4781').replace(/\/$/, '')
  const targetUrl = `${baseUrl}/api/${path.join('/')}${req.nextUrl.search}`

  const headers = new Headers()
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const bodyBuffer = hasBody ? await req.arrayBuffer() : undefined

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody && bodyBuffer ? bodyBuffer : undefined,
      redirect: 'manual',
    })

    const resHeaders = new Headers()
    upstream.headers.forEach((val, key) => {
      if (key.toLowerCase() !== 'set-cookie' && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        resHeaders.set(key, val)
      }
    })

    if (typeof upstream.headers.getSetCookie === 'function') {
      for (const cookie of upstream.headers.getSetCookie()) {
        resHeaders.append('Set-Cookie', cookie)
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    })
  } catch {
    return Response.json(
      {
        error: {
          code: 'API_BACKEND_UNREACHABLE',
          message:
            'Meetofast API service is starting up or unreachable. Verify that @meofast/api is running.',
        },
      },
      { status: 502 },
    )
  }
}

export const GET = forwardToHono
export const POST = forwardToHono
export const PUT = forwardToHono
export const PATCH = forwardToHono
export const DELETE = forwardToHono
export const OPTIONS = forwardToHono
export const HEAD = forwardToHono
