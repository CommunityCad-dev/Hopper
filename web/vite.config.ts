import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The bundle is loaded by a plain <script defer> tag that nginx injects into the
// host interface's index.html, at a fixed path. So: one self-contained IIFE, a
// stable filename (no content hash), and no separate CSS file — component styles
// are inlined into the Shadow DOM as strings.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    target: 'es2020',
    lib: {
      entry: 'src/inject.tsx',
      formats: ['iife'],
      name: 'communitycadInject',
      fileName: () => 'inject.js',
    },
  },
});
