import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';

export async function GET(context: APIContext) {
    const noticias = (await getCollection('noticias')).sort(
        (a, b) => b.data.fecha.valueOf() - a.data.fecha.valueOf(),
    );

    return rss({
        title: 'Koncevision TV',
        description: 'Noticias al instante, redactadas y publicadas de forma automática.',
        site: context.site!,
        items: noticias.map((noticia) => ({
            title: noticia.data.titulo,
            description: noticia.data.resumen,
            pubDate: noticia.data.fecha,
            link: `/noticias/${noticia.id}/`,
            categories: [noticia.data.categoria],
        })),
    });
}
