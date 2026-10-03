import { defineConfig } from 'vite';

export default defineConfig({
  // Relative assets also work on github.io/<repository>/ and on the custom domain.
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          vrm: ['@pixiv/three-vrm'],
        },
      },
    },
  },
});
