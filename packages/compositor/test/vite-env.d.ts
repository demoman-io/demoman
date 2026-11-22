// A `?url` import is a Vite transform, and its type ships in `vite/client`,
// which this package cannot resolve (see packages/resolver/test/vite-env.d.ts).
declare module "*?url" {
  const url: string;
  export default url;
}
