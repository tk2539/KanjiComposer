import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/KanjiComposer/",
  plugins: [react(), tailwindcss()],
  assetsInclude: ["**/*.xml", "**/*.svg"], // SVG直読み許可
});