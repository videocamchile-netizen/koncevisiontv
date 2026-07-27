import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const CHANNEL_ID = 'UCvdeRKMWaVgk7sQM_0zRqrQ';
const CANAL_URL_OEMBED = 'https://www.youtube.com/@KoncevisionTV';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const LIVE_URL = `https://www.youtube.com/channel/${CHANNEL_ID}/live`;
const DATA_PATH = path.join(process.cwd(), 'src/data/ultimo-programa.json');

// Verifica con el oEmbed público (gratis, sin cuota) que el videoId realmente
// pertenece al canal de Koncevision. Es la única forma confiable de descartar
// falsos positivos: cuando el canal NO está en vivo, /live redirige a la home
// del canal, que puede incluir recomendaciones de OTROS canales — si alguna
// de esas recomendaciones está en vivo, aparece "isLive":true en la página
// aunque no tenga nada que ver con Koncevision.
async function esVideoDelCanal(videoId) {
    const respuesta = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    );
    if (!respuesta.ok) return false;
    const datos = await respuesta.json();
    return datos.author_url === CANAL_URL_OEMBED;
}

// El oEmbed de YouTube apuntando a /live NO funciona (siempre devuelve 404),
// así que para detectar si el canal está transmitiendo hay que descargar la
// página /live y buscar "isLive":true en su HTML.
async function detectarEnVivo() {
    const respuesta = await fetch(LIVE_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!respuesta.ok) return null;

    const html = await respuesta.text();
    if (!html.includes('"isLive":true')) return null;

    const matchVideoId = html.match(/"videoId":"([^"]+)"/);
    if (!matchVideoId) return null;

    const videoId = matchVideoId[1];
    if (!(await esVideoDelCanal(videoId))) {
        console.log(`Descartado: "${videoId}" está en vivo pero no es del canal de Koncevision.`);
        return null;
    }

    const matchTitulo = html.match(/<title>([^<]+)<\/title>/);
    return {
        videoId,
        titulo: matchTitulo ? matchTitulo[1].replace(/ - YouTube$/, '') : 'Transmisión en vivo',
    };
}

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

async function main() {
    const enVivo = await detectarEnVivo();
    const resultado = enVivo ?? (await obtenerUltimoDelFeed());

    if (!resultado) {
        console.log('El canal no tiene videos en su feed ni transmisión en vivo.');
        return;
    }

    const { videoId, titulo } = resultado;
    const actual = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

    if (actual.videoId === videoId && actual.enVivo === Boolean(enVivo)) {
        console.log(`Sin cambios: sigue "${titulo}" (${videoId})${enVivo ? ' [en vivo]' : ''}.`);
        return;
    }

    writeFileSync(
        DATA_PATH,
        JSON.stringify(
            { videoId, titulo, enVivo: Boolean(enVivo), actualizado: new Date().toISOString() },
            null,
            2,
        ) + '\n',
        'utf8',
    );
    console.log(`Actualizado: "${titulo}" (${videoId})${enVivo ? ' [en vivo]' : ''}.`);
}

main();
