import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Scans `public/audio/radio/<channel>/*.mp3` and exposes the result as a
 * virtual module so the radio can pick tracks at random per channel.
 *
 * Channels = top-level directory names; URLs are URL-encoded (some files
 * have spaces / quotes / apostrophes in their names).
 */
function radioManifestPlugin(): Plugin {
  const VIRTUAL_ID = "virtual:radio-manifest";
  const RESOLVED_ID = "\0" + VIRTUAL_ID;
  const audioRoot = path.resolve(process.cwd(), "public/audio/radio");

  const buildManifest = (): Record<string, string[]> => {
    if (!fs.existsSync(audioRoot)) return {};
    const out: Record<string, string[]> = {};
    for (const entry of fs.readdirSync(audioRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const channel = entry.name;
      const dir = path.join(audioRoot, channel);
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".mp3"))
        .sort()
        .map((f) => `/audio/radio/${encodeURIComponent(channel)}/${encodeURIComponent(f)}`);
      if (files.length > 0) out[channel] = files;
    }
    return out;
  };

  return {
    name: "radio-manifest",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export const RADIO_MANIFEST = ${JSON.stringify(buildManifest(), null, 2)};\n`;
    },
    configureServer(server) {
      // Hot-reload the manifest when files are added/removed in dev.
      const onChange = (file: string) => {
        if (!file.startsWith(audioRoot)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload", path: "*" });
      };
      server.watcher.add(audioRoot);
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
    },
  };
}

export default defineConfig({
  plugins: [radioManifestPlugin()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
