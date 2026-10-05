import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Advisory relative-import evidence, not a replacement for a runner's resolver.
 * Bound reads and explicitly report aliases, packages, dynamic and unresolved edges. */
export function moduleContext(root: string, candidates: string[]) {
  const queue = candidates.map((file) => ({ file, depth: 0 }));
  const seen = new Set<string>();
  const modules: {
    file: string;
    imports: string[];
    unresolved: string[];
    excerpt: string;
  }[] = [];
  let remaining = 64_000;
  let truncated = false;
  while (queue.length) {
    const entry = queue.shift()!;
    try {
      entry.file = realpathSync(entry.file);
      const relative = path.relative(root, entry.file);
      if (
        relative.startsWith("../") ||
        path.isAbsolute(relative) ||
        !statSync(entry.file).isFile()
      )
        continue;
    } catch {
      continue;
    }
    if (seen.has(entry.file)) continue;
    if (modules.length >= 256 || remaining <= 0 || entry.depth > 8) {
      truncated = true;
      continue;
    }
    seen.add(entry.file);
    let source: string;
    try {
      source = readFileSync(entry.file, "utf8").slice(0, 16_000);
    } catch {
      continue;
    }
    const imports: string[] = [],
      unresolved: string[] = [];
    const specifiers = [
      ...source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]!);
    for (const specifier of new Set(specifiers)) {
      let resolved: string | undefined;
      if (specifier.startsWith(".")) {
        const base = path.resolve(path.dirname(entry.file), specifier);
        for (const file of [
          base,
          ...[
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mts",
            ".mjs",
            "/index.ts",
            "/index.js",
          ].map((ext) => base + ext),
        ]) {
          try {
            if (!statSync(file).isFile()) continue;
            const real = realpathSync(file);
            const relative = path.relative(root, real);
            if (
              relative.startsWith("../") ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes("node_modules")
            )
              continue;
            resolved = real;
            break;
          } catch {
            /* unresolved edge remains visible */
          }
        }
      }
      if (resolved) {
        imports.push(path.relative(root, resolved));
        queue.push({ file: resolved, depth: entry.depth + 1 });
      } else unresolved.push(specifier);
    }
    const excerpt =
      entry.depth === 0 ? "" : source.slice(0, Math.min(1600, remaining));
    remaining -= excerpt.length;
    modules.push({
      file: path.relative(root, entry.file),
      imports,
      unresolved,
      excerpt,
    });
  }
  return {
    modules,
    truncated,
    authority: "advisory-relative-imports",
    scopeLimit:
      "Literal relative imports only; unresolved aliases/packages remain unknown, not irrelevant.",
  };
}
