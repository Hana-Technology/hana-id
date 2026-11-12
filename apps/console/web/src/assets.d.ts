// Vite's `?raw` imports: a file's text, bundled into the script (the lockup reads the brand's wordmark outline so).
declare module '*.svg?raw' {
  const text: string;
  export default text;
}
