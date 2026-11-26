# Journear Passport for networks: the platform API guide

This guide is for the backend developers of a **network**: a company that offers Journear Passport sign-in to its
own partners, switched on from the network's own partner portal. When a partner turns the switch on, your server
creates and manages a Journear Passport app for that partner, with no person at Journear involved. The first reader
is Sodax's backend team. Everything your backend needs is in this guide; the integration guide (`integration.md`,
sent with our SDK) covers the partner's page and our SDK.

Last verified: 2026-11-26, against the platform API's code and tests (built, not deployed anywhere yet); 2026-11-26
again for the off switches' limits (section 8: the removal limit's per-organisation floor, suspensions and key
revocations outside it with limits of their own, each key's reserve for off switches; after review, key revocations
limited apart from suspensions, and the database reserve's rate).

> **Not available yet.** The platform API is built and tested, but it is **not deployed** in any environment and
> **not switched on** for any organisation. Journear switches it on per organisation. The API's address and the
> values you sign with come from Journear for each environment: keep them in configuration, never in code, and
> don't treat any address in this guide as final. Marking a wallet as shared (below) is for **test apps only** for
> now: everything here is testnet, `pk_test_…` keys, no real money.

## Contents

1. [What the platform does, and what it doesn't](#1-what-the-platform-does-and-what-it-doesnt)
2. [What Journear sets up first](#2-what-journear-sets-up-first)
3. [Your platform key](#3-your-platform-key)
4. [Signing a request](#4-signing-a-request)
5. [The endpoints](#5-the-endpoints)
6. [Retries, idempotency and versions](#6-retries-idempotency-and-versions)
7. [What a partner experiences](#7-what-a-partner-experiences)
8. [Limits, refusals and the off switches](#8-limits-refusals-and-the-off-switches)
9. [User IDs and Support IDs](#9-user-ids-and-support-ids)
10. [The front end: the partner's site and your SDK](#10-the-front-end-the-partners-site-and-your-sdk)
11. [Running it in production](#11-running-it-in-production)
12. [Recipe: the toggle on and off](#12-recipe-the-toggle-on-and-off)
13. [Troubleshooting by error code](#13-troubleshooting-by-error-code)
14. [Questions we have for you](#14-questions-we-have-for-you)

## 1. What the platform does, and what it doesn't

**Words used in this guide.**

| Word | Meaning |
|---|---|
| Organisation | Your company's account at Journear. Your people sign in to Journear's **partner portal** with Google as its members: **owners** (who can change things) or viewers |
| Scope, or wallet settings | The settings that decide which wallet a person gets. Every app on one scope gives one person **the same wallet** (the same addresses) |
| Shared wallet | A scope Journear has marked so that many partners' apps share it: one wallet per person across all your partners. Each app on it gets its own User IDs ([section 9](#9-user-ids-and-support-ids)) |
| App | One partner's integration: a name, its allowed web addresses and its publishable keys. You create one app per partner |
| Web address | An *origin*: scheme, host and port, no path, for example `https://swap.partner.example`. A partner's page works only on the app's web addresses that are in force |
| Publishable key | `pk_test_…`: the public key the partner's page (or your SDK) gives our SDK. It is not a secret; the web addresses protect it |
| Platform key | Your backend's request-signing key pair (ECDSA P-256). Journear holds only its public half. Every request you send is signed with it |
| Security contacts | Email addresses Journear sets for your organisation. They get every notice about new web addresses and keys |
| On-chain owner | An owner whose Google account is also written as an owner of the scope on chain. Only on-chain owners can register keys and confirm web addresses |

**What your platform key can do**, only on apps your organisation's platform keys created, on the scopes this key was
registered for (so a key you rotate to sees and manages the apps the old one made, as long as it names the same
scopes; rotating never leaves apps behind):

- create a test app for a partner on your shared wallet, with its first web addresses;
- list and read those apps: name, state, web addresses (and whether each is waiting or working), publishable keys;
- ask for more web addresses (each one waits, [section 7](#7-what-a-partner-experiences)), cancel one still waiting,
  and remove any at once;
- suspend an app at once, and resume a suspension it set itself;
- create and revoke publishable keys;
- read its own state, and stop itself at once.

**What it can never do:** confirm or speed up a web address (only an owner of your organisation can, in the portal);
register, accept or confirm a platform key; touch owners, Google sign-in settings or anything on chain; auto-approve
policies, raw signing, gas sponsorship, partner labels, logos, renames or the real-money demo; delete an app; create
a live app; see or change an app no platform key of yours created, such as your own site's app or any app Journear
staff made. To
your key, an app outside its reach looks exactly like an app that doesn't exist (`404 not_found`).

**What stays with people.** Your **owners**, in the partner portal: register your platform keys and confirm them,
confirm each new web address (or let it wait 24 hours), stop a key, suspend any app, see every call your backend
made. **Journear staff**: switch the platform on or off for your organisation, mark a scope as a shared wallet, raise
your limits, suspend any app or stop any key at once, delete apps.

## 2. What Journear sets up first

Before your backend can call anything, Journear sets up:

1. **Your organisation**, with its owners (Google accounts) and at least one security contact.
2. **A test scope marked as a shared wallet**, owned by your organisation, with your owners as its on-chain owners.
   Journear marks it once, for good. Only apps created after the mark get their own User IDs.
3. **The platform switch** for your organisation, once your first key is registered and you are ready to test.

Journear also gives you, for each environment, three values your code needs:

| Value | What it is | Where it goes |
|---|---|---|
| API base URL | Where you send requests, `{API}/v1/platform/…` | Your configuration |
| Env name | The environment's name: line 2 of every signed message | Your configuration |
| Signer account | The environment's contract account: line 3 of every signed message | Your configuration |

For `sandbox-dev`, the test environment partners use today, these would be
`https://hana-id-api-sandbox-dev.tingtc.workers.dev`, `sandbox-dev` and `hana-id-signer-dev1.testnet`. The platform
API is not deployed there yet: Journear confirms the values when it is, and the API's address changes to a stable
Journear address before any partner goes live. Because the env name and account are inside every signature, a
request signed for one environment never works in another.

## 3. Your platform key

### Make the key pair (on your server)

The private key never leaves your backend. Never paste it into the partner portal, a chat, a ticket or a browser,
and never send it to Journear: Journear never asks for it. Make it where it will be used.

**With OpenSSL** (a file on the server, readable by the backend's user only):

```sh
umask 077
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out journear-platform-key.pem
openssl pkey -in journear-platform-key.pem -pubout -out journear-platform-key.pub.pem
openssl pkey -pubin -in journear-platform-key.pub.pem -noout -text | grep 'NIST CURVE'   # NIST CURVE: P-256
```

`journear-platform-key.pem` is the private key (PKCS #8, a `BEGIN PRIVATE KEY` block): keep it in your secret store.
`journear-platform-key.pub.pem` (a `BEGIN PUBLIC KEY` block) is the only part anyone else sees.

**With a cloud key service (KMS or HSM)**: create an "ECC NIST P-256" signing key (AWS KMS `ECC_NIST_P256`, Google
Cloud KMS `EC_SIGN_P256_SHA256`, Azure Key Vault `P-256`), export its public key as PEM, and sign through the
service ([Using a KMS](#using-a-kms)). The private key then never exists outside the service. We haven't tested
these services ourselves.

**Use a different key pair in each environment.**

**The fingerprint.** The portal and every email name a key by its fingerprint (the RFC 7638 thumbprint). To check
that the key in the portal is yours, compute it from your public key (Node 20 or later):

```sh
node -e 'const c=require("node:crypto");const j=c.createPublicKey(require("node:fs").readFileSync(process.argv[1])).export({format:"jwk"});console.log(c.createHash("sha256").update(`{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`).digest("base64url"))' journear-platform-key.pub.pem
```

### Register it in the partner portal

Who: an owner of your organisation who is also an on-chain owner of each scope the key is for.

1. Sign in to the partner portal and open **Platform keys**.
2. Under **Register a key**: a **Label** your security contacts will recognise (up to 40 characters, for example
   "Production backend"), the **wallet settings** it is for (one or two of your test scopes), and the **Public key**:
   paste the contents of `journear-platform-key.pub.pem` (a PEM `PUBLIC KEY` block; a JWK also works). The portal
   refuses anything that looks like a private key.
3. **Review and confirm with Google**: a fresh Google sign-in proves it is you.
4. The key is now **waiting**. Within about 5 minutes Journear emails your security contacts, every owner and
   Journear's security team: "New platform key registered", with the fingerprint, who registered it, a **Review the
   key in the partner portal** link and a **Cancel this key** link.
5. **It starts working when an owner confirms it**, or by itself 24 hours after that email. To confirm: open the key
   in **Platform keys** (or the email's link), check the fingerprint, and confirm with a fresh Google sign-in.
   - On a **test setup** (every environment today) any owner who is an on-chain owner of its scopes may confirm,
     including the one who registered it. So in practice: register, wait for the email, confirm.
   - On a **real-money setup** (later) the person who confirms must be **a different owner** from the one who
     registered it, and must have been an owner since before the registration. An organisation with one owner
     waits the 24 hours.
6. Once it works, it starts authenticating within about 30 seconds. Check it with `GET /v1/platform/credential`
   ([section 5](#the-credential)).

Journear staff can also register a key you send them (the public key only, after checking its fingerprint with you
by another channel). Such a key works only after one of two things. An owner **accepts** it in the portal with a
fresh sign-in: that also counts as its confirmation, so it works as soon as its email has gone out. Or a second
Journear staff member approves it: then it is announced and waits the full 24 hours after its email, unless an owner
confirms it.

A registration is refused when: your organisation already has 2 keys working, waiting or awaiting acceptance; your
security contacts changed less than 7 days ago; Journear has frozen your organisation; the public key is already
registered anywhere (make a new pair for each key); the key's private half is published (the test vector's key in
[section 4](#a-test-vector) is refused outside Journear's local test setups); or the label is not one plain line of 1
to 40 characters (it can't name Journear or look like a web address).

### Rotate: keep a standby key

A key works for **1 year** from the day it came into force. Journear emails your security contacts and owners 30
days and 7 days before it ends. Your organisation may have **at most 2 keys** working, waiting or awaiting
acceptance, so that one can replace the other:

1. Register a second key now and confirm it, so it is in force as a **standby**.
2. To rotate (on schedule or in a hurry): switch your backend to the standby, then stop the old key. No wait at all.
3. Register the next standby.

On a real-money setup a new key waits 24 hours unless a second owner confirms it, which is why the standby matters
there. During a switch, don't retry a write with the other key: see [section 6](#6-retries-idempotency-and-versions).

### Stop a key at once

Any of these stops a key immediately and for good (it never comes back; register a new one):

- **Your backend**, with the key itself: `POST /v1/platform/credential/revoke`. This works even while the platform is
  switched off for your organisation or your organisation is frozen. If a stop answers `401`, the key is already
  stopped (an earlier attempt landed, or someone else stopped it).
- **An owner**, in the partner portal: **Platform keys**, **Stop** (no fresh sign-in needed).
- **The email link** in "Platform key confirmed" (valid 7 days).
- **Journear staff**, from Journear's admin portal.

Stopping a key also **cancels every web address it asked for that is still waiting**. Web addresses already working
stay; remove them if they shouldn't. Everyone is emailed "Platform key stopped", listing what was cancelled.

## 4. Signing a request

Every request is signed with your platform key over its environment, method, path, body, time and a single-use
random value. There is no bearer token and no shared secret: a logged or captured request can't be changed, and
can't be used again once it has been answered (the one exception is under "The nonce" below).

### The request

- **Methods:** `GET` and `POST` only (anything else: `405`).
- **A `POST`** has `content-type: application/json` (optionally `; charset=utf-8`), a body of at most **16 KiB** of
  UTF-8 JSON that is an object (send `{}` when there is nothing to say), no `content-encoding`, and no query.
- **A `GET`** has no body, no content type and no `Idempotency-Key`.
- **The path** is `/v1/platform/` followed by plain segments of letters, digits, `_` and `-`: no empty segment, no
  `.` or `..`, no percent-encoding, no trailing slash.
- **A `GET`'s query**, when there is one, is one to four `name=value` pairs joined by `&`: each name a lower-case
  letter followed by up to 31 letters (`[a-z][A-Za-z]{0,31}`), each value 1 to 128 letters, digits, `_` and `-`
  (`[A-Za-z0-9_-]{1,128}`), for example `?scopeId=s1abc&cursor=app_9xYz`.
- **No `Origin` header**: the platform API is for servers only. A request with one is refused (`403
  browser_refused`), and no answer carries CORS headers.

### The headers

| Header | Value | Exact form |
|---|---|---|
| `Journear-Key-Id` | Your platform key's id, shown in the portal | `pkc_` and 12 to 17 base58 characters |
| `Journear-Timestamp` | Your clock now, in unix **milliseconds** | 13 digits |
| `Journear-Nonce` | Exactly 16 fresh random bytes, base64url without padding: a new one for **every** request and every retry | 22 characters, `^[A-Za-z0-9_-]{21}[AQgw]$` |
| `Journear-Signature` | The signature: 64 bytes `r ‖ s`, base64url without padding | 86 characters |
| `Idempotency-Key` | Writes only: one per operation, resent unchanged on its retries ([section 6](#6-retries-idempotency-and-versions)) | 8 to 64 letters, digits, `_` and `-` |
| `content-type` | `application/json` on a `POST` | |

Each value is matched in full: nothing is trimmed. All headers together must stay under 16 KiB.

**The clock.** `Journear-Timestamp` must be within **±60 seconds** of Journear's clock. Otherwise the answer is
`400 stale_request` with `serverTimeMs`, Journear's time: fix your server's clock (NTP).

**The nonce.** Journear keeps each nonce until your timestamp plus 120 seconds. Sending the same nonce twice
answers `409 request_replayed`. Journear reserves the nonce after it has checked the signature and that the platform
is on and your organisation isn't frozen. So a request answered `403 platform_off`, `403 forbidden` (frozen) or a
`503` from the nonce check itself holds no nonce: that same request could be sent again, unchanged, while its
timestamp is within the clock window. Every later answer (any `429` included) has used the nonce. Either way, sign
every retry again, with a new nonce and timestamp.

### The signed message

Ten lines joined by a line feed (`\n`, 0x0A), encoded as UTF-8, with **no** line feed at the end:

```
journear-platform-v1
<env name>                the environment's name, from Journear
<signer account>          the environment's contract account, from Journear
<method>                  GET or POST
<path and query>          exactly as sent, for example /v1/platform/apps?scopeId=s1abc
<Journear-Key-Id>
<Journear-Timestamp>
<Journear-Nonce>
<Idempotency-Key>         or an empty line when there is none
<body hash>               SHA-256 of the exact body bytes you send, lowercase hex
```

The body hash is over the very bytes you send: serialise the JSON once and send those bytes. For a `GET` (no body)
it is the hash of nothing, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### The signature

**ES256**: ECDSA on the P-256 curve with SHA-256, over the message bytes. The signer hashes the message once
(WebCrypto's `sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message)` does). A KMS that signs a digest is given
SHA-256 of the message instead.

**On the wire: raw `r ‖ s`, never DER.** The header carries exactly 64 bytes: `r` then `s`, each 32 bytes
big-endian, left-padded with zeros, then base64url without padding. WebCrypto already gives this form. Many KMS
services and libraries answer **DER** instead (`SEQUENCE { INTEGER r, INTEGER s }`, about 70 bytes and starting
`0x30`, its length varying with the values): convert it (`derToRaw` in the reference client: read both integers, drop a leading `0x00`, left-pad each to
32 bytes). A DER signature sent as it is doesn't fit the header's form and is refused with the same `401` as any
other failure. Both `s` values are accepted (low and high).

**Every authentication failure is the same answer**: `401` with code `unauthenticated` and the message "This
request isn’t signed by a platform key in force here. Check the key id, the clock, the signed message and the key."
It doesn't say which part failed: an unknown, waiting, stopped or expired key, a bad signature, a request signed for
another environment, or a missing or malformed `Journear-*` header. Check in this order: the key id and its state in
the portal, the env name and signer account, the exact path and query, the body bytes, the signature's form.

### A test vector

Check your signer against this example before you try the real API. It is **public test material**: its private key
is the 32 bytes of SHA-256 over the UTF-8 text `journear platform request vectors: test key 1` (read as a big-endian
number, it is already below the curve's order). Journear refuses to register this key outside its own local test
setups, so it can never be used for real.

| | |
|---|---|
| Public key (JWK) | `{"kty":"EC","crv":"P-256","x":"ueowcpD9Nj-M1kx84EQdShLN5FNLOZGq_BV2Mag8554","y":"2VAmr271NMsFT1bwCVSOVltiZojmM2vFVc1H8RIJWaM"}` |
| Fingerprint | `mBMTrRfEY-gb-MFa4zaRAQqG1zZ4kbkKiLo_qps_BTo` |
| Key id | `pkc_7Hq2Vx9Lm4Rt8Kd` |
| Env name, signer account | `sandbox-test`, `signer.test.near` (names used only for this vector, not a real environment) |
| Request | `POST /v1/platform/credential/revoke`, body `{}` (2 bytes), `Idempotency-Key: op-2026-11-25-0001` |
| Timestamp, nonce | `1800000000000`, `KI-DKBwJhE9EIP1K-7zt4A` |
| Body hash | `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` |

The message (ten lines):

```
journear-platform-v1
sandbox-test
signer.test.near
POST
/v1/platform/credential/revoke
pkc_7Hq2Vx9Lm4Rt8Kd
1800000000000
KI-DKBwJhE9EIP1K-7zt4A
op-2026-11-25-0001
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
```

One valid signature of it (ECDSA signatures are random, so yours will differ; check that yours verifies with the
public key above, and that this one does too):

- `Journear-Signature`: `ao56vUEzMzIHORmNHAlgMYTYlW2HQqtyc1V2ljCc2kpq0hIWLjFs_AcUPgep40wL4Yqb6_OCIlABPMsNKTb03A`
- the same signature as DER (what a KMS might give you; converting it must give the header above):
  `304402206a8e7abd413333320739198d1c09603184d8956d8742ab7273557696309cda4a02206ad212162e316cfc07143e07a9e34c0be18a9bebf3822250013ccb0d2936f4dc`

Sent as DER, or signed with any other env name or signer account, the same request is refused with `401`.

### The reference client (TypeScript)

TypeScript, an ES module, no dependencies. It needs WebCrypto, `fetch` and `AbortSignal.timeout`: Node 22.18 or
later runs the file as it is (Node's built-in type stripping; we ran it on Node 24), and Node 20 runs it through a
TypeScript build step (tsc, tsx or your bundler). Journear's tests run this exact code against the API's own request
checks and routes (a key from a PEM file, every endpoint, a retry after a lost answer, a timeout, the self-revoke
while switched off, and the vector above), so it stays in step with the API. Copy it into your backend as
`platform-client.ts`.

<a id="reference-client"></a>

```ts
// Journear Passport platform API: sign and send requests from your backend. Public sample code: copy it.
// TypeScript, an ES module, no dependencies. It needs WebCrypto, fetch and AbortSignal.timeout: Node 22.18 or later runs
// it as it is (`node`'s built-in type stripping), Node 20 through a TypeScript build step (tsc, tsx or your bundler);
// other server runtimes with those APIs work too.

/** A WebCrypto private key (the DOM's and Node's types both name it this way). */
export type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** What your backend needs for one environment. Keep these in your configuration, never in code. */
export interface PlatformConfig {
  /** The env's API base URL, as Journear gives it (`https://…`; a trailing slash is dropped). */
  apiBase: string;
  /** The env's name and contract account: lines 2 and 3 of every signed message (Journear gives both). */
  envName: string;
  signerAccount: string;
  /** Your platform key's id (`pkc_…`), shown in the partner portal once the key is registered. */
  keyId: string;
  /** Your private key, imported once at start-up (importPrivateKeyPem). Never log it. */
  privateKey: SigningKey;
  /** Optional: another fetch (a proxy, a test) and another clock (unix milliseconds). */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PlatformRequest {
  method: 'GET' | 'POST';
  /** The path and, for a GET, its query, exactly as sent: `/v1/platform/apps?scopeId=…`. */
  path: string;
  /** A POST's JSON body (`{}` when there is nothing to send). Serialised once, so every retry sends the same bytes. */
  body?: Record<string, unknown>;
  /** Every write: one key per operation, stored with it, resent unchanged on every retry. */
  idempotencyKey?: string;
}

export interface PlatformAnswer {
  status: number;
  /** Success: the answer's fields. Failure: `{ error, code, requestId, … }`. Match on `code`, never on `error`. */
  body: Record<string, unknown>;
  /** The API's request id for this answer: log it; Journear support asks for it. */
  requestId: string | null;
}

const PATH_RE = /^\/v1\/platform(\/[A-Za-z0-9_-]+)+(\?[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}(&[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}){0,3})?$/;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // slice(): a copy on its own ArrayBuffer, as WebCrypto's TypeScript types want.
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())));
}

/** A fresh Idempotency-Key for a new operation (22 characters). Store it with the operation before the first send. */
export function newIdempotencyKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Imports a PKCS #8 PEM private key (`openssl genpkey` writes one) for signing only; the key can't be exported again. */
export async function importPrivateKeyPem(pem: string): Promise<SigningKey> {
  const m = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error('Expected a PKCS #8 PEM private key');
  const der = Uint8Array.from(atob(m[1]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The signed message: ten lines joined by "\n", no trailing newline. */
export function platformMessage(p: {
  envName: string;
  signerAccount: string;
  method: string;
  path: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  idempotencyKey: string;
  bodySha256Hex: string;
}): string {
  const lines = ['journear-platform-v1', p.envName, p.signerAccount, p.method, p.path, p.keyId, p.timestamp, p.nonce, p.idempotencyKey, p.bodySha256Hex];
  if (lines.some((l) => /[\r\n]/.test(l))) throw new Error('A line of the signed message holds a line break');
  return lines.join('\n');
}

/**
 * A KMS's DER signature (SEQUENCE { INTEGER r, INTEGER s }) as the 64 bytes r ‖ s the API wants. WebCrypto already
 * gives r ‖ s; use this only for a KMS or library that answers DER.
 */
export function derToRaw(der: Uint8Array): Uint8Array {
  const fail = (): never => {
    throw new Error('Not a DER ECDSA P-256 signature');
  };
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) fail();
  let at = 2;
  const int = (): Uint8Array => {
    if (der[at] !== 0x02) fail();
    const len = der[at + 1]!;
    if (len < 1 || len > 33 || at + 2 + len > der.length) fail();
    let v = der.subarray(at + 2, at + 2 + len);
    at += 2 + len;
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > 32) fail();
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(int(), 0);
  raw.set(int(), 32);
  if (at !== der.length) fail();
  return raw;
}

/** The headers for one attempt: a fresh nonce and timestamp each time (or the given ones, for test vectors). */
export async function signHeaders(
  cfg: Pick<PlatformConfig, 'envName' | 'signerAccount' | 'keyId' | 'privateKey'>,
  r: { method: 'GET' | 'POST'; path: string; body: Uint8Array; idempotencyKey?: string | undefined; timestampMs: number; nonce?: string },
): Promise<Record<string, string>> {
  if (!PATH_RE.test(r.path)) throw new Error(`Not a platform path: ${r.path}`);
  if (r.method === 'GET' && (r.body.length > 0 || r.idempotencyKey !== undefined)) throw new Error('A GET has no body and no Idempotency-Key');
  if (r.method === 'POST' && r.path.includes('?')) throw new Error('A POST takes no query');
  const timestamp = String(r.timestampMs);
  const nonce = r.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const message = platformMessage({
    envName: cfg.envName,
    signerAccount: cfg.signerAccount,
    method: r.method,
    path: r.path,
    keyId: cfg.keyId,
    timestamp,
    nonce,
    idempotencyKey: r.idempotencyKey ?? '',
    bodySha256Hex: await sha256Hex(r.body),
  });
  // WebCrypto's ECDSA hashes the message with SHA-256 itself and answers r ‖ s (64 bytes): what the API wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cfg.privateKey, enc.encode(message)));
  const headers: Record<string, string> = {
    'Journear-Key-Id': cfg.keyId,
    'Journear-Timestamp': timestamp,
    'Journear-Nonce': nonce,
    'Journear-Signature': b64url(sig),
  };
  if (r.idempotencyKey !== undefined) headers['Idempotency-Key'] = r.idempotencyKey;
  if (r.method === 'POST') headers['content-type'] = 'application/json';
  return headers;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one request, re-signed for every attempt (a new nonce and timestamp; the same body and Idempotency-Key).
 * Each attempt has `timeoutMs` (default 15 s) for the whole exchange, the answer's body included. Retries a network
 * error or a timeout, 500 and 503 with backoff, and 429 after its retry-after (up to `maxWaitS`); `attempts` (default
 * 4) counts the first one. Every other answer comes back as it is: read `body.code`.
 */
export async function callPlatform(
  cfg: PlatformConfig,
  req: PlatformRequest,
  o: { attempts?: number; maxWaitS?: number; timeoutMs?: number } = {},
): Promise<PlatformAnswer> {
  const attempts = o.attempts ?? 4;
  const maxWaitS = o.maxWaitS ?? 60;
  const timeoutMs = o.timeoutMs ?? 15_000;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts is a whole number, 1 or more');
  if (!Number.isFinite(maxWaitS) || maxWaitS < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('maxWaitS and timeoutMs are positive numbers');
  const apiBase = cfg.apiBase.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(apiBase)) throw new Error(`Not an API base URL: ${cfg.apiBase}`);
  const body = req.method === 'POST' ? enc.encode(JSON.stringify(req.body ?? {})) : new Uint8Array(0);
  if (req.method === 'POST' && req.idempotencyKey === undefined && req.path !== '/v1/platform/credential/revoke') throw new Error('Every write needs an Idempotency-Key');
  const doFetch = cfg.fetch ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const headers = await signHeaders(cfg, { method: req.method, path: req.path, body, idempotencyKey: req.idempotencyKey, timestampMs: (cfg.now ?? Date.now)() });
    let res: Response;
    let text: string;
    try {
      // The signal ends the attempt on time, the body's read included; a timeout is retried as a network error.
      const signal = AbortSignal.timeout(timeoutMs);
      res = await doFetch(`${apiBase}${req.path}`, { method: req.method, headers, signal, ...(req.method === 'POST' ? { body } : {}) });
      text = await res.text();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { code: 'not_json', error: text.slice(0, 200) };
    }
    const answer: PlatformAnswer = { status: res.status, body: parsed, requestId: res.headers.get('x-request-id') };
    const retryAfter = Number(res.headers.get('retry-after') ?? '');
    const retryable = res.status === 500 || res.status === 503 || (res.status === 429 && retryAfter > 0 && retryAfter <= maxWaitS);
    if (!retryable || attempt >= attempts) return answer;
    await sleep(res.status === 429 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1));
  }
}
```

Using it (the private key read once from your secret store; here a file):

```ts
import { readFileSync } from 'node:fs';
import { callPlatform, importPrivateKeyPem, newIdempotencyKey, type PlatformConfig } from './platform-client.ts';

const cfg: PlatformConfig = {
  apiBase: process.env.JOURNEAR_API_BASE!,
  envName: process.env.JOURNEAR_ENV_NAME!,
  signerAccount: process.env.JOURNEAR_SIGNER_ACCOUNT!,
  keyId: process.env.JOURNEAR_PLATFORM_KEY_ID!,
  privateKey: await importPrivateKeyPem(readFileSync(process.env.JOURNEAR_PLATFORM_KEY_FILE!, 'utf8')),
};

const me = await callPlatform(cfg, { method: 'GET', path: '/v1/platform/credential' });
console.log(me.status, me.body.keyId, me.body.expiresAt, me.requestId);

// A write: the Idempotency-Key is made once and stored with the operation before the first send.
const idempotencyKey = newIdempotencyKey();
const created = await callPlatform(cfg, {
  method: 'POST',
  path: '/v1/platform/apps',
  body: { scopeId: 'your-shared-scope-id', name: 'Acme Swap', origins: ['https://swap.acme.example'] },
  idempotencyKey,
});
```

### Java 17 or later

The same signer for a Java backend, standard library only. Journear's tests compile this exact code and check its
message and signature against the vector above whenever a JDK 17 or later is on the test machine (they say so and
skip otherwise). Once, by hand (Java 17, 2026-11-26), a `GET` and a signed self-revoke it produced were also accepted
by the API's own request checks; that part isn't repeated by the tests. It sends one attempt (10 s to connect, 15 s
for the answer to start); follow [section 6](#6-retries-idempotency-and-versions) for retries.

```java
// Journear Passport platform API: sign and send requests from a Java 17+ backend. No dependencies.
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

public final class JournearPlatform {
  private static final Base64.Encoder B64URL = Base64.getUrlEncoder().withoutPadding();
  private static final SecureRandom RNG = new SecureRandom();
  private final String apiBase, envName, signerAccount, keyId;
  private final PrivateKey key;
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

  /** The env's values come from your configuration (Journear gives them per env); the key from your key store. */
  public JournearPlatform(String apiBase, String envName, String signerAccount, String keyId, PrivateKey key) {
    this.apiBase = apiBase.replaceAll("/+$", ""); this.envName = envName; this.signerAccount = signerAccount; this.keyId = keyId; this.key = key;
  }

  /** A PKCS #8 PEM private key, as `openssl genpkey` writes it. */
  public static PrivateKey importPrivateKeyPem(String pem) throws GeneralSecurityException {
    String b64 = pem.replaceAll("-----(BEGIN|END) PRIVATE KEY-----", "").replaceAll("\\s", "");
    return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(b64)));
  }

  /** The signed message: ten lines joined by "\n", no trailing newline. */
  public static String message(String envName, String signerAccount, String method, String path, String keyId,
      String timestamp, String nonce, String idempotencyKey, String bodySha256Hex) {
    String[] lines = {"journear-platform-v1", envName, signerAccount, method, path, keyId, timestamp, nonce, idempotencyKey, bodySha256Hex};
    for (String l : lines) if (l.contains("\n") || l.contains("\r")) throw new IllegalArgumentException("A line holds a line break");
    return String.join("\n", lines);
  }

  /** The headers for one attempt. Pass nonce null for a fresh one (always, except for test vectors). */
  public Map<String, String> signHeaders(String method, String path, byte[] body, String idempotencyKey, long timestampMs, String nonce)
      throws GeneralSecurityException {
    if (nonce == null) {
      byte[] n = new byte[16];
      RNG.nextBytes(n);
      nonce = B64URL.encodeToString(n);
    }
    String bodyHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
    String msg = message(envName, signerAccount, method, path, keyId, Long.toString(timestampMs), nonce,
        idempotencyKey == null ? "" : idempotencyKey, bodyHash);
    // "inP1363Format" gives r ‖ s (64 bytes), what the API wants; plain "SHA256withECDSA" gives DER, which it refuses.
    Signature s = Signature.getInstance("SHA256withECDSAinP1363Format");
    s.initSign(key);
    s.update(msg.getBytes(StandardCharsets.UTF_8));
    Map<String, String> h = new LinkedHashMap<>();
    h.put("Journear-Key-Id", keyId);
    h.put("Journear-Timestamp", Long.toString(timestampMs));
    h.put("Journear-Nonce", nonce);
    h.put("Journear-Signature", B64URL.encodeToString(s.sign()));
    if (idempotencyKey != null) h.put("Idempotency-Key", idempotencyKey);
    if (method.equals("POST")) h.put("Content-Type", "application/json");
    return h;
  }

  /**
   * One attempt, signed now: 10 s to connect, 15 s for the answer to start (HttpRequest.timeout). A timeout throws
   * HttpTimeoutException: retry it as a network error, calling this again with the same body and Idempotency-Key.
   */
  public HttpResponse<String> send(String method, String path, String jsonBody, String idempotencyKey) throws Exception {
    byte[] body = method.equals("POST") ? jsonBody.getBytes(StandardCharsets.UTF_8) : new byte[0];
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(apiBase + path)).timeout(Duration.ofSeconds(15));
    signHeaders(method, path, body, idempotencyKey, System.currentTimeMillis(), null).forEach(b::header);
    b.method(method, method.equals("POST") ? HttpRequest.BodyPublishers.ofByteArray(body) : HttpRequest.BodyPublishers.noBody());
    return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
  }
}
```

For Python, Go or another language: build the ten lines exactly as above, sign with ES256, and send the raw 64-byte
signature; most libraries answer DER, so convert it. Check your code against the test vector first. We haven't
tested a sample in those languages.

### Using a KMS

A KMS signs on your behalf, so the private key never sits on your server. Two differences from WebCrypto:

- **What it signs.** If the service hashes for you (AWS KMS with `MessageType: RAW`), give it the message bytes. If
  it signs a digest (AWS KMS `MessageType: DIGEST`, Google Cloud KMS), give it the 32 bytes of SHA-256 of the
  message, never of anything else.
- **What it answers.** AWS KMS and Google Cloud KMS answer DER: convert it with `derToRaw` before base64url.

Check the result against your own public key before going further.

## 5. The endpoints

Every route is `{API}/v1/platform/…`. Answers are JSON. A success carries its fields and `requestId`; a failure
carries `{ error, code, requestId, … }`. Match on `code` (stable); `error` is for people and may change. Every answer
also has an `x-request-id` header with the same id.

**Every write is a `POST` with an `Idempotency-Key`** ([section 6](#6-retries-idempotency-and-versions)). Any route
can also answer the common refusals of [section 8](#8-limits-refusals-and-the-off-switches) and
[section 13](#13-troubleshooting-by-error-code) (`401`, `403 platform_off`, `429`, …).

### The credential

`GET /v1/platform/credential`: your key's own state.

```json
{ "keyId": "pkc_…", "label": "Production backend", "orgId": "org_…", "scopes": ["…"], "thumbprint": "…",
  "activeFrom": 1800000000000, "expiresAt": 1831536000000,
  "limits": { "requestsPerMinute": 60, "requestsPerDay": 2000, "maxApps": 10, "appCreationsPerDay": 5, "originProposalsPerDay": 30 },
  "requestId": "…" }
```

Times are unix milliseconds. `scopes` are the scope ids your key may use. Call it at start-up to check your setup,
and once a day to watch `expiresAt`.

`POST /v1/platform/credential/revoke` with `{}` or `{ "reason": "…" }` (one line, at most 200 characters): stops this
key at once ([section 3](#stop-a-key-at-once)). Answers `{ revokedAt }`. The `Idempotency-Key` is optional here.

### Create an app for a partner

`POST /v1/platform/apps`

```json
{ "scopeId": "<your shared scope>", "name": "Acme Swap", "origins": ["https://swap.acme.example", "https://widget.network.example"] }
```

- `name`: what users see in Journear Passport's windows ("Signing in to Acme Swap"). The same rules as every app name
  (up to 64 characters; no web address, no "Journear", no word starting with "Hana", no "Passport" used as the
  wallet's name: the integration guide's "App names" lists them). It also must not read like the name of **another
  app on the same scope** ("ACME-swap", "Acrne Swap" and "Àcmé Swap" all read as "Acme Swap"). Names can't be changed
  later through the platform.
- `origins`: 0 to 20 web addresses for the partner (more can be added later). Each must be `https://`, with no
  loopback address (`localhost`, `127.0.0.1`), no port wildcard and no host name that mixes alphabets. For a partner
  that uses your own widget in an iframe, list the widget's web address **and** every page of the partner's that
  frames it ([section 10](#10-the-front-end-the-partners-site-and-your-sdk)).

**Answer `201`:**

```json
{ "app": { "id": "app_…", "name": "Acme Swap", "originsVersion": 1, "origins": [ … ], "keys": [ … ], … },
  "publishableKey": "pk_test_…",
  "changes": [ { "changeId": "gc_…", "origin": "https://swap.acme.example" }, … ],
  "requestId": "…" }
```

Store `app.id`, `publishableKey` and the `changes` with the partner's record. The app doesn't work anywhere yet: its
web addresses all start **waiting** ([section 7](#7-what-a-partner-experiences)).

| Refusal | Why | What to do |
|---|---|---|
| `403 forbidden` | The scope isn't one of your key's, isn't your organisation's test scope, or isn't marked as a shared wallet (one answer for all three) | Check `scopes` in `GET /credential`; ask Journear |
| `400 bad_request` | The name breaks a rule, or an origin isn't a web address | Fix the input (the message says what) |
| `400 origin_refused` | An origin breaks the rules above (`http`, loopback, mixed alphabets) | Fix the origin |
| `409 conflict` | The name reads like another app's on this scope; or the scope was given to your organisation moments ago | Choose another name; retry a little later |
| `409 no_security_contact` | Your organisation has no security contact | Ask Journear to set one |
| `409 app_limit` (with `maxApps`) | Your organisation has as many platform-created apps as it may (10 by default) | Ask Journear to raise it, or to delete apps you no longer need |
| `429 rate_limited` | A creation or web address quota ([section 8](#8-limits-refusals-and-the-off-switches)); `limit` names it | Wait `retry-after` seconds |

### List and read apps

`GET /v1/platform/apps` (optionally `?scopeId=…` and `&cursor=…`): `{ apps: [PlatformApp], next? }`, 50 apps a page,
ordered by app id. When `next` is there, call again with `cursor=<next>`. Only apps your organisation created
through the platform, on your key's scopes. A `scopeId` your key doesn't name is `403 forbidden`.

`GET /v1/platform/apps/:appId`: `{ app: PlatformApp }`, or `404 not_found`.

**The app view** (`PlatformApp`): exactly these fields.

```json
{ "id": "app_…", "name": "Acme Swap", "scopeId": "…", "environment": "test", "createdBy": "platform", "createdAt": 0,
  "userIds": "app",
  "suspended": { "byJournear": false, "byOrganisation": false, "byYou": false, "youCanResume": false },
  "originsVersion": 1,
  "origins": [ { "origin": "https://xn--bcher-kva.example", "display": "https://bücher.example", "idn": true,
                 "state": "waiting", "activeFrom": 1800086400000, "confirmedAt": null, "changeId": "gc_…" } ],
  "keys": [ { "id": "key_…", "key": "pk_test_…", "createdAt": 0, "revokedAt": null } ] }
```

| Field | Meaning |
|---|---|
| `userIds` | `"app"`: this app gives each person a User ID of its own ([section 9](#9-user-ids-and-support-ids)) |
| `suspended.byJournear` | Journear stopped the app (never why). Only Journear can lift it |
| `suspended.byOrganisation` | An owner suspended it in the portal, or took your suspension over. Only an owner can lift it |
| `suspended.byYou`, `youCanResume` | Your backend's suspension, which you may lift |
| `originsVersion` | Goes up with every change to the web addresses: send it as `expectedVersion` ([section 6](#6-retries-idempotency-and-versions)) |
| `origins[].origin`, `display`, `idn` | The web address as stored (international names in their `xn--` form), how it reads, and whether it uses international letters |
| `origins[].state` | `waiting_announcement`, `waiting` or `active` ([section 7](#7-what-a-partner-experiences)) |
| `origins[].activeFrom` | When it starts (or started) working; `null` until announced. For a waiting one: the time it works if nobody confirms it |
| `origins[].confirmedAt` | When an owner confirmed it (never who); `null` otherwise |
| `keys` | The 20 newest publishable keys, oldest first; a revoked key has `revokedAt` |

A cancelled or removed web address is no longer in `origins`.

### Ask for web addresses

`POST /v1/platform/apps/:appId/origins` with `{ "add": ["https://shop.acme.example"], "expectedVersion": 1 }` (1 to
20 addresses). Answer `202 { version, changes: [{ changeId, origin }] }`. Each address waits like a create's
([section 7](#7-what-a-partner-experiences)): announced by email, then working when an owner confirms it or 24 hours
after the email. Nothing you send can make it faster.

Refusals: `404 not_found`; `400 origin_refused` (the rules above); `409 version_conflict` (your `expectedVersion` is
old: read the app again); `409 conflict` (already an address of the app, working or waiting; the app would have more
than 20; the scope given to your organisation moments ago); `429 rate_limited` (the quotas of
[section 8](#8-limits-refusals-and-the-off-switches), including `platform:waiting_origins`).

### Remove web addresses

`POST /v1/platform/apps/:appId/origins/remove` with `{ "remove": ["https://shop.acme.example"], "expectedVersion": 2 }`.
Answer `200 { version }`. Immediate: a waiting address is cancelled, a working one stops working, and the users who
signed in there are signed out. Refusals: `404`, `400 bad_request` (not an address of the app), `409
version_conflict`. This is an off switch: it works while your organisation is frozen. Because it signs people out, it
counts against the removal limit ([section 8](#8-limits-refusals-and-the-off-switches)).

### Cancel a waiting web address

`POST /v1/platform/changes/:changeId/cancel` with `{}` (the `changeId` from the create or the proposal). Answer
`200 { change: { changeId, appId, origin, display, idn, status: "cancelled", activeFrom, cancelledAt } }`. Only a
waiting address a platform key of your organisation asked for. Refusals: `404 not_found` (also for any change your
backend didn't make), `409 not_pending` (already working, cancelled or ended: remove it instead).

### Suspend and resume

`POST /v1/platform/apps/:appId/suspend` with `{ "suspended": true }` or `{ "suspended": false }`. Answer
`200 { suspended }` (the view's object). Suspending stops the app at once: no sign-in and no call to Journear works
for it, and pages already open stop on their next call. Sending the state it already has changes nothing and uses
none of your limit of suspensions ([section 8](#8-limits-refusals-and-the-off-switches)). You may
resume only a suspension your backend set (`youCanResume`): if an owner suspended the app in the portal, or took your
suspension over, resuming is `403 forbidden`, and only an owner can lift it. Journear's own suspension is never yours
to lift.

### Publishable keys

- `POST /v1/platform/apps/:appId/keys` with `{}`: a new key, `201 { key: { id, key, createdAt, revokedAt: null } }`.
  At most 5 unrevoked keys per app (`409 key_limit`).
- `POST /v1/platform/apps/:appId/keys/:keyId/revoke` with `{}`: revoked at once, `200 {}`, or
  `{ "warning": "last_key" }` when it was the app's last valid key (the app then stops working). `409 conflict` if
  it was already revoked (that uses none of your limit of key revocations, [section 8](#8-limits-refusals-and-the-off-switches)).
  A revocation can't be undone, so it has a lower limit than suspending: in an emergency, suspend the app first.

To rotate a partner's publishable key: create the new one, publish it in your partner configuration, wait until your
caches have turned over, then revoke the old one.

## 6. Retries, idempotency and versions

**One Idempotency-Key per operation.** Make it when you decide to do something ("create Acme's app"), store it with
that intent **before** the first send, and resend it unchanged on every retry, even after a restart. Every attempt is
signed again: a new nonce, a new timestamp, the same body bytes and the same key.

What Journear answers to a write it has seen:

| You send | Within 7 days | After 7 days |
|---|---|---|
| The same key, method, path and body, from the same platform key | `200` with the operation's answer as it is now and `"replayed": true`; nothing is written again | `409 already_applied` |
| The same key with another method, path or body | `409 idempotency_conflict`: a bug on your side (one key, two operations). Use a new key | `409 already_applied` if it is the same kind of write on the same app from the same platform key (another body is not noticed after 7 days); otherwise `409 conflict` |
| The same key from your organisation's **other** platform key (a rotation mid-retry) | `409 conflict`: read the app to see whether it applied; if not, start again with a new key | `409 conflict` |

After 7 days, `already_applied` means "a write of this kind on this app was made with this key": it doesn't prove
that **this** body was applied. Read the app to see its state. Never reuse an Idempotency-Key for a different
request. A write that was refused or failed records nothing, so its key may be used again. A replay of a write whose app has
since left your key's reach (deleted, or its scope taken off the key) is `404 not_found`. A replayed create answers
`200`, not `201`.

**Don't send one operation twice at the same time.** Two copies sent at the same moment: one writes, the other is
`409 already_applied`. Both may have used one unit of your quotas by then, and the loser's isn't given back, so run
each operation from one worker at a time.

**What to retry.**

| Answer | Retry? |
|---|---|
| No answer (timeout, connection error) | Yes: same Idempotency-Key, signed again. If it had landed, you get the replay |
| `500 internal` | Yes, with backoff (a write that committed answers its result; a retry gets the replay) |
| `503 rate_limiter_unavailable` | Yes, after a few seconds |
| `429 rate_limited` | After `retry-after` seconds. For a daily window that is hours: stop and report instead of looping |
| `400 stale_request` | Not until your clock is fixed (`serverTimeMs` is Journear's time) |
| `409 request_replayed` | Only signed again with a new nonce: you reused one, which is a bug |
| `409 version_conflict` | Read the app, decide again, and send the new request with a **new** Idempotency-Key |
| Any other `4xx` | No: read `code` and fix the cause |

The reference client retries the first four kinds by itself, and gives each attempt 15 seconds (`timeoutMs`), the
answer's body included: a timeout counts as no answer.

**Optimistic versions.** Proposals and removals carry `expectedVersion`: the app's `originsVersion` when you last read
it. If anything changed the web addresses since (another proposal, a removal, a cancel, a key revocation that
cancelled waiting addresses), the write is `409 version_conflict` and nothing is written. Read the app, check whether
what you wanted is already true, and if not, send again with the new version. An owner's confirmation doesn't change
the version.

## 7. What a partner experiences

### The timeline of a new web address

1. **Your backend asks** (a create with `origins`, or a proposal). The address shows `state: "waiting_announcement"`,
   `activeFrom: null`. Our SDK refuses the partner's page on it for now.
2. **Within about 5 minutes Journear emails** your security contacts, every owner of your organisation and Journear's
   security team, one email per request, listing every address. The address becomes `state: "waiting"` with
   `activeFrom` = the time it starts working if nobody confirms it: **at least 24 hours after the email**.
3. **An owner confirms it**, or nobody does:
   - An owner who is an on-chain owner of the scope opens the email's **Check and confirm in the partner portal**
     link, signs in, ticks each address one by one (nothing is ticked at first; there is no "confirm all") and
     presses **Confirm**, with a fresh Google sign-in. The address works **at once**: `state: "active"`, and
     `confirmedAt` = `activeFrom` = the moment of the confirmation.
   - If nobody confirms it, it starts working by itself at `activeFrom` (24 hours or a little more after the email).
4. **Anyone can cancel it while it waits**: the cancel link in the email (no sign-in), an owner in the portal, your
   backend (`cancel`), or Journear staff. Once it works, it can only be removed.

The 24 hours hold in every environment except Journear's own local test setups. No waiver, no "nobody has signed in
yet" exception and no expedite applies to an address your backend asked for.

**Who vouches for an address.** You do, for every partner site you add: before asking for an address, check that the
partner controls the domain (your own process, for example a DNS record or a file on the site), ask only for the
partner's exact `https://` addresses, and remove them when the partner leaves or its domain lapses. Then one of your
owners confirms each new address, or lets it wait. So a stolen platform key alone can only start the slow,
announced, cancellable path.

### The emails

All Journear notices go to the security contacts, every owner and Journear's security team. On a test environment
the subject starts with an environment label such as `[SANDBOX]`.

- **"New web address requested by your platform key for {app}"** (or "New web addresses …"): "Your organisation’s
  backend asked, with your platform key “{label}” ({key id}), for a new web address for {app}. It doesn’t work yet."
  Then the app, the organisation, the scope, who asked and when; each address, how it reads and, for international
  letters, a warning to check for a lookalike, with its own **Cancel** link; "It starts working no sooner than
  {date}, at least 24 hours after this email, or sooner if an owner of your organisation confirms it, unless someone
  cancels it."; and the **Check and confirm in the partner portal** link, which only opens the page (opening it
  confirms nothing).
- **"Web address confirmed for {app}"** (or "Web addresses …"), right after a confirmation: who confirmed it, and one
  **removal link** per address, valid 7 days, that stops it at once (the page asks first; opening the link changes
  nothing).
- For keys: "New platform key registered", "Platform key confirmed", "Platform key stopped", "Platform key expires
  soon" ([section 3](#3-your-platform-key)).

Partner companies get no portal access and no emails from Journear: tell your partner yourself.

### Show it in your portal

Read the app (`GET /v1/platform/apps/:appId`, or the list) and map each address. `state` is computed when you read
it, so a `waiting` address becomes working at `activeFrom` by itself: compare `activeFrom` with the time now rather
than reading again every minute.

| What the API says | Show the partner | Their site |
|---|---|---|
| `waiting_announcement` | "Waiting: the announcement email goes out within a few minutes" | Not working yet |
| `waiting`, `activeFrom` in the future | "Waiting for our owner to confirm it, or live on {activeFrom}" | Not working yet |
| `active` (or `waiting` with `activeFrom` passed) | "Live" (with `confirmedAt`: "confirmed on {date}") | Works |
| Gone from `origins` | "Cancelled" or "Removed" (as your records say) | Doesn't work |
| `suspended.byJournear` | "Paused by Journear: contact us" | Nothing works |
| `suspended.byOrganisation` | "Paused by our team" | Nothing works |
| `suspended.byYou` | "Switched off" | Nothing works |
| No key without `revokedAt` | "No key: create one" | Nothing works |

To keep within your daily request budget, poll with the list (one call for 50 apps), only while some address is
waiting, and not more often than every few minutes.

## 8. Limits, refusals and the off switches

All limits are provisional and kept low while you have few partners. Journear can raise your organisation's values.

| Limit | Value | Refusal (`limit` in the body) |
|---|---|---|
| Requests per platform key | 60 requests a minute and 2,000 a UTC day | `429`, `platform:key:req:minute`, `platform:key:req:day` |
| Off switches per platform key, once its requests are used up | 10 more a minute and 100 more a UTC day, for off switches only | `429`, `platform:key:kill:minute`, `platform:key:kill:day` |
| Fresh nonces per key | 300 a minute | `429`, `platform:nonce` |
| Failed requests per IP address | 30 failed requests a minute (an IPv6 /48 counts as one address); successes don't count | `429`, `platform:ip` |
| App creations per organisation | 2 an hour and 5 a UTC day | `429`, `platform:creations:hour`, `platform:creations:day` |
| Web addresses asked for, per organisation (each address counts) | 20 an hour and 30 a UTC day | `429`, `platform:proposals:hour`, `platform:proposals:day` |
| Web addresses waiting at once, across your apps | at most 30 web addresses waiting | `429`, `platform:waiting_origins` |
| Apps created through the platform, not deleted | 10 apps | `409 app_limit` with `maxApps` |
| Web addresses per app (working or waiting) | 20, the widget's address included | `409 conflict` |
| Publishable keys | 5 unrevoked per app; your keys create at most 20 an hour and 50 a UTC day | `409 key_limit`; `429`, `platform:keys:hour`, `platform:keys:day` |
| Platform keys per organisation | 2 working, waiting or awaiting acceptance | (in the portal) |
| Web address removals | 10 an hour per organisation and 30 an hour across every organisation; your first 5 in any hour always pass, whatever other organisations did | `429`, `platform:breaker_org`, `platform:breaker_global` ("ask Journear security") |
| Suspending an app | 60 an hour per organisation, counting only those that changed something; never limited by other organisations | `429`, `platform:suspensions:hour` |
| Revoking a publishable key | 20 an hour per organisation, counting only those that changed something; never limited by other organisations | `429`, `platform:key-revokes:hour` |
| Journear's database budget | per organisation and shared | `429`, `platform:budget_org`, `platform:budget_platform`, `platform:budget_shared`, `platform:budget_reserve` |
| Self-revokes | 10 a minute per key | `429`, `platform:key:revoke:minute` |

Clock hours and UTC days are fixed windows; the removal limit is a rolling hour (the last 60 minutes). A refused or
replayed write doesn't use a unit of the creation, address, key, suspension or revocation quotas, and a removal that changed nothing
gets its unit back, with two exceptions: every request admitted counts against your key's 60 a minute and 2,000 a day
(or, for an off switch past those, its own 10 and 100), whatever its answer; and two copies of one write sent at the
same moment may both use a unit ([section 6](#6-retries-idempotency-and-versions)).

**`429`** looks like `{ "error": "…", "code": "rate_limited", "limit": "platform:creations:day", "retryAfterS": 3600,
"requestId": "…" }` with a `retry-after` header in seconds. Wait that long. For a minute window, back off and retry;
for an hour or a day window, queue the work and tell your team. The removal limit (the "breaker") protects against a
runaway script or a stolen key signing people out: if you hit it, stop and talk to Journear.

**Your off switches** (remove, cancel, suspend, revoke a publishable key) are built to keep working when other limits
are full:

- **Other organisations can't use them up.** Your first 5 removals in any hour pass even when the limit across every
  organisation is full. Suspending and revoking a publishable key aren't counted by that limit at all: they have your
  organisation's own limits (60 suspensions and 20 revocations an hour). Cancelling a waiting address counts against
  none of these.
- **A key that used up its requests can still stop things.** Past its 60 a minute or 2,000 a day, a key still has 10
  off switches a minute and 100 a UTC day of its own. Ordinary calls stay refused.
- **They keep a reserve of Journear's database budget**, so they keep working when ordinary calls are refused for
  that budget, yours or other organisations': at least 12 off switches a minute for your organisation however busy
  others keep it. Past that, or when many organisations stop things at the same moment, one waits for `retry-after`
  (seconds, at most a minute).
- **Not exempt from everything:** each key's 300 nonces a minute, your organisation's own database budget and the
  limits above still apply. Only the key's self-revoke skips those.

If your key's own windows are full in an emergency, use your standby key, or stop things in the partner portal, which
these limits don't touch.

**`401 unauthenticated`** is one identical answer for every authentication failure ([section 4](#the-signature)).
Don't retry it in a loop: after 30 failures a minute from one address, even your valid requests from that address go
through a smaller per-key allowance, and repeated failures for one key id alert Journear's security team.

**When Journear switches the platform off for your organisation**, every call answers `403 platform_off`, except
`POST /v1/platform/credential/revoke`: your key can always stop itself. Switching off also cancels every web address
your keys asked for that is still waiting, and every key still waiting.

**When Journear freezes your organisation** (a containment step), only the off switches work: remove web addresses,
cancel a waiting one, suspend (`true`), revoke a publishable key and the self-revoke. Everything else, reads
included, answers `403 forbidden` ("Journear has paused your organisation: only stopping things works for now"). A
freeze also cancels what was waiting, as above.

**Journear's own off switches**, which you can't undo: suspend any app (`suspended.byJournear`), stop any platform
key, switch the platform off for your organisation.

## 9. User IDs and Support IDs

On your shared wallet a person has **one wallet** on every partner's site: the same Stellar, EVM and NEAR addresses
everywhere. But each app created through the platform gives that person **a User ID of its own** (`userIds: "app"`).

- **What the partner's site gets.** Its identity tokens carry `sub` = the person's User ID **in that app** (`u1_…`,
  25 characters), `aud` = the app id, and the person's wallet addresses in `wallets`. The page gets the matching
  Support ID (`hana.supportId`, `HANA-XXXX-XXXX`), the short form of that same User ID.
- **The same person has different IDs in different apps.** Partner A and partner B see different `sub` values and
  different Support IDs for one person. Neither can turn its ID into the other's. Your own site's app, made before
  the scope was marked, keeps the wallet-wide IDs it always had.
- **This is not privacy between partners.** The wallet addresses are the same on every site and are in every token,
  so two partners who compare addresses can still match their users. Per-app IDs only stop the User ID from being a
  ready-made join key, and stop a partner's backend that forgets to check `aud` from taking another partner's token
  as one of its users. Tell partners to key users on `sub` **and always check `aud`**.
- **How support looks someone up.** A user gives the partner their Support ID. The partner asks you. One of your
  owners opens the partner portal's **Users** page and searches by any app's User ID or Support ID: the person's page
  ("This person on your apps") lists their IDs on each of your apps. Owners only, never your backend; each look-up is
  recorded and limited. Journear staff can find a person by either kind of code. **Never give one partner another
  partner's ID for the same person**: the portal says so beside the IDs.

The identity token and the Support ID are in the integration guide ("Identity token").

## 10. The front end: the partner's site and your SDK

The partner's page (or your SDK on it) needs two things from the app your backend created: its **publishable key**
and an **allowed web address in force** for the page. The key is public: it can travel in your partner
configuration to the browser. The platform API itself is never called from a page.

When your SDK bundles ours (Sodax's case):

1. Your backend stores the partner's `publishableKey` in the partner's configuration when the toggle goes on.
2. Your SDK, on the partner's page, reads that configuration as it reads its other partner settings and, only when
   the toggle is on, loads `@hana-id/web` (`await import('@hana-id/web')`: it has no side effects on import) and calls
   `createHana({ publishableKey, environment, evm, stellar })`. Create the client only when the toggle is on: it adds
   our hidden frame at once.
3. Until one of the page's web addresses is in force, our frame refuses the page and the SDK reports
   `vault_unavailable` with `data.reason: 'no_answer'`. Show your own "waiting" state
   ([section 7](#show-it-in-your-portal)).

What your SDK needs to know about ours (the integration guide has the full API):

- **EVM.** Creating our client is enough: it announces itself to EVM wallet lists (EIP-6963), also when it is
  created after your list was built, so libraries that listen for announcements (wagmi, for example) show "Journear
  Passport" with no code of yours.
- **Stellar.** Our wallet is a Stellar Wallets Kit module, `new HanaIdModule(hana, { productId })` from
  `@hana-id/web/stellar-wallets-kit`. If your kit finds wallets by part of a name (so that "hana" would also match
  another wallet called Hana Wallet), pass `productId: JOURNEAR_PASSPORT_MODULE_ID` (`'journear-passport'`). A kit
  that builds its module list once, at start-up, needs a way to add a module later; Journear has a small change of
  that kind ready to discuss with you.
- **Errors.** Our wallet rejects with codes such as `4100` (a test key asked to sign on a real network) and `4001`
  (the user said no). Keep the wallet's own error (as a `cause`, for example) rather than replacing it, so partners
  can tell what happened.
- **Size.** Our SDK is about 35 kB gzipped and is loaded only when the toggle is on.
- **Toggle off on the page.** Remove our module from your lists, disconnect, and call `hana.destroy()`: it removes
  our hidden frame.

**Your widget in an iframe.** If the partner uses your widget, served from your own web address inside the partner's
page, the partner's app must list **the widget's web address and every partner page that frames it**. Our frame
checks every page around it, so an app that lists only the widget's address is refused on the partner's page, and
partner B's page can't use partner A's app. The widget's address counts as one of the app's 20. Two things to know:
the approval window names the **widget's** web address, not the partner's page (the app's name is what tells
partners apart); and anyone can open the widget's own page, outside any partner's site, with a partner's settings
and get that partner's app. Two changes of ours are planned, not built yet: our windows will also show the partner's
page, and an app will be able to accept the widget's address only inside a partner's page, which closes that gap.

**Switching a partner off in your portal doesn't sign its users out** on their devices: your SDK just stops loading
ours, as closing the tab would. Suspending the partner's app is what ends its sign-ins
([section 12](#12-recipe-the-toggle-on-and-off)).

## 11. Running it in production

- **A dedicated egress IP address.** Journear limits failed requests per IP address, and an edge rule blocks any
  address that sends more than 100 requests in 10 seconds (for 10 seconds). If your backend reaches the internet from
  a shared address (a cloud NAT used by others, or Cloudflare Workers, where every Worker reaches us from one shared
  address), anyone else on that address can fill those limits and lock your requests out, your self-revoke
  included. Send platform calls from a fixed address of your own. Your owners and Journear can always stop a key in
  the portals, whatever happens at the network level.
- **Key storage.** The private key lives in a KMS, an HSM or your secret manager, readable by the backend only. Never
  in a browser, your SDK, a partner's page, a repository, a log or a ticket, and never sent to Journear. Import it
  once at start-up as non-exportable (the reference client does). One key pair per environment.
- **Clock sync.** Keep the server's clock synchronised (NTP): a request more than 60 seconds off is refused.
- **Log the request id.** Log, for every call: the route, the status, `code`, and `x-request-id`. Journear support
  asks for the request id. Never log the private key; there is no need to log signatures or nonces either.
- **Watch these.**
  - `401`s: a misconfiguration, or a stopped or expired key.
  - `403 platform_off` or `403 forbidden` on reads: Journear switched you off or froze your organisation. Contact
    Journear.
  - `429`s by `limit`: you are near a quota, or something loops.
  - `expiresAt` from `GET /credential`: alert 30 days before, and keep the standby key in force.
  - Web addresses waiting past their `activeFrom` plus an hour, or still `waiting_announcement` after 30 minutes:
    ask Journear.
  - The announcement emails: each one should match something your backend did. An email you can't explain means
    someone else is using your key: stop it.
  - Your owners see every call your backend made in the portal (**Platform activity**), and every change in the
    Audit, both with the key's label.

## 12. Recipe: the toggle on and off

**Toggle on** (a partner switches Journear Passport sign-in on in your portal):

1. Collect the partner's name as users should see it and the exact `https://` web addresses of its pages (plus your
   widget's, if it uses it). Check the partner controls those domains.
2. Make an Idempotency-Key and save it with the partner's record ("create app: pending").
3. `POST /v1/platform/apps` with `scopeId`, `name` and `origins`. On a timeout or `5xx`, resend with the same key.
4. Save `app.id`, `publishableKey` and the `changes`. Show the partner "Waiting".
5. Your owners get the email. One of them checks the addresses and confirms them in the partner portal, or they work
   24 hours after the email.
6. When the addresses are `active`, show "Live". Your SDK now loads ours on the partner's pages with its key.

**Toggle off** (the partner switches it off):

1. `POST /v1/platform/apps/:appId/suspend` with `{ "suspended": true }`. Sign-ins stop at once.
2. Stop loading our SDK for that partner.
3. **Toggle on again:** `{ "suspended": false }` (if your backend set the suspension; otherwise an owner resumes it).

**The partner leaves for good:**

1. Suspend the app, then remove its web addresses (`origins/remove`) and revoke its publishable keys.
2. Ask Journear to delete the app: only Journear can, and an undeleted app still counts towards your 10.

**A partner changes its site:** ask for the new address (it waits as before), and remove the old one once the new one
is live.

## 13. Troubleshooting by error code

| Code | Status | Meaning | What to do |
|---|---|---|---|
| `unauthenticated` | 401 | The request isn't signed by a key in force in this environment (any reason) | Check the key's state in the portal, the env name and signer account, the exact path and query, the body bytes, the raw 64-byte signature; compare your signer with the test vector |
| `stale_request` | 400 | Your timestamp is more than 60 s from Journear's (`serverTimeMs`) | Sync your clock (NTP) |
| `bad_request` | 400 | A shape is wrong: the path, the query, the body (not a JSON object, too large, an unknown field), a missing or malformed `Idempotency-Key`, a name or origin | Read `error`; fix the request |
| `origin_refused` | 400 | A web address breaks the rules (`http`, loopback, mixed alphabets) | Use the exact `https://` address |
| `browser_refused` | 403 | The request had an `Origin` header | Call from your server only |
| `platform_off` | 403 | The platform is switched off for your organisation | Contact Journear; the self-revoke still works |
| `forbidden` | 403 | Your organisation is frozen (only off switches work); or the scope isn't usable by your key; or you tried to resume a suspension an owner holds | Read `error`; contact Journear for a freeze |
| `not_found` | 404 | No such route, app, change or key within your key's reach | Check the id, and that your backend created the app |
| `method_not_allowed` | 405 | Not `GET` or `POST`, or the wrong one for this route | Use the route's method (`allow` header) |
| `request_replayed` | 409 | This nonce was used before | Sign every request and retry afresh |
| `idempotency_conflict` | 409 | This Idempotency-Key was used in the last 7 days for another request | Use a new key per operation |
| `conflict` | 409 | Depends on the route: a retry from your other platform key; an address already on the app or more than 20; a look-alike name; the scope given moments ago; a key already revoked | Read `error`; for the retry case, read the app and decide |
| `already_applied` | 409 | A write with this Idempotency-Key was made: two copies sent at once, or a retry after 7 days (then possibly with another body) | Read the app to see its state; never reuse a key for a different request |
| `version_conflict` | 409 | The app changed since you read it, or the state moved during the write | Read again, decide, send with a new Idempotency-Key |
| `not_pending` | 409 | The address isn't waiting any more (working, cancelled or ended) | Remove it instead, if needed |
| `app_limit` | 409 | Your organisation has `maxApps` platform-created apps | Ask Journear to raise it or delete old apps |
| `key_limit` | 409 | The app has 5 unrevoked publishable keys | Revoke one first |
| `no_security_contact` | 409 | Your organisation has no security contact | Ask Journear |
| `rate_limited` | 429 | A limit of [section 8](#8-limits-refusals-and-the-off-switches); `limit` says which | Wait `retry-after` |
| `rate_limited` with `platform:breaker_org` or `platform:breaker_global` | 429 | Too many web addresses removed this hour (yours, or, past your first 5, across every organisation) | Stop and talk to Journear; suspending the app still works |
| `rate_limited` with `platform:suspensions:hour` | 429 | Your organisation suspended apps 60 times this hour | Wait `retry-after`; owners can still stop things in the partner portal |
| `rate_limited` with `platform:key-revokes:hour` | 429 | Your organisation revoked 20 publishable keys this hour | Suspend the app instead (it stops at once), and revoke the rest after `retry-after`; owners can still revoke keys in the partner portal |
| `rate_limited` with `platform:budget_reserve` | 429 | Your organisation used its share of the database reserve for off switches this minute (more than 12) | Wait `retry-after` (under a minute) |
| `rate_limited` with `platform:key:kill:minute` or `platform:key:kill:day` | 429 | This key used up its requests and then its off-switch reserve | Use your standby key, or stop things in the partner portal |
| `internal` | 500 | Something failed on Journear's side | Retry with backoff (same Idempotency-Key); if it persists, send Journear the request id |
| `rate_limiter_unavailable` | 503 | Journear's limiter didn't answer | Retry after a few seconds |

## 14. Questions we have for you

1. Where does your backend run, and does it have a fixed egress IP address of its own
   ([section 11](#11-running-it-in-production))?
2. Will you keep the key in a KMS? Which one (so we can check its signature format with you)?
3. How will you check that a partner controls a domain before you ask for it?
4. For partners on your widget: can your partner settings carry each partner's page addresses, so the app lists them?
5. How many partners do you expect in the first months? The defaults (10 apps, 5 creations a day, 30 addresses a
   day, 30 waiting) are low on purpose and easy to raise.
6. Who are the owners who will confirm addresses and keys, and are they on-chain owners of the scope?
7. Is polling enough for you, or would you need Journear to call your backend when an address starts working?
8. Should your partners' security notices also reach the partners themselves? Today they go to your organisation's
   security contacts, every owner of your organisation and Journear's security team, never to the partner.
