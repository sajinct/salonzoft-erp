#!/usr/bin/env node
// Offline TypeScript type generator.
//
// Applies the real migrations to an in-memory PGlite database and emits types
// in the same shape as `supabase gen types typescript` for the `public`
// schema. Use `npm run db:types` (Supabase CLI) when a local stack is running;
// use this (`npm run db:types:offline`) when Docker is not available.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../supabase/tests/helpers/db.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps/web/src/app/core/supabase/database.types.ts');

const db = await createDb();

const scalar = (t) => {
  switch (t) {
    case 'bool': return 'boolean';
    case 'int2': case 'int4': case 'int8': case 'float4': case 'float8': case 'numeric': case 'oid': return 'number';
    case 'json': case 'jsonb': return 'Json';
    case 'void': return 'undefined';
    case 'record': return 'Record<string, unknown>';
    default: return 'string';
  }
};
const tsType = (udt) => (udt.startsWith('_') ? `${scalar(udt.slice(1))}[]` : scalar(udt));

// ---- tables --------------------------------------------------------------------
const { rows: cols } = await db.query(`
  select c.table_name, c.column_name, c.udt_name, c.is_nullable = 'YES' as nullable,
         c.column_default is not null as has_default, c.is_identity = 'YES' as is_identity,
         c.identity_generation, c.is_generated = 'ALWAYS' as is_generated, t.table_type
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
  order by c.table_name, c.column_name`);

const { rows: fks } = await db.query(`
  select con.conname, cl.relname as table_name, rcl.relname as referenced_relation,
         array(select a.attname from unnest(con.conkey) k join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k order by a.attname)::text[] as columns,
         array(select a.attname from unnest(con.confkey) k join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k order by a.attname)::text[] as referenced_columns,
         rn.nspname as referenced_schema
  from pg_constraint con
  join pg_class cl on cl.oid = con.conrelid
  join pg_namespace n on n.oid = cl.relnamespace
  join pg_class rcl on rcl.oid = con.confrelid
  join pg_namespace rn on rn.oid = rcl.relnamespace
  where con.contype = 'f' and n.nspname = 'public'
  order by con.conname`);

const tables = new Map();
for (const c of cols) {
  if (!tables.has(c.table_name)) tables.set(c.table_name, { type: c.table_type, cols: [] });
  tables.get(c.table_name).cols.push(c);
}

const indent = (s, n) => s.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

const renderTable = (name, { cols: tcols }) => {
  const row = tcols.map((c) => `${c.column_name}: ${tsType(c.udt_name)}${c.nullable ? ' | null' : ''}`);
  const ins = tcols.map((c) => {
    if (c.is_generated || c.identity_generation === 'ALWAYS') return `${c.column_name}?: never`;
    const optional = c.nullable || c.has_default || c.is_identity;
    return `${c.column_name}${optional ? '?' : ''}: ${tsType(c.udt_name)}${c.nullable ? ' | null' : ''}`;
  });
  const upd = tcols.map((c) => {
    if (c.is_generated || c.identity_generation === 'ALWAYS') return `${c.column_name}?: never`;
    return `${c.column_name}?: ${tsType(c.udt_name)}${c.nullable ? ' | null' : ''}`;
  });
  const rels = fks
    .filter((f) => f.table_name === name && f.referenced_schema === 'public')
    .map((f) => `{
  foreignKeyName: "${f.conname}"
  columns: [${f.columns.map((x) => `"${x}"`).join(', ')}]
  isOneToOne: false
  referencedRelation: "${f.referenced_relation}"
  referencedColumns: [${f.referenced_columns.map((x) => `"${x}"`).join(', ')}]
}`);
  return `${name}: {
  Row: {
${indent(row.join('\n'), 4)}
  }
  Insert: {
${indent(ins.join('\n'), 4)}
  }
  Update: {
${indent(upd.join('\n'), 4)}
  }
  Relationships: [${rels.length ? '\n' + indent(rels.join(',\n'), 4) + '\n  ' : ''}]
}`;
};

// ---- functions -------------------------------------------------------------------
const { rows: fns } = await db.query(`
  select p.proname, p.proretset, p.pronargdefaults,
         coalesce(p.proargnames, '{}') as argnames,
         coalesce(p.proargmodes::text[], '{}') as argmodes,
         array(select t.typname
               from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as a(typ, ord)
               join pg_type t on t.oid = a.typ
               order by a.ord)::text[] as argtypes,
         rt.typname as rettype, rt.typtype as rettypkind
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_type rt on rt.oid = p.prorettype
  where n.nspname = 'public' and p.prokind = 'f' and rt.typname <> 'trigger'
    and has_function_privilege('authenticated', p.oid, 'execute')
  order by p.proname`);

const renderFn = (f) => {
  const ins = [];
  const outs = [];
  f.argtypes.forEach((t, i) => {
    const mode = f.argmodes[i] ?? 'i';
    const name = f.argnames[i];
    if (mode === 'i' || mode === 'b') ins.push({ name, t });
    if (mode === 'o' || mode === 't' || mode === 'b') outs.push({ name, t });
  });
  const firstOptional = ins.length - f.pronargdefaults;
  const args = ins.map((a, i) => `${a.name}${i >= firstOptional ? '?' : ''}: ${tsType(a.t)}`);
  let ret;
  if (outs.length) {
    ret = `{\n${indent(outs.map((o) => `${o.name}: ${tsType(o.t)}`).join('\n'), 2)}\n}${f.proretset ? '[]' : ''}`;
  } else if (f.rettypkind === 'c' && tables.has(f.rettype)) {
    ret = `Database["public"]["Tables"]["${f.rettype}"]["Row"]${f.proretset ? '[]' : ''}`;
  } else {
    ret = `${tsType(f.rettype)}${f.proretset ? '[]' : ''}`;
  }
  return `${f.proname}: {
  Args: ${args.length ? `{\n${indent(args.join('\n'), 4)}\n  }` : 'never'}
  Returns: ${indent(ret, 2).trimStart()}
}`;
};

const baseTables = [...tables].filter(([, t]) => t.type === 'BASE TABLE');
const views = [...tables].filter(([, t]) => t.type === 'VIEW');

const body = `// AUTO-GENERATED by scripts/gen-db-types.mjs from supabase/migrations — do not edit.
// Regenerate: npm run db:types (Supabase CLI) or npm run db:types:offline.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
${indent(baseTables.map(([n, t]) => renderTable(n, t)).join('\n'), 6)}
    }
    Views: {${views.length ? '\n' + indent(views.map(([n, t]) => renderTable(n, t)).join('\n'), 6) + '\n    ' : '\n      [_ in never]: never\n    '}}
    Functions: {
${indent(fns.map(renderFn).join('\n'), 6)}
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]
export type Functions<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]
`;

writeFileSync(out, body);
console.log(`Wrote ${out} (${baseTables.length} tables, ${fns.length} functions)`);
await db.close();
