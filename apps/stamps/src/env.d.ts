/// <reference types="vite/client" />

// Injected at build time (vite.config.ts; the e2e stack's build for its local env): the validated stamps configuration.
declare const __HANA_STAMPS_CONFIG__: import('./config.ts').StampsConfig;
