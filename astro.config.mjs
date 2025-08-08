// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
    integrations: [],
    vite: {
      server: {
        hmr: {
          port: 3001
        }
      },
      define: {
        'process.env.HIVETALK_RELAYS': JSON.stringify(process.env.HIVETALK_RELAYS || 'ws://localhost:3334')
      }
    }
});
