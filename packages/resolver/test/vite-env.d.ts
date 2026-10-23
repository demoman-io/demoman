// `import.meta.glob` is a Vite transform, and its type ships in `vite/client`
// — which is not resolvable here, because vitest brings vite in transitively
// and pnpm's isolated store does not expose it to this package. Declaring the
// one member the fixtures helper uses is lighter than taking a direct
// dependency on vite for a single type.
//
// No import/export in this file: it must stay a global script so the
// interface merges with the built-in ImportMeta.
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, unknown>;
}
