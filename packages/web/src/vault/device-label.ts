// The device label the vault sends with a new share (D98 item 10, D512): how Hana Home names a signed-in device, e.g.
// "Chrome on macOS". Only the browser's family and the system's family, from the User-Agent string every page already
// sends: never a version, a device model, a language, a screen size or anything else that would narrow it down. A browser
// it doesn't recognise is "Browser", a system it doesn't recognise leaves the "on …" out, and with neither it sends no
// label at all. The API keeps it with the share and deletes it with the share.

/** Browser families, the first match wins: a browser built on another names that one too (Edge says "Chrome", Chrome says "Safari"). */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//u, 'Edge'],
  [/\b(?:OPR|Opera)\//u, 'Opera'],
  [/\bSamsungBrowser\//u, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//u, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//u, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//u, 'Safari'],
];

/** System families, the first match wins (Android's User-Agent also says "Linux", an iPad's may say "Macintosh"). */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:iPhone|iPad|iPod)\b/u, 'iOS'],
  [/\bAndroid\b/u, 'Android'],
  [/\bCrOS\b/u, 'ChromeOS'],
  [/\bWindows\b/u, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/u, 'macOS'],
  [/\bLinux\b/u, 'Linux'],
];

const first = (ua: string, list: readonly (readonly [RegExp, string])[]): string | null => list.find(([re]) => re.test(ua))?.[1] ?? null;

/** "{browser} on {system}", "{browser}", "Browser on {system}", or null when the User-Agent says neither. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== 'string' || userAgent.length === 0 || userAgent.length > 1024) return null;
  const browser = first(userAgent, BROWSERS);
  const system = first(userAgent, SYSTEMS);
  if (!browser && !system) return null;
  return system ? `${browser ?? 'Browser'} on ${system}` : (browser as string);
}
