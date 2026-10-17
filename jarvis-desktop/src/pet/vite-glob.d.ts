// Vite's import.meta.glob, typed locally for the pet registry (the project does not load vite/client types).
interface ImportMeta {
  glob(pattern: string | string[], options?: {eager?: boolean; import?: string; query?: string | Record<string, string>}): Record<string, unknown>;
}
