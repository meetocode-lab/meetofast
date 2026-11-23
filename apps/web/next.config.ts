import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@meofast/shared'],
  poweredByHeader: false,
}

export default nextConfig
