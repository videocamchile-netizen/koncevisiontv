import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const CHANNEL_ID = 'UCvdeRKMWaVgk7sQM_0zRqrQ';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const DATA_PATH = path.join(process.cwd(), 'src/data/ultimo-programa.json');

async function main() {
    const respuesta = await fetch(FEED_URL);
    if (!respuesta.ok) {
        throw new Error(`No se pudo descargar el feed del canal (HTTP ${respuesta.status})`);
    }

    const xml = await respuesta.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    const entradas = parsed?.feed?.entry;
    const primerVideo = Array.isArray(entradas) ? entradas[0] : entradas;

    if (!primerVideo) {
        console.log('El canal no tiene videos en su feed.');
        return;
    }

    const videoId = primerVideo['yt:videoId'];
    const titulo = primerVideo.title;

    const actual = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    if (actual.videoId === videoId) {
        console.log(`Sin cambios: el último programa sigue siendo "${titulo}" (${videoId}).`);
        return;
    }

    writeFileSync(
        DATA_PATH,
        JSON.stringify({ videoId, titulo, actualizado: new Date().toISOString() }, null, 2) + '\n',
        'utf8',
    );
    console.log(`Actualizado: nuevo último programa "${titulo}" (${videoId}).`);
}

main();
