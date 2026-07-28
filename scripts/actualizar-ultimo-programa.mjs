import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const CHANNEL_ID = 'UCvdeRKMWaVgk7sQM_0zRqrQ';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const DATA_PATH = path.join(process.cwd(), 'src/data/ultimo-programa.json');

async function obtenerUltimoDelFeed() {
    const respuesta = await fetch(FEED_URL);
    if (!respuesta.ok) {
        throw new Error(`No se pudo descargar el feed del canal (HTTP ${respuesta.status})`);
    }

    const xml = await respuesta.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    const entradas = parsed?.feed?.entry;
    const primerVideo = Array.isArray(entradas) ? entradas[0] : entradas;
    if (!primerVideo) return null;

    return { videoId: primerVideo['yt:videoId'], titulo: primerVideo.title };
}

// El feed RSS del canal siempre incluye su video más reciente, esté en vivo o
// no (confirmado con curl real: el video en vivo aparece ahí apenas empieza a
// transmitir). Por eso conviene chequear el estado real de ESE video puntual
// en su propia página de watch, en vez de escanear /live del canal como se
// hacía antes: esa página mostraba resultados distintos según la ubicación
// de quien pregunta — funcionaba bien desde Chile, pero desde los runners de
// GitHub Actions (EE.UU.) no marcaba el video propio como en vivo, aunque sí
// mostraba en vivo de OTROS canales en su sección de recomendados (lo que
// causó tanto el incidente de mostrar un canal ajeno como, después, el de no
// detectar el propio directo). Como el feed RSS solo lista videos del propio
// canal, este enfoque además elimina por completo el riesgo de tomar un
// video de otro canal, sin necesitar verificación aparte.
// NOTA: confirmado con debug real (2026-07-28) que desde los runners de
// GitHub Actions esta página llega SIN el campo "isLiveNow" (ni "lengthSeconds"),
// aunque el tamaño de la página es casi idéntico al que se recibe desde Chile
// — YouTube omite ese dato específico cuando reconoce al que pregunta como
// bot/datacenter, en vez de bloquear con 403. Por eso este chequeo por scraping
// NO detecta el en vivo de forma confiable desde GitHub Actions todavía;
// pendiente reemplazar por YouTube Data API v3 (videos.list, ~1 unidad por
// llamada) antes de confiar en esto para producción.
async function estaEnVivo(videoId) {
    const respuesta = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!respuesta.ok) return false;
    const html = await respuesta.text();
    return html.includes('"isLiveNow":true');
}

async function main() {
    const ultimo = await obtenerUltimoDelFeed();
    if (!ultimo) {
        console.log('El canal no tiene videos en su feed.');
        return;
    }

    const { videoId, titulo } = ultimo;
    const enVivo = await estaEnVivo(videoId);
    const actual = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

    if (actual.videoId === videoId && actual.enVivo === enVivo) {
        console.log(`Sin cambios: sigue "${titulo}" (${videoId})${enVivo ? ' [en vivo]' : ''}.`);
        return;
    }

    writeFileSync(
        DATA_PATH,
        JSON.stringify({ videoId, titulo, enVivo, actualizado: new Date().toISOString() }, null, 2) + '\n',
        'utf8',
    );
    console.log(`Actualizado: "${titulo}" (${videoId})${enVivo ? ' [en vivo]' : ''}.`);
}

main();
