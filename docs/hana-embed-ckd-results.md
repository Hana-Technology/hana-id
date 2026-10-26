# Hana Embed: NEAR CKD full-key mode, results

Measured 2026-10-14 on NEAR testnet (`v1.signer-prod.testnet`, CKD domain 2), branch `feat/hana-embed-stellar`, page `/full-pk`.

**Result: it works.** A Google session asks `hana-signer.derive_key` once; the NEAR MPC returns the user's secret encrypted to a key only the browser holds; the browser decrypts it, checks it with a pairing, and derives its Stellar and EVM keys. Every signature after that is local: about 0.25 ms instead of about 12 s. The MPC accepted our contract as the caller with no TEE attestation (none of the three stop conditions was hit).

**The trade-off:** the full private key lives in the browser for the session. Script running on the page (XSS, a bad dependency, a malicious extension) can take the wallet outright. This is the Web3Auth / MetaMask Embedded Wallets model. On `/embed` the key never exists anywhere.

## Measurements

| Measure | Result | Brief's pass mark |
|---|---|---|
| CKD call, end to end via relayer (10 runs) | min 5.7 s · median **6.2 s** · max 7.8 s | ≤ 15 s ✅ |
| Same, in the browser on `/full-pk` (2 runs) | 5.9 s, 7.0 s | |
| Gas per `derive_key` (all receipts) | **18.85 Tgas**, 0.0018 NEAR | ≤ 20 Tgas ✅ (close to the line) |
| Response size | 177 bytes (`big_y`, `big_c`) | |
| Decrypt + pairing check | ~25 ms (Node), under 0.1 s in the browser | |
| Determinism | 10 calls on one path, same secret every time | ✅ |
| Path isolation | `global#google#ckd-user-1` and `…-2` give different secrets | ✅ |
| Local signing | Ed25519 **0.26 ms**, secp256k1 **0.22 ms** (avg of 200) | |
| Live signing | EVM message recovered to the derived address; Stellar testnet payment `ee68c4d1…9081` confirmed, signed in 0.0 s | Stellar and Sonic **mainnet** pending funds at the new addresses |

Secrets were only ever compared by a SHA-256 fingerprint; none was printed or stored outside the browser.

## How it works (as built)

1. Google sign-in opens a session as on `/embed` (session key in the browser, Google JWT checked on-chain).
2. The browser makes a fresh BLS12-381 key `a` and sends `(a·G1, a·G2)`. The session key signs exactly that key plus the next counter, so the contract will not release the secret to anyone else's key.
3. `hana-signer.derive_key` calls `request_app_private_key` (domain 2, path = the session path, 20 Tgas, 1 yoctoNEAR).
4. The MPC returns `big_y = y·G1`, `big_c = msk·H + y·a·G1`. The browser computes `sig = big_c − a·big_y`, checks `e(H, pk) = e(sig, G2)` with `H = hash_to_curve(pk ‖ app_id)` and `app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:hana-signer.testnet," ‖ path)`.
5. `HKDF-SHA256(sig, salt "hana-embed-ckd-v1")` gives one key per chain family (`info` "hana-embed evm secp256k1 v1" and "hana-embed stellar ed25519 v1").

Sources (near/mpc @ `a7ae426`): `crates/contract/src/api/ckd.rs` (`request_app_private_key`: no caller attestation check, 1 yocto deposit, gas from config), `crates/contract/src/primitives/ckd.rs` (domain tag, `H(pk ‖ app_id)`, output check), `crates/near-mpc-crypto-types/src/kdf.rs` (`derive_app_id`), `crates/near-mpc-crypto-types/src/ckd.rs` (`AppPublicKeyPV` JSON), `crates/ckd-example-cli/src/ckd.rs` (decrypt and verify).

## What is on-chain per call

| Where | Visible | Sensitive? |
|---|---|---|
| Our transaction args | Session public key, counter, session signature, browser's BLS public key | No: useless without the browser's private keys |
| MPC log | Caller (`hana-signer.testnet`), **derivation path incl. the Google user id**, browser's BLS public key | The Google id links the login to its wallet (same as `/embed`) |
| Result | `big_y`, `big_c` | No: encrypted to the browser's key |

## What changes for production

- **Storing the key:** the POC keeps it in `sessionStorage`, readable by any script on the page. Production: hold it under a non-extractable WebCrypto key, or a passkey PRF, and keep signing code isolated from third-party scripts (strict CSP, a separate signing origin or iframe).
- **No revocation without new addresses:** the secret is a pure function of (contract, path). Anyone who once read it keeps it. The only remedy is new addresses: a new path or contract, plus moving funds. Session expiry does not help, because the key itself doesn't expire.
- **Per-partner accounts:** the path already carries the scope (`global#…`), so `partner:<id>#google#<sub>` gives isolated keys with no other change.
- **Privacy:** salt the Google id in the path so it can't be linked to a wallet on-chain.
- **TEE caller (question for NEAR One):** the design doc assumes the requesting app runs in a TEE and checks attestation. The deployed contract doesn't enforce that, and a browser caller works today. Ask NEAR One whether non-TEE callers stay supported on mainnet.
- **Gas headroom:** 18.85 Tgas is near the brief's 20 Tgas mark. Most of it is fixed MPC overhead (15 Tgas attachment requirement).
- **Ops:** Vercel's `NEAR_RELAYER_PRIVATE_KEY` must be the new function-call key, which includes `derive_key`. The old key still serves `/embed`.
