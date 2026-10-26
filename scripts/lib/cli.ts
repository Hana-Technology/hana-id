// Tiny argument parser over node:util parseArgs: positionals, string flags (optionally repeatable) and booleans.
import { parseArgs } from 'node:util';

export interface CliSpec {
  /** Flags that take a value (`--name x` or `--name=x`). */
  strings?: readonly string[];
  /** Value flags that may repeat; collected in order. */
  multiple?: readonly string[];
  /** On/off flags. */
  booleans?: readonly string[];
}

export class CliError extends Error {}

export class Args {
  constructor(
    readonly positionals: string[],
    private readonly values: Record<string, string | string[] | boolean | undefined>,
  ) {}

  flag(name: string): boolean {
    return this.values[name] === true;
  }

  str(name: string): string | undefined {
    const v = this.values[name];
    if (Array.isArray(v)) return v[v.length - 1];
    return typeof v === 'string' ? v : undefined;
  }

  required(name: string): string {
    const v = this.str(name);
    if (v === undefined || v === '') throw new CliError(`--${name} is required`);
    return v;
  }

  list(name: string): string[] {
    const v = this.values[name];
    if (Array.isArray(v)) return v;
    return typeof v === 'string' ? [v] : [];
  }

  /** A positive integer flag, or the default. */
  int(name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
    const v = this.str(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/u.test(v)) throw new CliError(`--${name} must be an integer`);
    const n = Number(v);
    if (n < min || n > max) throw new CliError(`--${name} must be between ${min} and ${max}`);
    return n;
  }
}

/** Parses argv (without node and script path). Unknown flags are an error. */
export function parseCli(argv: readonly string[], spec: CliSpec): Args {
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
  for (const n of spec.strings ?? []) options[n] = { type: 'string' };
  for (const n of spec.multiple ?? []) options[n] = { type: 'string', multiple: true };
  for (const n of spec.booleans ?? []) options[n] = { type: 'boolean' };
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return new Args(positionals, values as Record<string, string | string[] | boolean | undefined>);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

/** Runs a script's main, printing CliError/Error messages (never stack traces with argument values) and exiting 1. */
export function run(main: () => Promise<void>, usage: string): void {
  main().catch((err: unknown) => {
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}\n\n${usage}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  });
}
