import { defineConfig } from "vite";

// Tauri sets these when it drives the build; they select a browser target matching the webview
// each platform actually ships rather than the lowest common denominator.
const platform = process.env["TAURI_ENV_PLATFORM"];
const debug = Boolean(process.env["TAURI_ENV_DEBUG"]);

export default defineConfig({
  // Tauri prints its own errors here; clearing the screen hides them.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Bound to loopback. A dev server listening on every interface serves the application — and
    // whatever it can reach — to the rest of the network.
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Windows ships WebView2 (Chromium); macOS and iOS ship WKWebView; Android ships Chromium.
    target: platform === "windows" || platform === "android" ? "chrome105" : "safari13",
    // Boolean rather than a named minifier: Vite 8 bundles with rolldown and its own minifier,
    // and naming esbuild here pulls in a package that is no longer part of the toolchain.
    minify: !debug,
    sourcemap: debug,
    // A drawing engine plus pdf.js is genuinely large; the warning is noise rather than a signal.
    chunkSizeWarningLimit: 1500,
  },
});
