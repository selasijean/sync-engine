/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080",
    NEXT_PUBLIC_SSE_URL: process.env.NEXT_PUBLIC_SSE_URL || "http://localhost:8081",
  },
};

module.exports = nextConfig;
