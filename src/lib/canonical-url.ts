type CanonicalQuery = Record<string, string | number | undefined>

export function canonicalUrl(
  pathname: string,
  query: CanonicalQuery = {},
): string | undefined {
  const origin = import.meta.env.VITE_CANONICAL_ORIGIN
  if (!origin) return undefined

  const url = new URL(pathname, origin)
  url.search = ""
  url.hash = ""

  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, String(value))
    }
  }

  return url.toString()
}
