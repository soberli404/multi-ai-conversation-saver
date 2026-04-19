import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/background.ts'),
        'content-chatgpt': resolve(__dirname, 'src/content/chatgpt-extractor.ts'),
        'content-gemini': resolve(__dirname, 'src/content/gemini-extractor.ts'),
        'content-claude': resolve(__dirname, 'src/content/claude-extractor.ts'),
        'content-manus': resolve(__dirname, 'src/content/manus-extractor.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    outDir: 'dist',
  },
})
