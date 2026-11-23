// Vite's `?inline` CSS import: the processed stylesheet as a string (window/frame.ts).
declare module '*.css?inline' {
  const css: string;
  export default css;
}
