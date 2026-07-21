import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import matter from 'gray-matter';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CATEGORIAS } from '../src/data/categorias.mjs';

const NOTICIAS_DIR = path.join(process.cwd(), 'src/content/noticias');
const SOURCES_PATH = path.join(process.cwd(), 'sources.json');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_NUEVAS_POR_FUENTE = Number(process.env.MAX_NUEVAS_POR_FUENTE) || 5;

if (!process.env.GEMINI_API_KEY) {
    console.error('Falta la variable de entorno GEMINI_API_KEY.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

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
    const respuesta = await fetch(fuente.url);
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

    const resultado = await model.generateContent(prompt);
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

            const { url: imagenUrl, credito: imagenCredito } = extraerImagen(item);
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
            console.error(`Error con la fuente ${fuente.nombre}:`, error.message);
        }
    }
    console.log(`Listo. ${total} noticia(s) nueva(s) creada(s).`);
}

main();
