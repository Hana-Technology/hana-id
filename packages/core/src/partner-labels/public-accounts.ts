// Stellar accounts whose secret key is public, which a label's address book may never list. Each is an account anyone
// can sign for (some exist on the public network under a stranger's control): the account of every seed made of one
// repeated byte (32 × 0x00 to 32 × 0xff, the usual test and example seeds) and the all-zero public key. A partner that
// listed one would switch the red "not one of the accounts listed" line off for payments to it. Stored as the first 4
// bytes of each public key, in hex, sorted (8 characters each; a test derives the list again from the seeds): a chance
// of about one in 16 million that an unrelated account shares a prefix with one of them, which is then refused too.
import { STRKEY_VERSION, decodeStrKey } from '../addresses.ts';

const PREFIXES =
  '0000000000e3c56b014e4d92020dacf803528a840a81997d0b513ad90beef5a90d7550750e34c045100ba90b11fd457112a415921398f62c' +
  '1660d27317cb79fb19204c8c197f6b231a3818791ba4075b1bee74bb1e2a137c2012cb90204040e320828bf52152f8d122fc297723b63170' +
  '248acbdb259145ad25fc32c429e5833a2bc2800b2c848ad82c9b9a422db797632df041252f0a7b2931debe5531f3322d332ebe8d34b4d904' +
  '350d6262353c8a7f379bd5b738aa2fe43a1c28c33b6a27bc3b8c3c1e3d84d35b3e37e8f03e6ea7ac3ef089593f0dda8140b0f49841e8fde1' +
  '43046bfe43a72e714508a07a466627d546dc9b9f46fd485b4721b5b64745d19c48075a5948be36a44a72e4034c71b3dc4dd9b6494e6008b0' +
  '4ed32f63511c34a151bfae7f52a5394952bcd4c6534709625384086854b0d81d55154f425526f742555f469c589366045912dac05b6489c9' +
  '5b8649c05b9437ad5c9c6df25e212c095e449ad65f67132960de5ecb623e770b62a611b46355691c64a08e6564c30815650b7dca65e8f9b0' +
  '66be7e3366cd608b673d6ba2677a74d968460ebe68f4b6016b734a8e6cfcb0706d44f9396e32c1976e7a1cdd6ee091fd70082ae9705fbac0' +
  '70df9e2274f85cda750826c276a1592076d81b33772c8a447866ae7779d279cc7b242f977be29b987d59c5627dbebbdf7ea0e3bd7f747b67' +
  '805440ee80ea10b98139770e8146640f814722de8320a519884b885788df55648a875fff8a88e3dd8b237d788c3da8798ca631458d4abe07' +
  '8e4190cd8e486e8f9109db5591a28a0b91ea2db8927308f593db9f2e9475c6cf953a13f997f7135a97ffc88399a7a4719f49439e9ff6204d' +
  'a09aa5f4a0a0c227a1180433a11dbe28a386c3e9a6d2455ea7f6dfafa87b8a99a8eebe0daaba072cab3fa2fdab7260f2acdb0e29acdcc849' +
  'acf12b4aaf06a3e3b2491d95b2a942ffb4088cd3b4740ba4b533d8adb5f90095b7282fe4b8fc9d70ba3b611eba42458eba44dfdfbb47d33d' +
  'bb787e59bc7cbcb5bcd6e7fdbe9a7e37bed7d2abc050c563c286554ac2f38d34c6822637c6d0c796c84069fac853ad0fc86d01adc9077518' +
  'c91cb3cec9571eebca57eed3ca7d75b4ca93ac17ca987f7acf1b37e8d04ab232d1f82684d404bc44d4eec186d54207dad5af25e2d62f016a' +
  'd759793bd76dfc6ed986763dd9bf2148dac31ebcdb995fe2dc517ff5dcbe4fdadded14e9e1902ba6e1b71abfe28a8970e2fe2a39e34d3a01' +
  'e5145a37e5687b6de63cc9f1e72c28fee734ea6ce8da63a4e92eb605ea4a6c63eb2cf13bebc198b8ed3234b2ed4928c6ed5721c4ed6a47a3' +
  'ee31f83cee45ecb9ee692b43ee93a4f6ef747fffefafc42fefe73e55f5eacab7f78b1da9f80cccdcf95c6a5df9b43983fa01347afa483414' +
  'fc947730fcbe3863fd1503f1fd172438fec14286';

const SET: ReadonlySet<string> = new Set(Array.from({ length: PREFIXES.length / 8 }, (_, i) => PREFIXES.slice(i * 8, i * 8 + 8)));

/** The prefixes, for the test that derives them again. */
export const PUBLIC_SEED_PREFIXES: readonly string[] = Object.freeze([...SET]);

/** Whether `account` (a G… address) is one whose secret key is public. Anything else (C…, malformed) is false. */
export function isPublicSeedAccount(account: string): boolean {
  let key: Uint8Array;
  try {
    key = decodeStrKey(STRKEY_VERSION.ed25519PublicKey, account);
  } catch {
    return false;
  }
  const hex = Array.from(key.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  return SET.has(hex);
}
