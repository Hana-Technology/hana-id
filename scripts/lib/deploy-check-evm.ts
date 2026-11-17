// deploy-check's `evm` group (D849): only for an env whose manifest has `evm.sponsor` (an env without it reads nothing
// here and prints nothing new). Per sponsored chain, read-only JSON-RPC to the manifest's RPCs:
//
//   - each RPC (and the fallback) answers eth_chainId with the chain's id;
//   - the manifest's `delegate` is the artifact's CREATE2 address, core pins it (address and runtime code hash, not a
//     placeholder), and the code at it hashes to the artifact's runtime code hash;
//   - the relayer (`relayerAddress`) holds at least one transaction's worst case (`maxGasPerTx` × `maxFeePerGasGwei`;
//     less is a failure: every send would fail) and, as a warning, at least `lowBalanceEth`;
//   - every allowlisted target on the chain has code.
//
// It prints the RPCs by scheme and host only (rpcLabel), addresses, hashes and balances: all public.
import { type EvmSponsor, type PinnedSponsorDelegates, sponsorDecimalUnits } from '@hana-id/env';
import { loadDelegateArtifact, keccakHex } from './evm-delegate-artifacts.ts';
import { evmRpc } from './evm-rpc.ts';

/** Core's pinned table in the shape deploy-check needs (SPONSOR_DELEGATES has both fields). */
export type PinnedDelegatesWithHash = Readonly<Record<number, PinnedSponsorDelegates[number] & { readonly runtimeCodeHash?: string }>>;

export interface EvmCheckResult {
  lines: string[];
  failures: string[];
  warnings: string[];
}

/** wei as ETH, with no trailing zeros (`0.05`, `1`). */
export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''} ETH`;
}

/** The checks of every sponsored chain, one after another. Never throws for what the chain answers: each is a failure. */
export async function checkEvmSponsor(sponsor: EvmSponsor, opts: { fetch: typeof fetch; pinned: PinnedDelegatesWithHash; root?: string }): Promise<EvmCheckResult> {
  const out: EvmCheckResult = { lines: [], failures: [], warnings: [] };
  const artifact = loadDelegateArtifact('HanaDelegateExecutor', opts.root);
  for (const [id, chain] of Object.entries(sponsor.chains)) {
    const chainId = Number(id);
    const tag = `evm ${chainId}`;
    const fail = (s: string) => out.failures.push(`${tag}: ${s}`);
    const rpc = evmRpc(chain.rpc, opts.fetch);
    try {
      const answered = await rpc.chainId();
      if (answered !== chainId) {
        fail(`RPC ${rpc.label} is on chain ${answered}, not ${chainId}`);
        continue;
      }
      out.lines.push(`  ${tag}  RPC ${rpc.label} answers chain ${chainId}`);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    if (chain.rpcFallback !== undefined) {
      const fb = evmRpc(chain.rpcFallback, opts.fetch);
      try {
        const answered = await fb.chainId();
        if (answered !== chainId) fail(`fallback RPC ${fb.label} is on chain ${answered}, not ${chainId}`);
        else out.lines.push(`  ${tag}  fallback RPC ${fb.label} answers chain ${chainId}`);
      } catch (e) {
        out.warnings.push(`${tag}: ${(e as Error).message} (the fallback; sends still go through the primary)`);
      }
    }

    // The delegate: the artifact's address, pinned by core with the artifact's code hash, and that code on chain.
    const delegate = chain.delegate;
    if (delegate.toLowerCase() !== artifact.address.toLowerCase()) fail(`the manifest's delegate ${delegate} is not the artifact's CREATE2 address ${artifact.address}`);
    const pin = Object.hasOwn(opts.pinned, chainId) ? opts.pinned[chainId] : undefined;
    if (!pin) fail(`core pins no delegate for chain ${chainId} (packages/core/src/evm-sponsor/delegates.ts): add the entry deploy-evm-delegate printed`);
    else {
      if (pin.address.toLowerCase() !== delegate.toLowerCase()) fail(`core pins ${pin.address}, the manifest names ${delegate}`);
      if (pin.placeholder) fail("core's entry is a placeholder, not a deployed contract");
      if (pin.runtimeCodeHash !== undefined && pin.runtimeCodeHash !== artifact.runtimeCodeHash) fail(`core pins runtime code hash ${pin.runtimeCodeHash}, the artifact has ${artifact.runtimeCodeHash}`);
    }
    try {
      const code = await rpc.code(delegate);
      const hash = code === '0x' ? null : keccakHex(code);
      if (hash === null) fail(`no code at the delegate ${delegate}: deploy it (deploy-evm-delegate)`);
      else if (hash !== artifact.runtimeCodeHash) fail(`MISMATCH: the delegate ${delegate} has runtime code hash ${hash}, not the artifact's ${artifact.runtimeCodeHash}`);
      else out.lines.push(`  ${tag}  delegate ${delegate} runs the artifact's code (${hash})`);

      // The relayer's funds.
      const balance = await rpc.balance(sponsor.relayerAddress);
      const oneTx = BigInt(chain.maxGasPerTx) * (sponsorDecimalUnits(chain.maxFeePerGasGwei, 9) ?? 0n);
      const low = sponsorDecimalUnits(chain.lowBalanceEth, 18) ?? 0n;
      if (balance < oneTx) fail(`the relayer ${sponsor.relayerAddress} holds ${formatEth(balance)}, less than one transaction's worst case (${formatEth(oneTx)}): every send would fail. Fund it`);
      else if (balance < low) out.warnings.push(`${tag}: the relayer ${sponsor.relayerAddress} holds ${formatEth(balance)}, below lowBalanceEth (${formatEth(low)}): top it up`);
      out.lines.push(`  ${tag}  relayer ${sponsor.relayerAddress} holds ${formatEth(balance)} (low-balance line ${formatEth(low)})`);

      // Every allowlisted target on this chain.
      for (const [app, chains] of Object.entries(sponsor.apps)) {
        for (const t of chains[id] ?? []) {
          if ((await rpc.code(t.address)) === '0x') fail(`${app}'s target ${t.address} (${t.label}) has no code`);
          else out.lines.push(`  ${tag}  ${app} target ${t.address} (${t.label}) has code`);
        }
      }
    } catch (e) {
      fail((e as Error).message);
    }
  }
  return out;
}
