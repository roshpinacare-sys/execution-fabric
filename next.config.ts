import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Task-140: נמדד-ונדחה — הסכמה של Next 16 במכונה מכירה watchOptions רק ברמה-העליונה
  // ורק עם pollIntervalMs (אין ignored לנתיבים). ניסיון turbopack.watchOptions.ignored
  // נדחה ע"י השרת ("Unrecognized key(s)"). הסחרור מטופל בשורש: תקרה-מכוילת + חלון-שקט
  // (mini-services/fabric-heartbeat/app-guard.ts) — לא-בקונפיג.
};

export default nextConfig;
