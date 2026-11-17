// D833, enforced in the vault: typed data in a pinned delegate's EIP-712 domain (an `Execute` the delegate would accept
// once the account is delegated) is refused on the generic eth_signTypedData_v4 path before anything is shown (4100
// `sponsor_domain_reserved`), whatever the order of its keys or the form of its chain ID; and type-4 transactions stay
// refused on the generic eth_signTransaction path. A sponsored action goes only through evm_sendSponsored's approval.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parsePortRequest } from '@hana-id/core';
import { EXECUTE_TYPES, SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { Browser, type Google, type Tab, answer, google, login, openApproval, readyTab, waitLauncher } from './harness.ts';
import { EVM_VAULT, evmTx, typedData, typedSigner } from './chains.ts';
import { normalizeTxInput } from '../../src/client/evm-tx.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function session(): Promise<{ t: Tab; evm: string }> {
  const t = await readyTab(new Browser(), { googleJwk: g.jwk });
  tabs.push(t);
  const { reply } = await login(t, g);
  return { t, evm: (reply.result as { addresses: { evm: string } }).addresses.evm };
}

const DELEGATE = (SPONSOR_DELEGATES[31337] as { address: string }).address;
const ATTACKER = '0x3333333333333333333333333333333333333333';
const salt = `0x${'00'.repeat(12)}${DELEGATE.slice(2).toLowerCase()}`;

/** An Execute for the delegate's domain naming the page's own relayer, with value and any call: what a page would ask for. */
function execute(account: string, domain: Record<string, unknown>, domainTypes = EXECUTE_TYPES.EIP712Domain): string {
  return JSON.stringify({
    types: { EIP712Domain: domainTypes, Execute: EXECUTE_TYPES.Execute, Call: EXECUTE_TYPES.Call },
    primaryType: 'Execute',
    domain,
    message: { calls: [{ to: ATTACKER, value: '1000000000000000000', data: '0x' }], nonce: '0', deadline: '1900000000', relayer: ATTACKER, minGas: '0' },
  });
}

describe('typed data in the delegate’s domain is refused on eth_signTypedData_v4 (D833)', () => {
  const full = (account: string) => ({ name: 'HanaDelegateExecutor', version: '1', chainId: 31337, verifyingContract: account, salt });
  const cases: [string, (account: string) => string][] = [
    ['the exact domain', (a) => execute(a, full(a))],
    ['its keys in another order', (a) => execute(a, { salt, verifyingContract: a, chainId: 31337, version: '1', name: 'HanaDelegateExecutor' })],
    ['a hex chain ID', (a) => execute(a, { ...full(a), chainId: '0x7a69' })],
    ['a decimal-string chain ID on Base Sepolia', (a) => execute(a, { ...full(a), chainId: '84532' })],
    ['another version', (a) => execute(a, { ...full(a), version: '2' })],
    ['a domain with the name alone', (a) => execute(a, { name: 'HanaDelegateExecutor' }, [{ name: 'name', type: 'string' }])],
    [
      'another primary type in the same domain',
      (a) =>
        JSON.stringify({
          types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Order: [{ name: 'amount', type: 'uint256' }] },
          primaryType: 'Order',
          domain: { chainId: 31337, name: 'HanaDelegateExecutor' },
          message: { amount: '5' },
        }),
    ],
  ];
  it.each(cases)('%s: 4100 sponsor_domain_reserved, nothing shown', async (_name, json) => {
    const s = await session();
    const reply = await s.t.request('eth_signTypedData_v4', [s.evm, json(s.evm)]);
    expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'sponsor_domain_reserved' } });
    expect(s.t.launcher.label).toBeNull();
  });

  it('domain fields in a non-canonical order are refused as malformed, before the guard (nothing shown either way)', async () => {
    const s = await session();
    const reply = await s.t.request('eth_signTypedData_v4', [s.evm, execute(s.evm, full(s.evm), [...EXECUTE_TYPES.EIP712Domain].reverse())]);
    expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'invalid_request' } });
    expect(s.t.launcher.label).toBeNull();
  });

  // Not refused by the guard, which matches the delegate's name exactly: a name with extra whitespace or a look-alike
  // letter is another EIP-712 domain. The delegate hashes its own name as a constant, so the digest of such typed data
  // is one it never accepts: the signature can't execute anything. They go to the approval popup as any typed data does.
  it.each([
    ['a trailing space', 'HanaDelegateExecutor '],
    ['a look-alike letter (capital I for l)', 'HanaDeIegateExecutor'],
    ['another case', 'hanadelegateexecutor'],
  ])('a name with %s is not the delegate’s domain: shown, never a valid Execute signature', async (_name, name) => {
    const s = await session();
    const reply = s.t.request('eth_signTypedData_v4', [s.evm, execute(s.evm, { name, version: '1', chainId: 31337, verifyingContract: s.evm, salt })]);
    await waitLauncher(s.t, 'Review in Journear Passport');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    expect(m.kind).toBe('eip712');
    answer(s.t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
  });

  it('unrelated typed data still signs after approval', async () => {
    const s = await session();
    const json = typedData(EVM_VAULT, 'Order', { owner: s.evm, amount: '5' }, [
      { name: 'owner', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ]);
    const reply = s.t.request('eth_signTypedData_v4', [s.evm, json]);
    await waitLauncher(s.t, 'Review in Journear Passport');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    answer(s.t, popup, m, true);
    expect(typedSigner(json, (await reply).result as string)).toBe(s.evm);
  });
});

describe('type-4 (EIP-7702) transactions stay refused on the generic path (D833)', () => {
  it('eth_signTransaction with type 0x4 or an authorizationList is refused at the port', () => {
    expect(parsePortRequest({ v: 1, id: 'r1', method: 'eth_signTransaction', params: { tx: evmTx() } })).not.toBeNull();
    expect(parsePortRequest({ v: 1, id: 'r1', method: 'eth_signTransaction', params: { tx: { ...evmTx(), type: '0x4' } } })).toBeNull();
    expect(parsePortRequest({ v: 1, id: 'r1', method: 'eth_signTransaction', params: { tx: { ...evmTx(), authorizationList: [{ chainId: '0x7a69', address: DELEGATE, nonce: '0x0' }] } } })).toBeNull();
  });

  it('the SDK refuses them on eth_sendTransaction and eth_signTransaction (both take normalizeTxInput) before the vault', async () => {
    const to = EVM_VAULT;
    await expect(Promise.resolve().then(() => normalizeTxInput({ to, type: '0x4' }))).rejects.toBeDefined();
    await expect(Promise.resolve().then(() => normalizeTxInput({ to, authorizationList: [{ chainId: '0x7a69', address: DELEGATE, nonce: '0x0' }] }))).rejects.toBeDefined();
    expect(normalizeTxInput({ to, type: '0x2' })).toMatchObject({ type: '0x2' });
  });
});
