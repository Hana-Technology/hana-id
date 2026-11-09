import { describe, expect, it } from 'vitest';
import { issuesAsZod3, urlString, z } from './zod.ts';

const message = (schema: z.ZodType, value: unknown): string => schema.safeParse(value).error?.issues[0]?.message ?? '';

describe('zod 3 error texts (D470): what partners and operators read', () => {
  const required = z.object({ a: z.string() }).strict();

  it('a missing key is "Required"', () => {
    expect(required.safeParse({}).error?.issues).toMatchObject([{ path: ['a'], message: 'Required' }]);
  });

  it('wrong types name what zod 3 named', () => {
    expect(message(z.string(), 1)).toBe('Expected string, received number');
    expect(message(z.string(), [])).toBe('Expected string, received array');
    expect(message(z.string(), null)).toBe('Expected string, received null');
    expect(message(z.number(), 'x')).toBe('Expected number, received string');
    expect(message(z.number(), Number.NaN)).toBe('Expected number, received nan');
    expect(message(z.object({}), 1)).toBe('Expected object, received number');
    expect(message(z.array(z.string()), 'x')).toBe('Expected array, received string');
    expect(message(z.boolean(), 'x')).toBe('Expected boolean, received string');
    expect(message(z.record(z.string(), z.string()), 1)).toBe('Expected object, received number');
  });

  it('an integer check names integer and float', () => {
    expect(message(z.number().int(), 1.5)).toBe('Expected integer, received float');
    expect(message(z.number().int(), Infinity)).toBe('Expected integer, received float');
  });

  it('strings, numbers and arrays out of bounds say so as zod 3 did', () => {
    expect(message(z.string().min(2), 'a')).toBe('String must contain at least 2 character(s)');
    expect(message(z.string().max(2), 'abc')).toBe('String must contain at most 2 character(s)');
    expect(message(z.number().min(2), 1)).toBe('Number must be greater than or equal to 2');
    expect(message(z.number().positive(), 0)).toBe('Number must be greater than 0');
    expect(message(z.number().max(2), 3)).toBe('Number must be less than or equal to 2');
    expect(message(z.array(z.string()).min(1), [])).toBe('Array must contain at least 1 element(s)');
    expect(message(z.array(z.string()).max(1), ['a', 'b'])).toBe('Array must contain at most 1 element(s)');
    expect(message(z.array(z.string()).length(2), ['a'])).toBe('Array must contain exactly 2 element(s)');
    expect(message(z.tuple([z.string(), z.string()]), ['a'])).toBe('Array must contain at least 2 element(s)');
  });

  it('formats, literals, enums, unions and unknown keys', () => {
    expect(message(z.string().regex(/^a$/u), 'b')).toBe('Invalid');
    expect(message(z.string().email(), 'nope')).toBe('Invalid email');
    expect(message(z.literal('EC'), 'RSA')).toBe('Invalid literal value, expected "EC"');
    expect(message(z.literal(true), false)).toBe('Invalid literal value, expected true');
    expect(message(z.enum(['a', 'b']), 'c')).toBe("Invalid enum value. Expected 'a' | 'b', received 'c'");
    expect(message(z.enum(['a', 'b']), 1)).toBe("Expected 'a' | 'b', received number");
    expect(message(z.object({ e: z.enum(['a', 'b']) }), {})).toBe('Required');
    expect(message(z.union([z.literal(1), z.literal(2)]), 3)).toBe('Invalid input');
    expect(message(z.object({}).strict(), { x: 1, y: 2 })).toBe("Unrecognized key(s) in object: 'x', 'y'");
    const du = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }).strict(), z.object({ kind: z.literal('b') }).strict()]);
    expect(du.safeParse({ kind: 'c' }).error?.issues).toMatchObject([{ path: ['kind'], message: "Invalid discriminator value. Expected 'a' | 'b'" }]);
    expect(du.safeParse({}).error?.issues).toMatchObject([{ path: ['kind'], message: "Invalid discriminator value. Expected 'a' | 'b'" }]);
  });

  it('a schema’s own message wins over the map', () => {
    expect(message(z.string().regex(/^a$/u, 'Not an a'), 'b')).toBe('Not an a');
    expect(message(z.string().refine((s) => s === 'a', 'Not an a'), 'b')).toBe('Not an a');
  });

  it('a record key’s own message is kept, at the key’s path', () => {
    const r = z.record(z.string().regex(/^a$/u, 'Keys are a'), z.number());
    expect(r.safeParse({ b: 1 }).error?.issues).toMatchObject([{ path: ['b'], message: 'Keys are a' }]);
  });
});

describe('urlString (zod 3’s .url())', () => {
  it('accepts what new URL accepts and returns the value untouched', () => {
    expect(urlString().parse('https://x.example/a?b#c')).toBe('https://x.example/a?b#c');
    expect(urlString().parse('https://x.example ')).toBe('https://x.example ');
    expect(urlString().parse('x:y')).toBe('x:y');
  });

  it('refuses what new URL refuses, with zod 3’s text', () => {
    expect(message(urlString(), 'not a url')).toBe('Invalid url');
    expect(message(urlString(), ' https://x.example')).toBe('Invalid url');
    expect(message(urlString(), '')).toBe('Invalid url');
    expect(message(urlString(), 1)).toBe('Expected string, received number');
  });
});

describe('issuesAsZod3', () => {
  it('keeps only the type issue of a path whose type was refused', () => {
    const r = z.object({ a: z.string().min(1) }).safeParse({ a: [] });
    expect(r.error?.issues.length).toBe(2);
    expect(issuesAsZod3(r.error!.issues).map((i) => i.message)).toEqual(['Expected string, received array']);
  });

  it('drops an exact repeat (an unsafe integer past .max is reported twice), and keeps other issues', () => {
    const r = z.object({ n: z.number().int().max(Number.MAX_SAFE_INTEGER), s: z.string().min(2).regex(/^a+$/u) }).safeParse({ n: 2 ** 53, s: 'b' });
    expect(issuesAsZod3(r.error!.issues).map((i) => `${String(i.path[0])}: ${i.message}`)).toEqual(['n: Number must be less than or equal to 9007199254740991', 's: String must contain at least 2 character(s)', 's: Invalid']);
  });
});
