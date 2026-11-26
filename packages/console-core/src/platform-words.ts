// The platform API's routes in plain words for the screens (D930): the console's Platform activity and the admin
// portal's. Its own module, with no schema, so the console's SPA bundles only this (as audit-words.ts).
/** A route template in plain words for the screens (the template itself stays beside it for support). */
export const PLATFORM_ROUTE_WORDS: Readonly<Record<string, string>> = {
  'GET /v1/platform/credential': 'Read its own key',
  'POST /v1/platform/credential/revoke': 'Stop its own key',
  'POST /v1/platform/apps': 'Create an app',
  'GET /v1/platform/apps': 'List apps',
  'GET /v1/platform/apps/:appId': 'Read an app',
  'POST /v1/platform/apps/:appId/origins': 'Ask for web addresses',
  'POST /v1/platform/apps/:appId/origins/remove': 'Remove web addresses',
  'POST /v1/platform/changes/:changeId/cancel': 'Cancel a waiting web address',
  'POST /v1/platform/apps/:appId/suspend': 'Suspend or resume an app',
  'POST /v1/platform/apps/:appId/keys': 'Create a publishable key',
  'POST /v1/platform/apps/:appId/keys/:keyId/revoke': 'Revoke a publishable key',
};

/** What a call did, in plain words; a route this build doesn't know reads as its template. */
export const platformRouteWords = (method: string, route: string): string => PLATFORM_ROUTE_WORDS[`${method} ${route}`] ?? `${method} ${route}`;
