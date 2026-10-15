declare module 'cloudflare:workers' {
  export const env: { DB: import('../../examples/d1-token-store.js').D1Like }
}
