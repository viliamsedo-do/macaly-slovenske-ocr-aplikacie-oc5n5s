import { afterEach, describe, expect, it, vi } from "vitest"

import { canonicalUrl } from "./canonical-url"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("canonicalUrl", () => {
  it("builds a URL from the configured canonical origin", () => {
    vi.stubEnv("VITE_CANONICAL_ORIGIN", "https://example.com")

    expect(canonicalUrl("/products")).toBe("https://example.com/products")
  })

  it("adds only explicitly passed query parameters", () => {
    vi.stubEnv("VITE_CANONICAL_ORIGIN", "https://example.com")

    expect(
      canonicalUrl("/products?stale=true", {
        category: "shoes",
        page: 2,
        ignored: undefined,
      }),
    ).toBe("https://example.com/products?category=shoes&page=2")
  })

  it("removes hashes from the canonical URL", () => {
    vi.stubEnv("VITE_CANONICAL_ORIGIN", "https://example.com")

    expect(canonicalUrl("/products#details")).toBe(
      "https://example.com/products",
    )
  })

  it("returns undefined without a configured canonical origin", () => {
    vi.stubEnv("VITE_CANONICAL_ORIGIN", "")

    expect(canonicalUrl("/products")).toBeUndefined()
  })
})
