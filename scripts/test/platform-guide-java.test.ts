// The network's guide (docs/platform-guide.md, piece P8, D932) quotes a Java 17 signer. When a JDK 17 or later is on
// PATH, this compiles the guide's Java block exactly as printed, with a small harness that signs the guide's test
// vector request (the published vector key, its private half SHA-256 of a fixed text), and checks the message byte
// for byte and the signature with node:crypto (raw r ‖ s, 64 bytes). Without a JDK it says so and skips (after PR
// 160's review, L13). The API's own verifier is checked against the TypeScript client in
// apps/api/test/platform-guide.test.ts; the Java signer was put through it once by hand.
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const guide = readFileSync(new URL('docs/platform-guide.md', root), 'utf8');
const vectors = JSON.parse(readFileSync(new URL('packages/console-core/test/platform-request-vectors.json', root), 'utf8')) as {
  env: { envName: string; signerAccount: string };
  key: { keyId: string; jwk: { kty: string; crv: string; x: string; y: string } };
  timestampMs: number;
  cases: { name: string; method: string; path: string; body: string; headers: Record<string, string>; message: string }[];
};

/** The JDK's major version on PATH, or null (no javac, or one that doesn't answer). */
function jdkMajor(): number | null {
  try {
    const out = execFileSync('javac', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    const m = /javac (\d+)/u.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const major = jdkMajor();
const haveJdk = major !== null && major >= 17;

/** The guide's one ```java block. */
function javaBlock(): string {
  const m = /```java\n([\s\S]*?)```/u.exec(guide);
  if (!m?.[1]) throw new Error('no java block in docs/platform-guide.md');
  return m[1];
}

const HARNESS = String.raw`import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.util.HexFormat;
import java.util.Map;

public class Harness {
  public static void main(String[] a) throws Exception {
    byte[] d = MessageDigest.getInstance("SHA-256").digest("journear platform request vectors: test key 1".getBytes(StandardCharsets.UTF_8));
    AlgorithmParameters p = AlgorithmParameters.getInstance("EC");
    p.init(new ECGenParameterSpec("secp256r1"));
    PrivateKey key = KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, d), p.getParameterSpec(ECParameterSpec.class)));
    JournearPlatform jp = new JournearPlatform("https://api.example/", a[0], a[1], a[2], key);
    byte[] body = a[5].getBytes(StandardCharsets.UTF_8);
    String bodyHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
    String msg = JournearPlatform.message(a[0], a[1], "POST", a[3], a[2], a[4], a[6], a[7], bodyHash);
    Map<String, String> h = jp.signHeaders("POST", a[3], body, a[7], Long.parseLong(a[4]), a[6]);
    System.out.println(HexFormat.of().formatHex(msg.getBytes(StandardCharsets.UTF_8)));
    System.out.println(h.get("Journear-Signature"));
    System.out.println(h.get("Journear-Nonce") + " " + h.get("Journear-Timestamp") + " " + h.get("Idempotency-Key") + " " + h.get("Content-Type"));
  }
}
`;

describe('docs/platform-guide.md: the Java signer', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it.skipIf(haveJdk)(`not checked here: no JDK 17 or later on PATH (javac ${major ?? 'not found'})`, () => {
    // Visible in the run's list as skipped when a JDK is present; when it runs, it only records why nothing ran.
    console.warn('platform-guide-java: no JDK 17+ on PATH, so the guide’s Java signer was not compiled or checked');
    expect(haveJdk).toBe(false);
  });

  it.runIf(haveJdk)('compiles as printed; its message for the vector is the vector’s and its raw signature verifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-guide-java-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'JournearPlatform.java'), javaBlock());
    writeFileSync(join(dir, 'Harness.java'), HARNESS);
    execFileSync('javac', ['-Xlint:all', '-Werror', '-d', dir, join(dir, 'JournearPlatform.java'), join(dir, 'Harness.java')], { stdio: 'pipe', timeout: 120_000 });
    const c = vectors.cases.find((x) => x.name === 'post_idempotency')!;
    const out = execFileSync(
      'java',
      ['-cp', dir, 'Harness', vectors.env.envName, vectors.env.signerAccount, vectors.key.keyId, c.path, String(vectors.timestampMs), c.body, c.headers['Journear-Nonce']!, c.headers['Idempotency-Key']!],
      { encoding: 'utf8', timeout: 60_000 },
    ).trim().split('\n');
    expect(Buffer.from(out[0]!, 'hex').toString('utf8')).toBe(c.message);
    const sig = Buffer.from(out[1]!, 'base64url');
    expect(out[1]).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/u);
    expect(sig).toHaveLength(64);
    const pub = createPublicKey({ key: vectors.key.jwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(c.message, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    expect(out[2]).toBe(`${c.headers['Journear-Nonce']} ${vectors.timestampMs} ${c.headers['Idempotency-Key']} application/json`);
  });
});
