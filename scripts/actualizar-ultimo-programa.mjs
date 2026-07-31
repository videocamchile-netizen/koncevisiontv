import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const CHANNEL_ID = 'UCvdeRKMWaVgk7sQM_0zRqrQ';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const DATA_PATH = path.join(process.cwd(), 'src/data/ultimo-programa.json');

// YouTube tiene caídas intermitentes conocidas de este endpoint en 2026 (404/500
// aunque el canal esté sano) — no es algo propio de este canal ni de nuestro
// código, confirmado probando también con canales grandes ajenos. Se trata como
// falla temporal, no como error real: el ciclo actual se salta en silencio y el
// cron de 30 min lo reintenta solo, sin mandar correo de falla por cada caída.
class FeedTemporalmenteCaidoError extends Error {}

async function obtenerUltimoDelFeed() {
    const respuesta = await fetch(FEED_URL);
    if (!respuesta.ok) {
        throw new FeedTemporalmenteCaidoError(`HTTP ${respuesta.status}`);
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
// en vez de escanear /live del canal como se hacía antes — el feed RSS solo
// lista videos del propio canal, así que este enfoque elimina por completo
// el riesgo de tomar un video de otro canal, sin necesitar verificación aparte.
// Se usa YouTube Data API v3 (videos.list, ~1 unidad de cuota por llamada, muy
// por debajo del límite gratis de 10.000/día) en vez de escanear el HTML de la
// watch page: confirmado con debug real (2026-07-28) que los runners de GitHub
// Actions reciben una versión de esa página SIN el campo "isLiveNow" (YouTube
// omite ese dato cuando reconoce tráfico de datacenter, sin bloquear con 403),
// así que el scraping nunca detectaba el en vivo de forma confiable ahí.
async function estaEnVivo(videoId) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        throw new Error('Falta la variable de entorno YOUTUBE_API_KEY.');
    }

    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
    const respuesta = await fetch(url);
    if (!respuesta.ok) {
        throw new Error(`YouTube Data API respondió HTTP ${respuesta.status}.`);
    }

    const datos = await respuesta.json();
    const estado = datos.items?.[0]?.snippet?.liveBroadcastContent;
    return estado === 'live';
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

main().catch((error) => {
    if (error instanceof FeedTemporalmenteCaidoError) {
        console.log(`Feed de YouTube no disponible este ciclo (${error.message}), se reintenta en el próximo.`);
        return;
    }
    console.error(error);
    process.exitCode = 1;
});
