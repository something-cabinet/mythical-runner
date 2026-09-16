/**
 * `structuredClone` is a global in every runtime this engine targets — Node 17+, all
 * modern browsers, and the Workers runtime — but it is not declared by the `ES2022` lib.
 *
 * Declaring it here rather than pulling in `@types/node` or the `DOM` lib keeps the
 * engine's dependency surface at zero and stops browser-only globals leaking into a
 * package that must also run inside a Durable Object.
 */
declare function structuredClone<T>(value: T): T;

/**
 * Minimal `process` surface, used only by the dev harness in `src/dev/`.
 *
 * Declared by hand rather than depending on `@types/node` so the engine's runtime
 * dependency count stays at zero. Nothing outside `src/dev/` may use it — the engine
 * proper must run unchanged inside a Durable Object, where `process` does not exist.
 */
declare const process: {
  readonly argv: string[];
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

