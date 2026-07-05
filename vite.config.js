import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Build: sorgenti modulari in src/ → un unico index.html self-contained in dist/
// (tutto JS/CSS inlinato). Gli asset in public/ (icone, manifest, sw) vengono copiati a parte.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 5000,
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
