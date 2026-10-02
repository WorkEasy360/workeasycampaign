/** URL-safe slug from a display name. Collisions are resolved by the caller with a random suffix. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s.length >= 3 ? s : `${s || 'org'}-${Math.random().toString(36).slice(2, 6)}`;
}

export function withSuffix(slug: string): string {
  return `${slug.slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`;
}
