export const CATEGORIAS = [
    'Nacional',
    'Regional',
    'Policial',
    'Política',
    'Deportes',
    'Tecnología',
    'Entretención',
    'Internacional',
    'Economía',
];

export function slugCategoria(categoria) {
    return categoria
        .normalize('NFD')
        .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
}
