// Proxy transparente hacia el Worker de Denuncias: koncevisiontv.pages.dev/superadmin
// muestra el panel del Worker sin necesidad de la URL larga de workers.dev.
// Las acciones del panel (marcar/borrar) apuntan directo a la URL real del Worker,
// así que esta función solo necesita servir bien la carga inicial (GET).

const ORIGEN_WORKER = 'https://koncevision-denuncia.videocamchile.workers.dev';

export const onRequest: PagesFunction = async (context) => {
    const url = new URL(context.request.url);
    const rutaDestino = url.pathname.replace(/^\/superadmin/, '/admin') || '/admin';
    const destino = new URL(rutaDestino + url.search, ORIGEN_WORKER);

    const peticion = new Request(destino.toString(), context.request);
    return fetch(peticion);
};
