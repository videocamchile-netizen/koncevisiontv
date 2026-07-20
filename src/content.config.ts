import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const noticias = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/noticias' }),
  schema: z.object({
    titulo: z.string(),
    resumen: z.string(),
    categoria: z.string(),
    imagen: z.string().url().optional(),
    imagenCredito: z.string().optional(),
    fuenteNombre: z.string(),
    fuenteUrl: z.string().url(),
    fecha: z.coerce.date(),
  }),
});

export const collections = { noticias };
