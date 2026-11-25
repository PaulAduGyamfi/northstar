import type { MetadataRoute } from "next";

// PWA install (ADR-0005). No service worker or icons yet: they come with push approvals.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Northstar",
    short_name: "Northstar",
    start_url: "/",
    display: "standalone",
    background_color: "#FFF8F0",
    theme_color: "#1B1530",
  };
}
