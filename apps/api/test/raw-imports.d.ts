// Vite's raw imports (a module's source as a string), for the platform routes' import allowlist (D927, F10).
declare module '*?raw' {
  const source: string;
  export default source;
}
