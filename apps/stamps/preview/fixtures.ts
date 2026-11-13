// Scripted PassportView fixtures for the preview harness (preview/main.ts) and the screenshots (preview/shots.ts).
// Fake accounts and times only; nothing here is read from a chain.
import type { PassportView, StampId, StampState } from '../src/ui/index.ts';

/** A fixed "now" so the screenshots don't change from run to run: 13 Nov 2026, 15:20 UTC. */
export const NOW = Date.UTC(2026, 10, 13, 15, 20, 0);
const MIN = 60_000;

const ME = '6e5e4e2b9f1c4d8a7b3e0f12c4a5d6e7f8091a2b3c4d5e6f708192a3b4f35000';
const OTHER = '9a1f00c3e4b5a6d7c8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5';
const EXPLORER = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
const TX = (n: number) => `https://testnet.nearblocks.io/txns/8Kq${n}vXf3pZ2s9TbLwYcR1mNa7dHe4uGj6oVkQx5iE`;
const SHARE = (id: string) => `https://hana-id-stamps-sandbox-dev.tingtc.workers.dev/p/${id}`;

const recentAll: PassportView['recent'] = [
  { accountId: 'c0ffee11223344556677889900aabbccddeeff00112233445566778899aabbcc', stamp: 'postcard', atMs: NOW - 2 * MIN, href: '/p/c0ffee11223344556677889900aabbccddeeff00112233445566778899aabbcc' },
  { accountId: 'alice.testnet', stamp: 'own_fare', atMs: NOW - 9 * MIN, href: '/p/alice.testnet' },
  { accountId: '1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9ab', stamp: 'signature', atMs: NOW - 26 * MIN, href: '/p/1b2c' },
  { accountId: OTHER, stamp: 'layover', atMs: NOW - 70 * MIN, href: `/p/${OTHER}` },
  { accountId: 'a-very-long-named-account-for-the-demo.testnet', stamp: 'sponsored', atMs: NOW - 3 * 60 * MIN, href: '/p/x' },
  { accountId: 'f00dbabe00112233445566778899aabbccddeeff00112233445566778899aabb', stamp: 'arrival', atMs: NOW - 26 * 60 * MIN, href: 'javascript:alert(1)' },
];

const lockedAfterArrival = (id: StampId): StampState => ({ id, status: 'locked', reason: 'Collect Arrival first' });

const day = (h: number, m: number) => Date.UTC(2026, 10, 13, h, m, 0);

export const HOSTILE_NOTE =
  '<img src=x onerror=alert(1)> \u202Egnirts desrever\u202C zero\u200Bwidth \u2066isolate\u2069 & "quotes" \u2014 greetings from Kuala Lumpur \u{1F469}\u200D\u{1F4BB}!';

export interface Fixture {
  name: string;
  label: string;
  view: PassportView;
}

export const FIXTURES: Fixture[] = [
  {
    name: 'cover',
    label: 'Cover (signed out)',
    view: { mode: 'cover', stamps: [], recent: recentAll, totals: { passports: 214, stamps: 803 } },
  },
  {
    name: 'fresh',
    label: 'Fresh passport: Arrival only',
    view: {
      mode: 'mine',
      accountId: ME,
      explorerUrl: EXPLORER(ME),
      shareUrl: SHARE(ME),
      balanceNear: '0',
      stamps: [
        { id: 'arrival', status: 'available' },
        lockedAfterArrival('sponsored'),
        lockedAfterArrival('own_fare'),
        lockedAfterArrival('signature'),
        lockedAfterArrival('postcard'),
        lockedAfterArrival('layover'),
      ],
      recent: recentAll,
      totals: { passports: 214, stamps: 803 },
    },
  },
  {
    name: 'midway',
    label: 'Mid-way: working, failed, countdown',
    view: {
      mode: 'mine',
      accountId: ME,
      explorerUrl: EXPLORER(ME),
      shareUrl: SHARE(ME),
      balanceNear: '0',
      stamps: [
        { id: 'arrival', status: 'collected', atMs: day(15, 12), sponsored: true, txUrl: TX(1) },
        { id: 'sponsored', status: 'collected', atMs: day(15, 14), sponsored: true, txUrl: TX(2) },
        { id: 'own_fare', status: 'failed', message: 'Your account has no NEAR for the fee. Get testnet NEAR from a faucet, then try again.' },
        { id: 'signature', status: 'working', stage: 'Waiting for your approval…' },
        { id: 'postcard', status: 'available' },
        { id: 'layover', status: 'locked', reason: 'In 1 min 40 s' },
      ],
      recent: recentAll,
      totals: { passports: 214, stamps: 805 },
    },
  },
  {
    name: 'complete',
    label: 'All six, hostile note',
    view: {
      mode: 'mine',
      accountId: ME,
      explorerUrl: EXPLORER(ME),
      shareUrl: SHARE(ME),
      balanceNear: '4.98',
      stamps: [
        { id: 'arrival', status: 'collected', atMs: day(15, 12), sponsored: true, txUrl: TX(1) },
        { id: 'sponsored', status: 'collected', atMs: day(15, 14), sponsored: true, txUrl: TX(2) },
        { id: 'own_fare', status: 'collected', atMs: day(15, 16), sponsored: false, txUrl: TX(3) },
        { id: 'signature', status: 'collected', atMs: day(15, 17), sponsored: true, txUrl: TX(4) },
        { id: 'postcard', status: 'collected', atMs: day(15, 18), sponsored: true, note: HOSTILE_NOTE, txUrl: 'javascript:alert(1)' },
        { id: 'layover', status: 'collected', atMs: day(15, 19), sponsored: true, txUrl: TX(6), fresh: true },
      ],
      recent: recentAll,
      totals: { passports: 214, stamps: 809 },
    },
  },
  {
    name: 'public',
    label: 'Public passport',
    view: {
      mode: 'public',
      accountId: OTHER,
      explorerUrl: EXPLORER(OTHER),
      stamps: [
        { id: 'arrival', status: 'collected', atMs: Date.UTC(2026, 10, 12, 9, 3), sponsored: true },
        { id: 'sponsored', status: 'collected', atMs: Date.UTC(2026, 10, 12, 9, 5), sponsored: true },
        { id: 'own_fare', status: 'locked', reason: 'Not collected yet' },
        { id: 'signature', status: 'collected', atMs: Date.UTC(2026, 10, 12, 9, 9), sponsored: true },
        { id: 'postcard', status: 'collected', atMs: Date.UTC(2026, 10, 12, 9, 11), sponsored: true, note: 'gm from the NEAR hackathon. See you at the next stop.' },
        { id: 'layover', status: 'locked', reason: 'Not collected yet' },
      ],
      recent: recentAll,
      totals: { passports: 214, stamps: 809 },
    },
  },
  {
    name: 'empty-recent',
    label: 'Nobody yet: empty recent list',
    view: {
      mode: 'mine',
      accountId: ME,
      explorerUrl: EXPLORER(ME),
      shareUrl: SHARE(ME),
      balanceNear: '0',
      stamps: [
        { id: 'arrival', status: 'working', stage: 'Sending…' },
        lockedAfterArrival('sponsored'),
        lockedAfterArrival('own_fare'),
        lockedAfterArrival('signature'),
        lockedAfterArrival('postcard'),
        lockedAfterArrival('layover'),
      ],
      recent: [],
      totals: { passports: 0, stamps: 0 },
      busy: true,
    },
  },
  {
    name: 'error',
    label: 'Error notice',
    view: {
      mode: 'mine',
      accountId: ME,
      explorerUrl: EXPLORER(ME),
      shareUrl: SHARE(ME),
      balanceNear: '0',
      notice: {
        kind: 'error',
        text: 'Sent, but the relay timed out before it confirmed. It may still land: check the transaction, then refresh.',
        href: TX(9),
        hrefLabel: 'View the transaction ↗',
      },
      stamps: [
        { id: 'arrival', status: 'collected', atMs: day(15, 12), sponsored: true, txUrl: TX(1) },
        { id: 'sponsored', status: 'failed', message: 'The relay is busy. Try again in a minute.' },
        { id: 'own_fare', status: 'available' },
        { id: 'signature', status: 'available' },
        { id: 'postcard', status: 'failed', message: 'Write 1 to 140 characters.' },
        { id: 'layover', status: 'locked', reason: 'In 0 min 12 s' },
      ],
      recent: recentAll.slice(0, 3),
      totals: { passports: 214, stamps: 805 },
    },
  },
];
