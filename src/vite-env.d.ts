/// <reference types="vite/client" />

// WGSL shader imports with ?raw suffix
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}

// Regular WGSL imports
declare module '*.wgsl' {
  const content: string;
  export default content;
}
