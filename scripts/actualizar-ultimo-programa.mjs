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

// Busca el videoId más CERCANO a una posición dada en el HTML (no el primero
// de toda la página), asumiendo que en el JSON embebido de YouTube el videoId
// vive dentro del mismo objeto que su propio "isLive" — están a poca distancia
// de texto entre sí, a diferencia de un videoId de otro video cualquiera.
function videoIdMasCercano(html, posicion) {
    const desde = Math.max(0, posicion - 1500);
    const hasta = Math.min(html.length, posicion + 1500);
    const ventana = html.slice(desde, hasta);
    const posEnVentana = posicion - desde;

    let mejorVideoId = null;
    let mejorDistancia = Infinity;
    const regex = /"videoId":"([^"]+)"/g;
    let coincidencia;
    while ((coincidencia = regex.exec(ventana))) {
        const distancia = Math.abs(coincidencia.index - posEnVentana);
        if (distancia < mejorDistancia) {
            mejorDistancia = distancia;
            mejorVideoId = coincidencia[1];
        }
    }
    return mejorVideoId;
}

// El oEmbed de YouTube apuntando a /live NO funciona (siempre devuelve 404),
// así que para detectar si el canal está transmitiendo hay que descargar la
// página /live y buscar "isLive":true en su HTML. Cuando el canal NO está en
// vivo, /live redirige a la home del canal, que puede traer recomendaciones
// de OTROS canales — si alguna está en vivo, aparece "isLive":true igual,
// así que cada candidato se valida por posición (videoIdMasCercano) y por
// canal real (esVideoDelCanal) antes de aceptarlo.
async function detectarEnVivo() {
    const respuesta = await fetch(LIVE_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    console.log(`[debug] HTTP ${respuesta.status}, redirigido a: ${respuesta.url}`);
    if (!respuesta.ok) return null;

    const html = await respuesta.text();
    console.log(`[debug] HTML recibido: ${html.length} caracteres, contiene "isLive":true x${(html.match(/"isLive":true/g) || []).length}, contiene "isLiveNow":true x${(html.match(/"isLiveNow":true/g) || []).length}`);
    const regexIsLive = /"isLive":true/g;
    let coincidenciaIsLive;
    const yaProbados = new Set();

    while ((coincidenciaIsLive = regexIsLive.exec(html))) {
        const videoId = videoIdMasCercano(html, coincidenciaIsLive.index);
        if (!videoId || yaProbados.has(videoId)) continue;
        yaProbados.add(videoId);

        if (await esVideoDelCanal(videoId)) {
            const matchTitulo = html.match(/<title>([^<]+)<\/title>/);
            return {
                videoId,
                titulo: matchTitulo ? matchTitulo[1].replace(/ - YouTube$/, '') : 'Transmisión en vivo',
            };
        }
        console.log(`Descartado: "${videoId}" está en vivo pero no es del canal de Koncevision.`);
    }

    return null;
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
