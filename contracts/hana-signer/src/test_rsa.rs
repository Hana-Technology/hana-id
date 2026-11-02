//! Test-only RSA-2048 keys and RS256 signing, so unit tests can mint tokens with any claims (email tokens in the JWS
//! JSON form, Google tokens with chosen nonces) without committing a private key: each key is generated at test time
//! from a fixed seed (deterministic, so failures reproduce) and lives only in the test process's memory.
//! `scripts/gen-fixtures.mjs` stays the independent implementation the byte layouts and fixture tokens are checked
//! against.

use std::sync::OnceLock;

use num_bigint::BigUint;

use crate::oidc;

/// DigestInfo prefix for SHA-256 (PKCS#1 v1.5).
const SHA256_PREFIX: [u8; 19] = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
const KEY_BYTES: usize = 256;

pub struct TestRsaKey {
    pub n: BigUint,
    pub e: BigUint,
    p: BigUint,
    q: BigUint,
    dp: BigUint,
    dq: BigUint,
    q_inv: BigUint,
}

/// splitmix64: a tiny deterministic generator, plenty for test key material.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| (self.next() & 0xff) as u8).collect()
    }
}

const SMALL_PRIMES: [u32; 54] = [
    3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157,
    163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257,
];

fn probably_prime(n: &BigUint, rng: &mut Rng) -> bool {
    let one = BigUint::from(1u32);
    let two = BigUint::from(2u32);
    for p in SMALL_PRIMES {
        if (n % p) == BigUint::from(0u32) {
            return false;
        }
    }
    let n_minus_1 = n - &one;
    let mut d = n_minus_1.clone();
    let mut s = 0;
    while (&d % 2u32) == BigUint::from(0u32) {
        d >>= 1;
        s += 1;
    }
    'witness: for _ in 0..24 {
        let a = BigUint::from_bytes_be(&rng.bytes(KEY_BYTES / 2)) % (n - 3u32) + &two;
        let mut x = a.modpow(&d, n);
        if x == one || x == n_minus_1 {
            continue;
        }
        for _ in 1..s {
            x = x.modpow(&two, n);
            if x == n_minus_1 {
                continue 'witness;
            }
        }
        return false;
    }
    true
}

/// A 1024-bit prime p with gcd(p - 1, 65537) = 1 and its top two bits set (so p·q has exactly 2048 bits).
fn prime(rng: &mut Rng, e: &BigUint) -> BigUint {
    loop {
        let mut bytes = rng.bytes(KEY_BYTES / 2);
        bytes[0] |= 0xc0;
        bytes[KEY_BYTES / 2 - 1] |= 1;
        let candidate = BigUint::from_bytes_be(&bytes);
        if (&candidate - 1u32) % e != BigUint::from(0u32) && probably_prime(&candidate, rng) {
            return candidate;
        }
    }
}

impl TestRsaKey {
    pub fn generate(seed: u64) -> Self {
        let mut rng = Rng(seed.wrapping_mul(0x2545_f491_4f6c_dd1d) ^ 0x6a09_e667_f3bc_c908);
        let e = BigUint::from(65537u32);
        loop {
            let p = prime(&mut rng, &e);
            let q = prime(&mut rng, &e);
            if p == q {
                continue;
            }
            let n = &p * &q;
            let phi = (&p - 1u32) * (&q - 1u32);
            let d = e.modinv(&phi).expect("e is coprime to phi");
            let q_inv = q.modinv(&p).expect("q is invertible mod p");
            return Self { dp: &d % (&p - 1u32), dq: &d % (&q - 1u32), n, e, p, q, q_inv };
        }
    }

    pub fn n_b64(&self) -> String {
        oidc::b64url(&self.n.to_bytes_be())
    }

    pub fn e_b64(&self) -> String {
        oidc::b64url(&self.e.to_bytes_be())
    }

    /// RSASSA-PKCS1-v1_5 with SHA-256 over `message` (CRT), `KEY_BYTES` big-endian bytes.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        let digest = near_sdk::env::sha256(message);
        let mut em = vec![0x00, 0x01];
        em.resize(KEY_BYTES - SHA256_PREFIX.len() - 32 - 1, 0xff);
        em.push(0x00);
        em.extend_from_slice(&SHA256_PREFIX);
        em.extend_from_slice(&digest);
        let m = BigUint::from_bytes_be(&em);
        let m1 = m.modpow(&self.dp, &self.p);
        let m2 = m.modpow(&self.dq, &self.q);
        let h = (&self.q_inv * ((&m1 + &self.p - (&m2 % &self.p)) % &self.p)) % &self.p;
        let s = m2 + h * &self.q;
        let bytes = s.to_bytes_be();
        let mut out = vec![0u8; KEY_BYTES - bytes.len()];
        out.extend(bytes);
        out
    }
}

/// The test keys, generated once per test process: index i is seed i + 1.
pub fn key(index: usize) -> &'static TestRsaKey {
    static KEYS: OnceLock<Vec<TestRsaKey>> = OnceLock::new();
    &KEYS.get_or_init(|| (1..=6).map(TestRsaKey::generate).collect())[index]
}
