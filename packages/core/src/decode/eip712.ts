// Display tree for EIP-712 typed data: the approval popup renders this, walked from `primaryType` over the object
// normalizeTypedData returned (the same object the vault hashes), so what is shown is what is signed.
import {
  type NormalizedTypedData,
  type ParsedTypedDataType,
  type TypedDataStruct,
  type TypedDataValue,
  parseTypedDataType,
} from '../typed-data.ts';

export type TypedDataNode =
  /** An atomic value rendered as text: decimal integers, `true`/`false`, EIP-55 addresses, `0x` hex, strings. */
  | { readonly name: string; readonly type: string; readonly value: string }
  /** A struct or array, with its fields (or elements, named `[i]`) in order. */
  | { readonly name: string; readonly type: string; readonly children: readonly TypedDataNode[] };

export interface TypedDataView {
  /** The domain's declared fields, in order. */
  readonly domain: readonly TypedDataNode[];
  readonly primaryType: string;
  /** The message, as one struct node named after `primaryType`. */
  readonly message: TypedDataNode;
}

function node(
  data: NormalizedTypedData,
  structs: ReadonlySet<string>,
  name: string,
  type: string,
  t: ParsedTypedDataType,
  v: TypedDataValue,
): TypedDataNode {
  if (t.kind === 'struct') return { name, type, children: fields(data, structs, t.name, v as TypedDataStruct) };
  if (t.kind === 'array') {
    const elementType = type.slice(0, type.lastIndexOf('['));
    return {
      name,
      type,
      children: (v as readonly TypedDataValue[]).map((e, i) =>
        node(data, structs, `[${i}]`, elementType, t.element, e),
      ),
    };
  }
  return { name, type, value: typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : (v as string) };
}

function fields(data: NormalizedTypedData, structs: ReadonlySet<string>, typeName: string, v: TypedDataStruct) {
  return (data.types[typeName] ?? []).map((f) =>
    node(data, structs, f.name, f.type, parseTypedDataType(f.type, structs), v[f.name] as TypedDataValue),
  );
}

/** The tree the approval popup renders for normalized typed data. */
export function typedDataView(data: NormalizedTypedData): TypedDataView {
  const structs = new Set(Object.keys(data.types));
  return {
    domain: fields(data, structs, 'EIP712Domain', data.domain),
    primaryType: data.primaryType,
    message: {
      name: data.primaryType,
      type: data.primaryType,
      children: fields(data, structs, data.primaryType, data.message),
    },
  };
}
