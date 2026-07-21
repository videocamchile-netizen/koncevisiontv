import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DATA_PATH = path.join(process.cwd(), 'src/data/indicadores.json');

async function obtenerValor(codigo) {
    const respuesta = await fetch(`https://mindicador.cl/api/${codigo}`);
    if (!respuesta.ok) {
        throw new Error(`No se pudo obtener ${codigo} (HTTP ${respuesta.status})`);
    }
    const datos = await respuesta.json();
    const ultimo = datos.serie?.[0];
    if (!ultimo) throw new Error(`Sin datos para ${codigo}`);
    return ultimo;
}

async function main() {
    const [dolar, uf] = await Promise.all([obtenerValor('dolar'), obtenerValor('uf')]);

    const actual = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    if (actual.dolar === dolar.valor && actual.uf === uf.valor) {
        console.log('Sin cambios en dólar/UF.');
        return;
    }

    writeFileSync(
        DATA_PATH,
        JSON.stringify(
            {
                dolar: dolar.valor,
                uf: uf.valor,
                fecha: new Date().toISOString(),
            },
            null,
            2,
        ) + '\n',
        'utf8',
    );
    console.log(`Actualizado: Dólar $${dolar.valor} · UF $${uf.valor}`);
}

main();
