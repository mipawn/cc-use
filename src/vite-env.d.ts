/// <reference types="vite/client" />

declare module '*.svg?url' {
  const src: string
  export default src
}

declare module '*.png?url' {
  const src: string
  export default src
}
