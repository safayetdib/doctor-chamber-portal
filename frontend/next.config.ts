import type { NextConfig } from 'next';

const apiOrigin = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000';
const parsed = new URL(apiOrigin);
if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
  throw new Error('API_INTERNAL_ORIGIN must be an HTTP(S) origin without path, query or credentials.');
}

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@practice/contracts'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${parsed.origin}/api/:path*` }];
  }
};

export default config;
