// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Placeholder hasta que se compre el dominio definitivo de Koncevision TV.
  // Cambiar cuando el sitio quede conectado a su dominio en Cloudflare.
  site: 'https://koncevisiontv.pages.dev',
  image: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.biobiochile.cl' },
      { protocol: 'https', hostname: '**.ex-ante.cl' },
      { protocol: 'https', hostname: '**.diarioconcepcion.cl' },
      { protocol: 'https', hostname: '**.gob.cl' },
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'fastly.picsum.photos' },
    ],
  },
});
