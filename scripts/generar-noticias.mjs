import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import matter from 'gray-matter';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CATEGORIAS } from '../src/data/categorias.mjs';

const NOTICIAS_DIR = path.join(process.cwd(), 'src/content/noticias');
const SOURCES_PATH = path.join(process.cwd(), 'sources.json');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const MAX_NUEVAS_POR_FUENTE = Number(process.env.MAX_NUEVAS_POR_FUENTE) || 2;
const MAX_DEPORTES_POR_CORRIDA = Number(process.env.MAX_DEPORTES_POR_CORRIDA) || 1;
let deportesEnCorrida = 0;

if (!process.env.GEMINI_API_KEY) {
    console.error('Falta la variable de entorno GEMINI_API_KEY.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const GEMINI_RATE_LIMIT_MS = 13000;
let ultimaLlamadaGemini = 0;
let geminiAgotado = false;

class CuotaGeminiExcedidaError extends Error {}

function esErrorDeCuota(error) {
    return /429|quota|rate limit|too many requests/i.test(error?.message ?? '');
}

async function esperarCupoGemini() {
    const espera = ultimaLlamadaGemini + GEMINI_RATE_LIMIT_MS - Date.now();
    if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
    ultimaLlamadaGemini = Date.now();
}

function slugify(texto) {
    return texto
        .normalize('NFD')
        .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 80);
}

function limpiarHtml(html) {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizarItems(canal) {
    const items = canal?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
}

function normalizarUrlsSitemap(urlset, filtroRuta) {
    const urls = urlset?.url;
    const lista = Array.isArray(urls) ? urls : urls ? [urls] : [];
    return lista
        .filter((u) => !filtroRuta || String(u.loc).includes(filtroRuta))
        .map((u) => ({
            title: u['news:news']?.['news:title'] ?? u.loc,
            link: u.loc,
            guid: u.loc,
            pubDate: u['news:news']?.['news:publication_date'],
        }));
}

async function obtenerItemsDeFuente(fuente) {
    const respuesta = await fetch(fuente.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoncevisionBot/1.0; +https://koncevisiontv.vercel.app)' },
        signal: AbortSignal.timeout(15000),
    });
    if (!respuesta.ok) {
        throw new Error(`No se pudo descargar ${fuente.url} (HTTP ${respuesta.status})`);
    }
    const xml = await respuesta.text();
    const parsed = xmlParser.parse(xml);
    if (fuente.tipo === 'sitemap-news') {
        return normalizarUrlsSitemap(parsed?.urlset, fuente.filtroRuta);
    }
    return normalizarItems(parsed?.rss?.channel);
}

function extraerImagen(item) {
    const media = item['media:content'];
    if (!media) return {};
    const nodo = Array.isArray(media) ? media[0] : media;
    const credito = nodo?.['media:credit'];
    return {
        url: nodo?.['@_url'],
        credito: typeof credito === 'object' ? credito?.['#text'] : credito,
    };
}

async function extraerImagenDePagina(url) {
    try {
        const respuesta = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoncevisionBot/1.0; +https://koncevisiontv.vercel.app)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!respuesta.ok) return undefined;
        const html = await respuesta.text();
        const metaTags = html.match(/<meta[^>]+>/gi) || [];
        for (const tag of metaTags) {
            if (/(property|name)=["'](og:image|twitter:image)["']/i.test(tag)) {
                const contenido = tag.match(/content=["']([^"']+)["']/i);
                if (contenido) return contenido[1];
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

async function extraerCuerpoDePagina(url) {
    try {
        const respuesta = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoncevisionBot/1.0; +https://koncevisiontv.vercel.app)' },
            signal: AbortSignal.timeout(10000),
        });
        if (!respuesta.ok) return undefined;
        const html = await respuesta.text();
        const inicio = html.indexOf('id="post_content"');
        if (inicio === -1) return undefined;
        const finRelacionadas = html.indexOf('id="container-related-post-manual"', inicio);
        const bloque = html.slice(inicio, finRelacionadas === -1 ? inicio + 20000 : finRelacionadas);
        const parrafos = [...bloque.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map((m) => limpiarHtml(m[1]));
        const texto = parrafos.filter(Boolean).join('\n\n');
        return texto || undefined;
    } catch {
        return undefined;
    }
}

function construirPrompt({ titulo, cuerpoOriginal, fuenteNombre }) {
    return `Eres redactor del portal de noticias Koncevision TV. A partir de la siguiente noticia de ${fuenteNombre}, escribe una versión ORIGINAL (no copies frases textuales del original) en español chileno neutro.

Título original: ${titulo}

Contenido original:
"""
${cuerpoOriginal.slice(0, 8000)}
"""

Responde SOLO con un JSON válido (sin markdown, sin comentarios) con esta forma exacta:
{
  "titulo": "titulo propio, distinto al original, máximo 100 caracteres",
  "resumen": "resumen de 2-3 frases para la portada",
  "cuerpo": "cuerpo completo reescrito en 3-5 párrafos, en formato Markdown, sin repetir el resumen",
  "categoria": "una de estas opciones exactas: ${CATEGORIAS.join(', ')}"
}`;
}

function limpiarJson(texto) {
    return texto
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '');
}

async function redactarConGemini(datos) {
    await esperarCupoGemini();
    let resultado;
    try {
        resultado = await model.generateContent(construirPrompt(datos), { timeout: 30000 });
    } catch (error) {
        if (esErrorDeCuota(error)) throw new CuotaGeminiExcedidaError(error.message);
        throw error;
    }
    return JSON.parse(limpiarJson(resultado.response.text()));
}

async function redactarConGroq(datos) {
    const respuesta = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [{ role: 'user', content: construirPrompt(datos) }],
            response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(30000),
    });
    if (!respuesta.ok) {
        throw new Error(`Groq respondió HTTP ${respuesta.status}: ${await respuesta.text()}`);
    }
    const cuerpo = await respuesta.json();
    return JSON.parse(limpiarJson(cuerpo.choices[0].message.content));
}

async function redactarNoticia(datos) {
    if (!geminiAgotado) {
        try {
            return await redactarConGemini(datos);
        } catch (error) {
            if (!(error instanceof CuotaGeminiExcedidaError)) throw error;
            geminiAgotado = true;
            console.log('Cuota diaria de Gemini agotada, el resto de esta corrida usa el respaldo (Groq).');
            if (!process.env.GROQ_API_KEY) throw error;
        }
    }
    return redactarConGroq(datos);
}

async function procesarFuente(fuente, loteTimestamp) {
    console.log(`Revisando fuente: ${fuente.nombre}`);
    const items = await obtenerItemsDeFuente(fuente);
    const tope = fuente.maxPorCorrida ?? MAX_NUEVAS_POR_FUENTE;
    let creadas = 0;

    for (const item of items) {
        if (creadas >= tope) break;
        try {
            const enlaceOriginal = item.link;
            const guidRaw = typeof item.guid === 'object' ? item.guid?.['#text'] : item.guid;
            const guid = guidRaw || enlaceOriginal;
            if (!guid) continue;

            const slugBase = guid.split('/').filter(Boolean).pop() || item.title;
            const slug = slugify(String(slugBase));
            const rutaArchivo = path.join(NOTICIAS_DIR, `${slug}.md`);
            if (existsSync(rutaArchivo)) continue;

            const cuerpoOriginalHtml = item['content:encoded'] ?? item.description ?? '';
            let cuerpoOriginal = limpiarHtml(String(cuerpoOriginalHtml));
            if (!cuerpoOriginal && fuente.tipo === 'sitemap-news') {
                cuerpoOriginal = (await extraerCuerpoDePagina(enlaceOriginal)) ?? '';
            }
            if (!cuerpoOriginal) continue;

            let { url: imagenUrl, credito: imagenCredito } = extraerImagen(item);
            if (!imagenUrl) {
                imagenUrl = await extraerImagenDePagina(enlaceOriginal);
                if (imagenUrl && !imagenCredito) imagenCredito = fuente.nombre;
            }
            const redactado = await redactarNoticia({
                titulo: item.title,
                cuerpoOriginal,
                fuenteNombre: fuente.nombre,
            });

            if (redactado.categoria === 'Deportes' && deportesEnCorrida >= MAX_DEPORTES_POR_CORRIDA) {
                console.log(`Descartada por tope de Deportes de la corrida: ${slug}`);
                continue;
            }

            const frontmatter = {
                titulo: redactado.titulo,
                resumen: redactado.resumen,
                categoria: CATEGORIAS.includes(redactado.categoria) ? redactado.categoria : 'Nacional',
                imagen: imagenUrl || undefined,
                imagenCredito: imagenCredito || undefined,
                fuenteNombre: fuente.nombre,
                fuenteUrl: enlaceOriginal,
                fecha: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                agregada: loteTimestamp,
            };

            const archivo = matter.stringify(redactado.cuerpo, frontmatter);
            writeFileSync(rutaArchivo, archivo, 'utf8');
            creadas++;
            if (frontmatter.categoria === 'Deportes') deportesEnCorrida++;
            console.log(`Creada: ${slug}.md`);
        } catch (error) {
            if (error instanceof CuotaGeminiExcedidaError) throw error;
            console.error(`Error procesando un item de ${fuente.nombre}:`, error.message);
        }
    }
    return creadas;
}

async function main() {
    if (!existsSync(NOTICIAS_DIR)) mkdirSync(NOTICIAS_DIR, { recursive: true });
    const fuentes = JSON.parse(readFileSync(SOURCES_PATH, 'utf8')).filter(
        (f) => f.activo && ['rss', 'sitemap-news'].includes(f.tipo),
    );

    const loteTimestamp = new Date().toISOString();
    let total = 0;
    for (const fuente of fuentes) {
        try {
            total += await procesarFuente(fuente, loteTimestamp);
        } catch (error) {
            if (error instanceof CuotaGeminiExcedidaError) {
                console.log(`Cuota diaria de Gemini agotada, se corta la corrida (${total} noticia(s) creada(s) antes de cortar).`);
                break;
            }
            console.error(`Error con la fuente ${fuente.nombre}:`, error.message);
        }
    }
    console.log(`Listo. ${total} noticia(s) nueva(s) creada(s).`);
}

main();
