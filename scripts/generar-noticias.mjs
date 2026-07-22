import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import matter from 'gray-matter';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CATEGORIAS } from '../src/data/categorias.mjs';

const NOTICIAS_DIR = path.join(process.cwd(), 'src/content/noticias');
const SOURCES_PATH = path.join(process.cwd(), 'sources.json');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const MAX_NUEVAS_POR_FUENTE = Number(process.env.MAX_NUEVAS_POR_FUENTE) || 2;

if (!process.env.GEMINI_API_KEY) {
    console.error('Falta la variable de entorno GEMINI_API_KEY.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const GEMINI_RATE_LIMIT_MS = 13000;
let ultimaLlamadaGemini = 0;

class CuotaGeminiExcedidaError extends Error {}

function esErrorDeCuota(error) {
    return /429|quota/i.test(error?.message ?? '');
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

async function obtenerItemsDeFuente(fuente) {
    const respuesta = await fetch(fuente.url, { signal: AbortSignal.timeout(15000) });
    if (!respuesta.ok) {
        throw new Error(`No se pudo descargar ${fuente.url} (HTTP ${respuesta.status})`);
    }
    const xml = await respuesta.text();
    const parsed = xmlParser.parse(xml);
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

async function redactarConGemini({ titulo, cuerpoOriginal, fuenteNombre }) {
    const prompt = `Eres redactor del portal de noticias Koncevision TV. A partir de la siguiente noticia de ${fuenteNombre}, escribe una versión ORIGINAL (no copies frases textuales del original) en español chileno neutro.

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

    await esperarCupoGemini();
    let resultado;
    try {
        resultado = await model.generateContent(prompt, { timeout: 30000 });
    } catch (error) {
        if (esErrorDeCuota(error)) throw new CuotaGeminiExcedidaError(error.message);
        throw error;
    }
    const texto = resultado.response
        .text()
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '');
    return JSON.parse(texto);
}

async function procesarFuente(fuente) {
    console.log(`Revisando fuente: ${fuente.nombre}`);
    const items = await obtenerItemsDeFuente(fuente);
    let creadas = 0;

    for (const item of items) {
        if (creadas >= MAX_NUEVAS_POR_FUENTE) break;
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
            const cuerpoOriginal = limpiarHtml(String(cuerpoOriginalHtml));
            if (!cuerpoOriginal) continue;

            let { url: imagenUrl, credito: imagenCredito } = extraerImagen(item);
            if (!imagenUrl) {
                imagenUrl = await extraerImagenDePagina(enlaceOriginal);
                if (imagenUrl && !imagenCredito) imagenCredito = fuente.nombre;
            }
            const redactado = await redactarConGemini({
                titulo: item.title,
                cuerpoOriginal,
                fuenteNombre: fuente.nombre,
            });

            const frontmatter = {
                titulo: redactado.titulo,
                resumen: redactado.resumen,
                categoria: CATEGORIAS.includes(redactado.categoria) ? redactado.categoria : 'Nacional',
                imagen: imagenUrl || undefined,
                imagenCredito: imagenCredito || undefined,
                fuenteNombre: fuente.nombre,
                fuenteUrl: enlaceOriginal,
                fecha: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            };

            const archivo = matter.stringify(redactado.cuerpo, frontmatter);
            writeFileSync(rutaArchivo, archivo, 'utf8');
            creadas++;
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
        (f) => f.activo && f.tipo === 'rss',
    );

    let total = 0;
    for (const fuente of fuentes) {
        try {
            total += await procesarFuente(fuente);
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
