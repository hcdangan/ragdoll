/**
 * Test stub for the `server-only` guard.
 *
 * `server-only` works by resolving to a module that throws outside a React Server
 * Component graph. Node tests have no such graph, so Vitest aliases the package
 * here and server modules become importable without being rewritten.
 */
export {};
