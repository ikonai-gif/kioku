// Ambient declarations for react-syntax-highlighter deep ESM imports.
// @types/react-syntax-highlighter only ships a root index.d.ts; the deep
// light/language/style subpaths are untyped. They are imported dynamically and
// consumed as `any` (see FileLightbox.tsx), so leaving them untyped is fine.
declare module "react-syntax-highlighter/dist/esm/light";
declare module "react-syntax-highlighter/dist/esm/light-async";
declare module "react-syntax-highlighter/dist/esm/languages/hljs/*";
declare module "react-syntax-highlighter/dist/esm/styles/hljs/*";
