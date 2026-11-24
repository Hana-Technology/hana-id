// Duplicate keys in a manifest (D904, after PR 133's review). `JSON.parse` keeps the last of two equal keys without a
// word, so `{"a": "FastNear", "b": "FastNear", "c": "dRPC", "b": "Lava"}` reads as three operators while a reviewer
// skimming the file sees FastNear twice. Review is the control for the manifest's declarations, so a manifest with a
// key twice in any object, at any depth, is refused. Keys are compared as JSON reads them ("a" and "a" are one).

/**
 * Where `text` (valid JSON: parse it first) first repeats a key in one object, as a path ("ckdSourceOperators.b",
 * "near.relay.receivers[0].x", `$` for the top level), or null.
 */
export function duplicateJsonKey(text: string): string | null {
  type Frame = { kind: 'object'; path: string; keys: Set<string>; expectKey: boolean; key: string } | { kind: 'array'; path: string; index: number };
  const stack: Frame[] = [];
  const childPath = (): string => {
    const top = stack.at(-1);
    if (top === undefined) return '$';
    if (top.kind === 'array') return `${top.path}[${top.index}]`;
    const name = /^[A-Za-z_$][\w$]*$/u.test(top.key) ? top.key : JSON.stringify(top.key);
    return top.path === '$' ? name : `${top.path}.${name}`;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        top.key = key;
        if (top.keys.has(key)) return childPath();
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === '{') {
      stack.push({ kind: 'object', path: childPath(), keys: new Set(), expectKey: true, key: '' });
    } else if (c === '[') {
      stack.push({ kind: 'array', path: childPath(), index: 0 });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const top = stack.at(-1);
      if (top?.kind === 'object') top.expectKey = true;
      else if (top?.kind === 'array') top.index++;
    }
  }
  return null;
}
