// The UI preview (dev only, never deployed): mounts src/ui with the scripted fixtures of preview/fixtures.ts, to step
// through them, replay the inked animation and switch the theme. `corepack pnpm --filter @hana-id/stamps preview:ui`,
// then http://127.0.0.1:5181/ (?f=<fixture>&theme=light|dark, ?sheet=1 for the enlarged stamps, &shot=1 hides the bar).
import { inkDefs, stampArt } from '../src/ui/art.ts';
import { type PassportView, STAMP_IDS, STAMP_LABELS, mountPassport } from '../src/ui/index.ts';
import { FIXTURES } from './fixtures.ts';
import './preview.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
if (params.has('shot')) document.body.classList.add('pv-shot');

const app = document.getElementById('app')!;
const log = document.getElementById('pv-log')!;
const say = (s: string) => {
  log.textContent = s;
};

if (params.has('sheet')) {
  const sheet = document.createElement('div');
  sheet.className = 'pp pv-sheet';
  sheet.append(inkDefs('sheet'));
  STAMP_IDS.forEach((id, i) => {
    const fig = document.createElement('figure');
    fig.dataset.stamp = id;
    const art = document.createElement('div');
    art.className = 'pp-art';
    art.append(stampArt(id, Date.UTC(2026, 10, 13, 15, 12 + i), 'sheet', STAMP_LABELS[id].title));
    const cap = document.createElement('figcaption');
    cap.textContent = `${id} · ${STAMP_LABELS[id].title}`;
    fig.append(art, cap);
    sheet.append(fig);
  });
  app.append(sheet);
} else {
  const select = document.getElementById('pv-fixture') as HTMLSelectElement;
  for (const f of FIXTURES) select.append(new Option(f.label, f.name));
  let index = Math.max(0, FIXTURES.findIndex((f) => f.name === params.get('f')));
  let ui = mount();

  function mount() {
    return mountPassport(app, {
      signIn: () => say('signIn()'),
      signOut: () => say('signOut()'),
      collect: (id, input) => say(`collect(${JSON.stringify(id)}${input ? `, ${JSON.stringify(input)}` : ''})`),
      copyAccount: () => say('copyAccount()'),
      refresh: () => say('refresh()'),
    });
  }
  function show(i: number) {
    index = (i + FIXTURES.length) % FIXTURES.length;
    select.value = FIXTURES[index]!.name;
    ui.update(FIXTURES[index]!.view);
    const url = new URL(location.href);
    url.searchParams.set('f', FIXTURES[index]!.name);
    history.replaceState(null, '', url);
  }
  select.addEventListener('change', () => show(FIXTURES.findIndex((f) => f.name === select.value)));
  document.getElementById('pv-prev')!.addEventListener('click', () => show(index - 1));
  document.getElementById('pv-next')!.addEventListener('click', () => show(index + 1));
  document.getElementById('pv-ink')!.addEventListener('click', () => {
    // A new mount has never inked anything: every stamp the fixture marks fresh (or, if none, the last collected) plays.
    ui.destroy();
    ui = mount();
    const view = FIXTURES[index]!.view;
    const anyFresh = view.stamps.some((s) => s.status === 'collected' && s.fresh);
    const lastCollected = [...view.stamps].reverse().find((s) => s.status === 'collected');
    const stamps = view.stamps.map((s) => (s.status === 'collected' && (anyFresh ? s.fresh : s === lastCollected) ? { ...s, fresh: true } : s));
    ui.update({ ...view, stamps } as PassportView);
  });
  const themeBtn = document.getElementById('pv-theme')!;
  const themes = ['system', 'light', 'dark'] as const;
  let t = themes.indexOf((document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? 'system');
  themeBtn.textContent = `Theme: ${themes[t]}`;
  themeBtn.addEventListener('click', () => {
    t = (t + 1) % themes.length;
    const name = themes[t]!;
    if (name === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = name;
    themeBtn.textContent = `Theme: ${name}`;
  });
  show(index);
  // Repeated updates, as the site makes them: nothing should flicker or restart.
  setInterval(() => ui.update(FIXTURES[index]!.view), 1000);
}
