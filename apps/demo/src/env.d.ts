/// <reference types="vite/client" />

// Injected at build time (vite.config.ts; the e2e stack's build for its local env): the validated demo configuration.
declare const __HANA_DEMO_CONFIG__: import('./config.ts').DemoConfig;
