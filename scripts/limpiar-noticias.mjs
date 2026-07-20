import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const NOTICIAS_DIR = path.join(process.cwd(), 'src/content/noticias');
const DIAS_MAXIMOS = 7;

function main() {
    const ahora = Date.now();
    const limiteMs = DIAS_MAXIMOS * 24 * 60 * 60 * 1000;
    const archivos = readdirSync(NOTICIAS_DIR).filter((f) => f.endsWith('.md'));

    let eliminados = 0;
    for (const archivo of archivos) {
        const ruta = path.join(NOTICIAS_DIR, archivo);
        const { data } = matter(readFileSync(ruta, 'utf8'));
        const fecha = new Date(data.fecha).getTime();
        if (Number.isFinite(fecha) && ahora - fecha > limiteMs) {
            unlinkSync(ruta);
            eliminados++;
            console.log(`Eliminado (>${DIAS_MAXIMOS} días): ${archivo}`);
        }
    }
    console.log(`Listo. ${eliminados} noticia(s) eliminada(s) de ${archivos.length}.`);
}

main();
