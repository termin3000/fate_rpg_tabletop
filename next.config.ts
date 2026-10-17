import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: [
    "localhost:81",
    "localhost:8080",
    "localhost:9090",
    "21.0.11.21:81",
    "21.0.12.158:3456",
    "localhost:3456",
    "127.0.0.1:3456",
    "*.space-z.ai",
    "*.loca.lt",
    "*.localtunnel.me",
  ],
};

export default nextConfig;
