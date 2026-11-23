// "Gas sponsorship" (D843) as the browser runs public/app.js (boot.ts), over the Worker's own answers for the preview
// scenarios (test-spa/preview-status.ts runs src/status.ts and src/evm-relay.ts): the tile in each state in plain
// words, its issue with numbered steps, the detail page (waiting transactions, explorer links, the tools by risk with
// the Advanced ones folded), a tool's confirmation naming its consequence and the exact request it sends, a refusal and
// a stale page said plainly, no browser dialog, and text only.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

type Scenario = 'green' | 'fees-working' | 'fees-paused-money' | 'fees-money-arrived' | 'fees-auto-restarted' | 'fees-money-limit' | 'fees-money-limit-refilled' | 'fees-paused-money-leak' | 'fees-paused-key' | 'fees-low';
type Fake = { status: number; body: unknown };
const MODULE = './preview-status.ts';
const status = {} as Record<Scenario, Record<string, unknown>>;
const detail = {} as Record<Scenario, Fake>;
/** The Worker's answers to the two tool calls the tests make (boot's fetch answers synchronously). */
const acts = {} as Record<'resume' | 'cancel', Fake>;
beforeAll(async () => {
  const m = (await import(MODULE)) as { previewStatus: (s: Scenario) => Promise<Record<string, unknown>>; previewEvmDetail: (s: Scenario) => Promise<Fake>; previewEvmAct: (body: Record<string, unknown>, s: Scenario) => Promise<Fake> };
  for (const s of ['green', 'fees-working', 'fees-paused-money', 'fees-money-arrived', 'fees-auto-restarted', 'fees-money-limit', 'fees-money-limit-refilled', 'fees-paused-money-leak', 'fees-paused-key', 'fees-low'] as const) {
    status[s] = await m.previewStatus(s);
    detail[s] = await m.previewEvmDetail(s);
  }
  const seen = (s: Scenario) => (detail[s].body as { seen: unknown }).seen;
  const token = (s: Scenario) => (detail[s].body as { token: string }).token;
  acts.resume = await m.previewEvmAct({ token: token('fees-paused-money'), tool: 'resume', note: 'Sent 0.1 test ETH from the faucet; balance now 0.1', seen: seen('fees-paused-money') }, 'fees-paused-money');
  acts.cancel = await m.previewEvmAct({ token: token('fees-working'), tool: 'cancel', slot: 42, note: 'Its time limit passed and others wait behind it', seen: seen('fees-working') }, 'fees-working');
});

const openStatus = async (s: Scenario) => {
  const page = boot('/', (c: Call): Answer => (c.path === '/api/status' ? { body: status[s] } : { status: 404, body: { error: { code: 'not_found' } } }));
  await vi.waitFor(() => expect(page.main().querySelector('.verdict')).not.toBeNull());
  return page;
};
const feesTile = (p: Awaited<ReturnType<typeof openStatus>>) => [...p.main().querySelectorAll('.tile')].find((t) => (t.querySelector('h3')?.textContent ?? '').startsWith('Gas sponsorship'))!;

describe('the System status tile', () => {
  it('each state in plain words: Working, Paused: needs a person, Low on money, Not set up', async () => {
    const want: [Scenario, string, string, string][] = [
      ['fees-working', 'Working', 'tile ok', 'Gas sponsorship (Base Sepolia)'],
      ['fees-paused-money', 'Paused: needs money', 'tile critical wide', 'Gas sponsorship (Base Sepolia)'],
      ['fees-money-arrived', 'Restarting by itself', 'tile warning wide', 'Gas sponsorship (Base Sepolia)'],
      ['fees-auto-restarted', 'Working', 'tile ok', 'Gas sponsorship (Base Sepolia)'],
      ['fees-money-limit', 'Paused: needs a person', 'tile critical wide', 'Gas sponsorship (Base Sepolia)'],
      ['fees-paused-key', 'Paused: needs a person', 'tile critical wide', 'Gas sponsorship (Base Sepolia)'],
      ['fees-low', 'Low on money', 'tile warning wide', 'Gas sponsorship (Base Sepolia)'],
      ['green', 'Not set up', 'tile off', 'Gas sponsorship'],
    ];
    for (const [s, chip, cls, name] of want) {
      const p = await openStatus(s);
      const t = feesTile(p);
      expect([t.querySelector('.state-chip')!.textContent, t.className, t.querySelector('h3')!.textContent], s).toEqual([chip, cls, name]);
      expect(t.querySelector('a')?.getAttribute('href') ?? null, s).toBe(s === 'green' ? null : '/gas-sponsorship/84532');
      await closeWindow();
    }
  });

  it('paused for money, before the refill (D890): the safety check, the least to send and where, then it restarts by itself', async () => {
    const p = await openStatus('fees-paused-money');
    const t = feesTile(p);
    expect(t.querySelector('.explain-why')!.textContent).toBe('The relayer wallet is out of money, so gas sponsorship is paused for everyone. It restarts by itself once the wallet has enough.');
    expect([...t.querySelectorAll('.explain-steps li')].map((li) => li.textContent)).toEqual([
      'Open the relayer wallet on Basescan (its address is below). If money went out in transfers nobody at Journear made, stop: tell an engineer now and don’t send money.',
      'Send at least 0.0532 test ETH to the relayer wallet (0x7aD3…f640; its whole address is below) from a Base Sepolia faucet (docs.base.org, “Network faucets”). That is the least it needs to restart by itself. A day of gas sponsorship can use up to 0.02 test ETH.',
      'It restarts by itself within about a minute of the money arriving. You don’t need to press Resume.',
      'Send it once. The balance on this page can be up to 30 s old: press Check again to see the new amount before you send more.',
    ]);
    expect(t.querySelector('.engineer-code')!.textContent).toBe('Code for engineers: relayer_cannot_send · insufficient_funds · slot 42');
    // The lines' chips in plain words too.
    expect([...t.querySelectorAll('.tile-lines li')].map((li) => [li.querySelector('.tile-line-label')!.textContent, li.querySelector('.state-chip')!.textContent])).toEqual([
      ['Relayer wallet', 'OK'],
      ['Money in the wallet', 'Problem'],
      ['Spent today', 'OK'],
      ['Waiting to go through', 'Needs a look'],
      ['Account helper program', 'OK'],
      ['Last staff action', 'OK'],
      ['Restarts by itself', 'OK'],
    ]);
    // The issue at the top: the same sentence, its steps, its playbook; the money asked for once (no "running low" beside it).
    const issues = [...p.main().querySelectorAll('.issue')].filter((i) => i.textContent!.includes('Gas sponsorship (Base Sepolia)'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.querySelectorAll('.issue-steps li')).toHaveLength(4);
    expect(issues[0]!.querySelector('.issue-links')!.textContent).toContain('Playbook: Gas sponsorship is paused or slow');
  });

  it('the money there (D890): the wallet has money again and it is restarting; nothing asks for money', async () => {
    const t = feesTile(await openStatus('fees-money-arrived'));
    expect(t.querySelector('.explain-why')!.textContent).toBe('The relayer wallet has money again (0.25 test ETH). Gas sponsorship restarts by itself within about a minute.');
    expect([...t.querySelectorAll('.explain-steps li')].map((li) => li.textContent)).toEqual(['Nothing to do: don’t send more money, and you don’t need to press Resume.', 'If it still says this after 2 minutes, press Check again. If it is still paused then, press Resume on the Gas sponsorship page.']);
    expect(t.textContent).not.toMatch(/Send at least|faucet/u);
  });

  it('restarted by itself (D890): Working, with “Restarted by itself after a refill, 4 s ago” where the last staff action shows', async () => {
    const t = feesTile(await openStatus('fees-auto-restarted'));
    const line = [...t.querySelectorAll('.tile-lines li')].find((li) => li.querySelector('.tile-line-label')!.textContent === 'Last restart')!;
    expect(line.textContent).toMatch(/Restarted by itself after a refill, \d s ago \(1 of 3 today\)/u);
    expect(t.querySelector('.explain')).toBeNull();
  });

  it('the daily limit used (D890): before the money, Resume’s minimum and Resume; after it, Resume and no more money', async () => {
    const before = feesTile(await openStatus('fees-money-limit'));
    expect(before.querySelector('.explain-why')!.textContent).toBe('The relayer wallet is out of money, so gas sponsorship is paused for everyone. It can’t restart by itself this time: it has already restarted by itself 3 times today (UTC), the most it may.');
    expect([...before.querySelectorAll('.explain-steps li')].map((li) => li.textContent)).toContain('Then press Resume on the Gas sponsorship page.');
    await closeWindow();
    const after = feesTile(await openStatus('fees-money-limit-refilled'));
    expect(after.querySelector('.explain-why')!.textContent).toBe('The relayer wallet has money again (0.25 test ETH), but gas sponsorship can’t restart by itself: it has already restarted by itself 3 times today (UTC), the most it may.');
    expect([...after.querySelectorAll('.explain-steps li')].map((li) => li.textContent)).toEqual(['Don’t send more money.', 'Open the relayer wallet on Basescan (its address is below). If money went out in transfers nobody at Journear made, stop: tell an engineer now.', 'Then press Resume on the Gas sponsorship page.']);
  });

  it('“Check again” on the tile (D890): a fresh read past the page’s 30 s cache; the answer says when it was too soon; an old reading says so', async () => {
    const old = { ...status['fees-paused-money'], checkedAt: Date.now() - 20_000, cached: true, ageMs: 20_000 };
    const fresh = { ...status['fees-money-arrived'], fresh: { refused: false } };
    const soon = { ...status['fees-money-arrived'], cached: true, fresh: { refused: true, retryInMs: 6_000 } };
    const answers = [old, fresh, soon];
    const p = boot('/', (c: Call): Answer => (c.path.startsWith('/api/status') ? { body: answers.shift() } : { status: 404, body: {} }));
    await vi.waitFor(() => expect(p.main().querySelector('.verdict')).not.toBeNull());
    const t = feesTile(p);
    // Its reading is 20 s old (past 15 s): said on the tile.
    const stale = t.querySelector('.tile-stale') as unknown as HTMLElement;
    expect(stale.hidden).toBe(false);
    expect(stale.textContent).toMatch(/^This reading is from 20 s ago\. Money sent since then shows after Check again\.$/u);
    // Only the Gas sponsorship tile has its own button.
    expect(p.main().querySelectorAll('.tile-check')).toHaveLength(1);
    (t.querySelector('.tile-check') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(feesTile(p).querySelector('.state-chip')!.textContent).toBe('Restarting by itself'));
    expect(p.api().filter((c) => c.path.startsWith('/api/status')).map((c) => c.path)).toEqual(['/api/status', '/api/status?fresh=1']);
    expect(p.main().textContent).toContain('A fresh reading: every part was read again just now.');
    expect((feesTile(p).querySelector('.tile-stale') as unknown as HTMLElement).hidden).toBe(true);
    // Pressed again too soon: the last fresh reading, and when the next one can be taken.
    (feesTile(p).querySelector('.tile-check') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(p.main().textContent).toContain('The next fresh reading can be taken in 6 s.'));
    // The page's own button still reads the cached page.
    const pageCheck = [...p.main().querySelectorAll('button')].find((b) => b.textContent === 'Check again' && !b.classList.contains('tile-check'))!;
    expect(pageCheck).toBeDefined();
  });

  it('paused because the key is used elsewhere: the engineer first', async () => {
    const t = feesTile(await openStatus('fees-paused-key'));
    expect(t.querySelector('.explain-why')!.textContent).toBe('The network shows more transactions from the relayer’s wallet than the relayer sent: someone else is using its key.');
    const steps = [...t.querySelectorAll('.explain-steps li')].map((li) => li.textContent);
    expect(steps[0]).toBe('Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.');
    expect(steps.at(-1)).toBe('Don’t press Resume until the engineer says the key is safe or replaced. Resume then asks you to confirm that.');
    expect(steps.join(' ')).not.toMatch(/faucet/u);
  });
});

// ---- the detail page ----

/** The detail page; each read after the first carries a new one-time token (as the Worker issues one per read). */
function openDetail(s: Scenario, onAct?: (c: Call) => Answer) {
  const acts: Call[] = [];
  let reads = 0;
  const page = boot('/gas-sponsorship/84532', (c: Call): Answer => {
    if (c.path === '/api/evm-relay/84532' && c.method === 'GET') {
      const d = detail[s] as { status: number; body: { token: string } };
      return (reads++ === 0 ? d : { ...d, body: { ...d.body, token: `evmact_${String(reads).padStart(22, 'r')}` } }) as Answer;
    }
    if (c.path === '/api/evm-relay/84532/act') {
      acts.push(c);
      return onAct ? onAct(c) : { status: 500, body: {} };
    }
    return { status: 404, body: { error: { code: 'not_found' } } };
  });
  return { ...page, acts };
}
const ready = async (p: ReturnType<typeof openDetail>) => vi.waitFor(() => expect(p.main().querySelector('h1')?.textContent).toBe('Gas sponsorship (Base Sepolia)'));

describe('the Gas sponsorship page', () => {
  it('D890: paused for money, Resume says it isn’t needed (it restarts by itself) but still works; the restart shows in the staff log as the relayer’s own', async () => {
    const p = openDetail('fees-paused-money');
    await ready(p);
    const tool = [...p.main().querySelectorAll('.tool')].find((t) => t.querySelector('h3')!.textContent === 'Resume')!;
    expect(tool.textContent).toContain('You don’t need Resume for this pause: it restarts by itself within about a minute of the money arriving. Resume still works if you want it to restart now.');
    expect(tool.querySelector('form')).not.toBeNull();
    await closeWindow();
    const limited = openDetail('fees-money-limit');
    await ready(limited);
    expect(limited.main().textContent).not.toContain('You don’t need Resume for this pause');
    await closeWindow();
    const done = openDetail('fees-auto-restarted');
    await ready(done);
    const row = [...done.main().querySelectorAll('tr')].find((r) => r.textContent!.includes('Restarted by itself after a refill'))!;
    expect(row.textContent).toContain('The relayer itself');
    expect(row.textContent).toContain('Trusted endpoint: balance 250000000000000000 wei');
  });

  it('the state, the wallet with its explorer link, the waiting transactions with their links, the staff log', async () => {
    const p = openDetail('fees-working');
    await ready(p);
    expect(p.main().querySelector('.evm-state .state-chip')!.textContent).toBe('Working');
    const rows = [...p.main().querySelectorAll('tbody')][0]!.querySelectorAll('tr');
    expect([...rows].map((r) => [...r.querySelectorAll('td')].slice(0, 2).map((td) => td.textContent))).toEqual([
      ['41', 'Journear demo'],
      ['42', 'Journear stamps'],
      ['43', 'Journear demo'],
    ]);
    expect(rows[0]!.textContent).toContain('On the network, being confirmed');
    expect(rows[2]!.textContent).toContain('Not yet picked up by the network');
    // A slot on the network has no Cancel; the others have one.
    // Cancel only past the time limit: slot 42's has passed; slot 43's hasn't, and its row says when Cancel shows.
    expect([...rows].map((r) => !!r.querySelector('button'))).toEqual([false, true, false]);
    expect(rows[2]!.textContent).toContain('Cancel shows once its time limit has passed.');
    const links = [...p.main().querySelectorAll('a[target=_blank]')].map((a) => a.getAttribute('href'));
    expect(links[0]).toBe('https://sepolia.basescan.org/address/0x7aD3c18E50fB2a6D9e4C31b0F5A7E8c2d1B9f640');
    expect(links.slice(1).every((h) => /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/u.test(h!))).toBe(true);
    for (const a of p.main().querySelectorAll('a[target=_blank]')) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(p.text()).toContain('Recent staff actions');
    expect(p.text()).toContain('Time limit long gone; slot 39 waiting behind it');
    // Resume isn't offered while it runs; the Advanced tools are folded and warned about.
    expect(p.buttons('Resume')).toEqual([]);
    expect(p.text()).toContain('Not needed now: gas sponsorship isn’t paused.');
    const adv = p.main().querySelector('details.advanced')!;
    expect(adv.hasAttribute('open')).toBe(false);
    expect(adv.querySelector('summary')!.textContent).toBe('Advanced: rarely needed');
    expect(adv.textContent).toContain('Only when someone else has used the relayer’s key');
    // Nothing secret or about a user on the page.
    expect(p.text()).not.toMatch(/0x1111|private|raw|signature|account 0x/iu);
  });

  it('Resume: a note, a confirmation naming what happens, the exact request, then the answer on top', async () => {
    const p = openDetail('fees-paused-money', () => ({ body: acts.resume.body }));
    await ready(p);
    const tool = [...p.main().querySelectorAll('.tool')].find((t) => t.querySelector('h3')!.textContent === 'Resume')!;
    const input = tool.querySelector('input[name=note]') as unknown as HTMLInputElement;
    // Without a note nothing is asked or sent.
    p.submit(tool.querySelector('form'));
    expect(p.acts).toEqual([]);
    expect(tool.querySelector('.confirm')).toBeNull();
    input.value = 'Sent 0.1 test ETH from the faucet; balance now 0.1';
    p.submit(tool.querySelector('form'));
    const confirm = tool.querySelector('.confirm')!;
    expect(confirm.textContent).toContain('Resume gas sponsorship? The relayer checks the network first, and says no if the problem is still there.');
    expect(p.acts).toEqual([]);
    (confirm.querySelector('button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(p.acts).toHaveLength(1));
    const d = detail['fees-paused-money'].body as { seen: unknown; token: string };
    expect(p.acts[0]!.body).toEqual({ token: d.token, tool: 'resume', note: 'Sent 0.1 test ETH from the faucet; balance now 0.1', seen: d.seen });
    expect(d.token).toMatch(/^evmact_[A-Za-z0-9_-]{22}$/u);
    // Resume is never "always safe": it says what it can't tell.
    expect(tool.textContent).toContain('It can’t tell whether its key is safe');
    expect(p.acts[0]!.headers['x-hana-admin']).toBe('1');
    await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
    expect(p.main().querySelector('.act-result')!.textContent).toContain('Resume: doneGas sponsorship is running again.');
    expect(p.dialogs).toEqual([]);
  });

  it('Cancel on a slot: the consequence named, and a refusal said plainly with its code for engineers', async () => {
    const p = openDetail('fees-working', () => ({ body: acts.cancel.body }));
    await ready(p);
    p.button('Cancel…').click();
    const cell = p.main().querySelector('td .inline-action')!;
    (cell.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'Its time limit passed and others wait behind it';
    p.submit(cell.querySelector('form'));
    expect(cell.querySelector('.confirm')!.textContent).toContain('Cancel slot 42? The user’s action in this slot won’t happen, and that can’t be undone.');
    (cell.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
    expect(p.acts[0]!.body).toMatchObject({ tool: 'cancel', slot: 42 });
    const r = p.main().querySelector('.act-result')!.textContent!;
    expect(r).toContain('Cancel this slot: the relayer said no. Nothing was changed.');
    expect(r).toContain('Slot 42 is already used on the network. Wait: it finishes by itself.');
    expect(r).toContain('Code for engineers: nonce_mined');
  });

  it('a stale page (or any refused, conflicting or unclear answer): nothing is retried; the page reads a fresh view and token before the next send (D843 re-check L3)', async () => {
    const answers: Answer[] = [
      { status: 409, body: { error: { code: 'version_conflict', message: 'The relayer changed since you opened this page (someone may have acted, or it paused again). Nothing was done. Reload the page and look again.' } } },
      { status: 503, body: { error: { code: 'upstream_unavailable', message: 'The API did not answer' } } },
      { body: acts.resume.body },
    ];
    const p = openDetail('fees-paused-money', () => answers.shift()!);
    await ready(p);
    const reads = () => p.calls.filter((c) => c.path === '/api/evm-relay/84532' && c.method === 'GET').length;
    const send = async (n: number) => {
      const tool = [...p.main().querySelectorAll('.tool')].find((t) => t.querySelector('h3')!.textContent === 'Resume')!;
      (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'Sent 0.1 test ETH from the faucet';
      p.submit(tool.querySelector('form'));
      (tool.querySelector('.confirm button') as unknown as HTMLButtonElement).click();
      await vi.waitFor(() => expect(p.acts).toHaveLength(n));
      await vi.waitFor(() => expect(reads()).toBe(n + 1));
      await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
      return p.main().querySelector('.act-result')!.textContent!;
    };
    expect(reads()).toBe(1);
    const first = await send(1);
    expect(first).toContain('Resume: Someone changed this first');
    expect(first).toContain('Reload the page to see the latest version, then try again. The page has been read again.');
    expect(first).toContain('Code for engineers: version_conflict');
    const second = await send(2);
    expect(second).toContain('Code for engineers: upstream_unavailable');
    await send(3);
    // Each send carried the token of the read before it: never one already used.
    const tokens = p.acts.map((a) => (a.body as { token: string }).token);
    expect(new Set(tokens).size).toBe(3);
    expect(tokens[0]).toBe((detail['fees-paused-money'].body as { token: string }).token);
    expect(tokens.slice(1)).toEqual(['evmact_rrrrrrrrrrrrrrrrrrrrr2', 'evmact_rrrrrrrrrrrrrrrrrrrrr3']);
    expect(p.dialogs).toEqual([]);
  });

  it('a pause that means the key may be someone else’s: Resume isn’t primary, needs the engineer’s confirmation, and says so', async () => {
    const p = openDetail('fees-paused-key', () => ({ status: 500, body: {} }));
    await ready(p);
    const tool = [...p.main().querySelectorAll('.tool')].find((t) => t.querySelector('h3')!.textContent === 'Resume')!;
    expect(tool.querySelector('.jp-btn-primary')).toBeNull();
    expect(tool.textContent).toContain('Only after the engineer says so');
    const box = tool.querySelector('input[name=keyConfirmed]') as unknown as HTMLInputElement;
    expect(box).not.toBeNull();
    (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'Ana (engineer) replaced the key and moved the money';
    // Not ticked: nothing is sent; the page says to confirm first.
    p.submit(tool.querySelector('form'));
    expect(tool.querySelector('.confirm')!.textContent).toContain('on the engineer’s word that the key is safe or replaced');
    (tool.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tool.textContent).toContain('Confirm what the engineer said first'));
    expect(p.acts).toEqual([]);
    // Ticked: sent with keyConfirmed.
    box.checked = true;
    p.submit(tool.querySelector('form'));
    (tool.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(p.acts).toHaveLength(1));
    expect(p.acts[0]!.body).toMatchObject({ tool: 'resume', keyConfirmed: true });
    // "Set the next slot number": the network's own count, pre-filled and said.
    const adopt = [...p.main().querySelectorAll('details.advanced .tool')].find((t) => t.querySelector('h3')!.textContent === 'Set the next slot number')!;
    expect(adopt.textContent).toContain('The network says the next slot number is 47.');
    expect((adopt.querySelector('input[name=slot]') as unknown as HTMLInputElement).value).toBe('47');
    expect(adopt.textContent).not.toMatch(/block explorer/u);
  });

  it('D843 re-check M: paused for money, then a sign of a leaked key seen (the relayer’s mark): the engineer first, no refill, Resume needs the confirmation', async () => {
    const p = openDetail('fees-paused-money-leak', () => ({ status: 500, body: {} }));
    await ready(p);
    const now = p.main().querySelector('.explain-why')!.textContent!;
    expect(now).toContain('it is out of money. Since it stopped, the relayer has seen something that may mean someone else is using its key');
    const steps = [...p.main().querySelectorAll('.explain-steps li')].map((li) => li.textContent);
    expect(steps[0]).toBe('Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.');
    expect(steps.join(' ')).not.toMatch(/Send at least|faucet/u);
    expect(p.main().textContent).toContain('Code for engineers: relayer_cannot_send · insufficient_funds · slot 42 · leak_seen');
    const tool = [...p.main().querySelectorAll('.tool')].find((t) => t.querySelector('h3')!.textContent === 'Resume')!;
    expect(tool.querySelector('.jp-btn-primary')).toBeNull();
    expect(tool.querySelector('input[name=keyConfirmed]')).not.toBeNull();
  });

  it('the Advanced tools: each with its warning and its own confirmation; a tool that can’t apply says why instead', async () => {
    const p = openDetail('fees-paused-money');
    await ready(p);
    const adv = p.main().querySelector('details.advanced')!;
    const tools = [...adv.querySelectorAll('.tool')].map((t) => t.querySelector('h3')!.textContent);
    expect(tools).toEqual(['Fill a gap', 'Close as “used by something else”', 'Set the next slot number']);
    // Transactions wait: setting the next slot number would certainly be refused, so it isn't offered.
    expect(adv.textContent).toContain('Not possible now: wait until nothing is waiting.');
    const fill = [...adv.querySelectorAll('.tool')][0]!;
    (fill.querySelector('input[name=slot]') as unknown as HTMLInputElement).value = '41';
    (fill.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'Slot 41 is empty after a transaction we did not send';
    p.submit(fill.querySelector('form'));
    expect(fill.querySelector('.confirm')!.textContent).toContain('Fill slot 41 with a harmless empty transfer? It costs a little ETH for gas, from the relayer wallet.');
  });

  it('text only: a hostile note or app name stays text', async () => {
    const d = structuredClone(detail['fees-working']) as Fake & { body: { staffLog: { note: string }[]; records: { app: string }[] } };
    d.body.staffLog[0]!.note = '<img src=x onerror=alert(1)>';
    d.body.records[0]!.app = '<script>alert(1)</script>';
    const p = boot('/gas-sponsorship/84532', (c) => (c.path === '/api/evm-relay/84532' ? (d as Answer) : { status: 404, body: {} }));
    await vi.waitFor(() => expect(p.main().querySelector('h1')).not.toBeNull());
    expect(p.main().querySelector('img, script')).toBeNull();
    expect(p.text()).toContain('<img src=x onerror=alert(1)>');
    expect(p.text()).toContain('<script>alert(1)</script>');
  });

  it('staff’s name for it (D879): the subtitle says who pays the gas; the old path is no page and reads nothing', async () => {
    const p = openDetail('fees-working');
    await ready(p);
    expect(p.main().querySelector('.page-head, header')?.textContent ?? p.text()).toContain('Journear pays users’ gas on Base Sepolia through its relayer.');
    expect(p.text()).not.toMatch(/free network fee/iu);
    await closeWindow();
    const old = boot('/free-network-fees/84532', () => ({ status: 404, body: { error: { code: 'not_found' } } }));
    await vi.waitFor(() => expect(old.main().querySelector('h1')?.textContent).toBe('Page not found'));
    expect(old.api()).toEqual([]);
  });

  it('an env without sponsorship: the API’s not found is said in plain words', async () => {
    const p = openDetail('green');
    await vi.waitFor(() => expect(p.main().querySelector('.jp-alert-danger')).not.toBeNull());
    expect(p.text()).toContain('Not found');
  });
});

// ---- the users' term stays on the users' side (D879) ----

describe('no "free network fees" on the staff side (D879)', () => {
  const OLD = /free.network.fee/iu;
  it('every preview scenario: the status answer, the detail answer and the rendered status and detail pages', async () => {
    const m = (await import(MODULE)) as { SCENARIOS: readonly string[]; previewStatus: (s: string) => Promise<Record<string, unknown>>; previewEvmDetail: (s: string) => Promise<Fake> };
    expect(m.SCENARIOS.length).toBeGreaterThan(10);
    for (const s of m.SCENARIOS) {
      const st = await m.previewStatus(s);
      const de = await m.previewEvmDetail(s);
      expect(JSON.stringify(st), s).not.toMatch(OLD);
      expect(JSON.stringify(de.body), s).not.toMatch(OLD);
      const sp = boot('/', (c: Call): Answer => (c.path === '/api/status' ? { body: st } : { status: 404, body: { error: { code: 'not_found' } } }));
      await vi.waitFor(() => expect(sp.main().querySelector('.verdict')).not.toBeNull());
      expect(sp.text(), s).not.toMatch(OLD);
      await closeWindow();
      if (de.status !== 200) continue;
      const dp = boot('/gas-sponsorship/84532', (c: Call): Answer => (c.path === '/api/evm-relay/84532' ? (de as Answer) : { status: 404, body: { error: { code: 'not_found' } } }));
      await vi.waitFor(() => expect(dp.main().querySelector('h1')?.textContent).toBe('Gas sponsorship (Base Sepolia)'));
      // The text includes the folded Advanced tools and every confirmation's words (in the page's source below).
      expect(dp.text(), s).not.toMatch(OLD);
      await closeWindow();
    }
  });

  it('the eight gas sponsorship playbooks and event titles (D890’s restart included), and the page’s own code', async () => {
    const { PLAYBOOKS } = await import('@hana-id/playbooks');
    const { SECURITY_EVENT_TITLES } = await import('@hana-id/console-core');
    const evmPlaybooks = PLAYBOOKS.filter((p) => p.id.startsWith('evm-'));
    const evmTitles = Object.entries(SECURITY_EVENT_TITLES).filter(([k]) => k.startsWith('evm_'));
    expect([evmPlaybooks.length, evmTitles.length]).toEqual([8, 8]);
    for (const p of evmPlaybooks) {
      expect(JSON.stringify(p), p.id).not.toMatch(OLD);
      expect(p.title, p.id).toMatch(/^Gas sponsorship/u);
    }
    for (const [k, t] of evmTitles) expect(t, k).toMatch(/^Gas sponsorship: /u);
    // The page's code (tool texts, confirmations shown only on a press): the term only in the comment that names D879.
    const { SRC } = await import('./boot.ts');
    const page = SRC.slice(SRC.indexOf('// ---- Gas sponsorship (D843'), SRC.indexOf('async function evmRelayPage'));
    expect(page.length).toBeGreaterThan(1000);
    expect(page).not.toMatch(OLD);
  });
});
