import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Task-140 (מדידה-חיה): ה-organs כותבים-קבצי-מצב-רצוף (db/, sovereign/, mini-services/,
  // dev.log) — כל-כתיבה-הציפה-את-ה-watcher ותרמה-לצמיחת-RSS-רציפה (+2MB/שנ'). מקור-האמת
  // של-הקומפילציה הוא src/ בלבד — מתעלמים-מכל-השאר-שנכתב-ברציפות.
  turbopack: {
    watchOptions: {
      ignored: ["**/db/**", "**/sovereign/**", "**/mini-services/**", "**/dev.log", "**/tool-results/**", "**/fabric-backups/**"],
    },
  },
};

export default nextConfig;
