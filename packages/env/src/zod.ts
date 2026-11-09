// The one place this workspace imports zod for its schemas: `z`, with zod 3's default error texts (D470). zod 4
// rewrote them all ("Required" became "Invalid input: expected string, received undefined"), and they reach partners:
// the console's "Bad params for …" and the `error` of every API and console RPC refusal are built from `issue.message`.
// A schema's own message (`.regex(re, 'Invalid NEAR account id')`, `.refine(fn, '…')`) never comes here: zod uses it
// first. Anything this map doesn't cover falls through to zod's own text.
//
// `urlString()` is here because zod 4's `.url()` trims and rewrites the value it returns, and accepts strings `new URL`
// would not (a leading no-break space). zod 3 returned the value untouched, and the manifest and the views rely on that.
import { z } from 'zod';

/** zod 3's name for what a value is (ZodParsedType), as the "received" of its messages. */
function received(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : 'number';
  if (v instanceof Date) return 'date';
  if (v instanceof Map) return 'map';
  if (v instanceof Set) return 'set';
  if (v instanceof Promise) return 'promise';
  return typeof v;
}

const quoted = (values: readonly unknown[], separator = ' | '): string => values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(separator);

/** The `int` format check of a schema's checks, when it has one: zod 4 reports Infinity at the number type, before it runs. */
const hasIntCheck = (inst: unknown): boolean => {
  const checks = (inst as { _zod?: { def?: { checks?: { _zod?: { def?: { format?: string } } }[] } } } | undefined)?._zod?.def?.checks;
  return checks?.some((c) => c._zod?.def?.format === 'safeint') ?? false;
};

function isLiteral(inst: unknown): boolean {
  return (inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type === 'literal';
}

/** zod 3's default text for a zod 4 issue, or undefined to fall through to zod 4's own. */
function zod3Message(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Required';
      if (issue.expected === 'int') return `Expected integer, received ${typeof issue.input === 'number' ? 'float' : received(issue.input)}`;
      if (issue.expected === 'number' && typeof issue.input === 'number' && !Number.isNaN(issue.input) && !Number.isFinite(issue.input)) {
        return hasIntCheck(issue.inst) ? 'Expected integer, received float' : 'Number must be finite';
      }
      return `Expected ${issue.expected === 'record' ? 'object' : String(issue.expected)}, received ${received(issue.input)}`;
    }
    case 'invalid_value': {
      const values = issue.values as readonly unknown[];
      if (isLiteral(issue.inst)) return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      if (issue.input === undefined) return 'Required';
      if (typeof issue.input !== 'string') return `Expected ${quoted(values)}, received ${received(issue.input)}`;
      return `Invalid enum value. Expected ${quoted(values)}, received '${issue.input}'`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${quoted(issue.keys as readonly string[], ', ')}`;
    case 'invalid_union':
      return issue.note === 'No matching discriminator' ? `Invalid discriminator value. Expected ${quoted((issue as { options?: readonly unknown[] }).options ?? [])}` : 'Invalid input';
    case 'invalid_key': {
      // zod 3 reported a record key's problem as the key schema's own message.
      const first = (issue as { issues?: readonly { message?: string }[] }).issues?.[0];
      return first?.message;
    }
    case 'invalid_format': {
      const format = (issue as { format?: string }).format;
      if (format === 'regex') return 'Invalid';
      return `Invalid ${format ?? 'input'}`;
    }
    case 'too_small': {
      const { exact, inclusive, minimum, origin } = issue as { exact?: boolean; inclusive?: boolean; minimum: unknown; origin: string };
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
      if (origin === 'number' || origin === 'int') return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
      return undefined;
    }
    case 'too_big': {
      const { exact, inclusive, maximum, origin } = issue as { exact?: boolean; inclusive?: boolean; maximum: unknown; origin: string };
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
      if (origin === 'number' || origin === 'int') return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

z.config({ customError: zod3Message });

type IssueLike = { readonly code?: string | undefined; readonly path: readonly PropertyKey[]; readonly message: string };
const samePath = (a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * The issues as zod 3 listed them, when one list of them is shown to a person: zod 4 runs a length check even on a value
 * of the wrong type (`[]` where a string is due adds "Array must contain…" after "Expected string, received array"), and
 * reports an unsafe integer past a `.max()` twice. So a path whose type was refused keeps only that issue, and an exact
 * repeat goes. `issues[0]` is unaffected: it is the same in both.
 */
export function issuesAsZod3<I extends IssueLike>(issues: readonly I[]): I[] {
  return issues.filter((issue, at) => {
    const earlier = issues.slice(0, at).filter((p) => samePath(p.path, issue.path));
    return !earlier.some((p) => p.code === 'invalid_type' || p.message === issue.message);
  });
}

/**
 * A string `new URL` accepts, returned exactly as given (zod 3's `.url()`; see above). The URL's use decides its
 * protocol: the manifest's `endpointUrlProblem` is what refuses a non-https endpoint.
 */
export const urlString = () =>
  z.string().refine((v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid url');

export { z };
