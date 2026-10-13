import type { MetadataRoute } from "next";

/**
 * Lets people install Venture Studio as an app (Add to Home Screen on iPhone, Install on Android and desktop Chrome or
 * Edge). iPhones only allow browser notifications for sites installed this way.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Venture Studio",
    short_name: "Venture Studio",
    description: "A shared operating system for ventures, groups, channels, and focused execution.",
    start_url: "/today/live",
    scope: "/",
    display: "standalone",
    background_color: "#f7faf8",
    theme_color: "#f7faf8",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
