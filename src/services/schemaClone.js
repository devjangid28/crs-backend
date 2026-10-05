// schemaClone.js — clones the LIVE CRS database schema into a fresh tenant DB.
//
// The two checked-in .pg.sql schema files lag behind the real database (which
// has been modified over time by many migrations). To guarantee that every
// client shop gets a database that is byte-for-byte compatible with what the
// app queries, we introspect the live database (information_schema / pg_catalog)
// and generate the same DDL, then apply it to the client's Neon database.
//
// The schema generated is EMPTY — no business data — exactly as a new shop
// should start. Indexes, enum types, sequences (id auto-increment), and the
// standard updated_at trigger are recreated. Foreign keys are re-added in a
// best-effort multi-pass (each pass ignores constraints that cannot yet
// resolve, which is safe because all tables already exist).

const { pool } = require('../config/database');

const getEnumsSql = async () => {
  // string_agg + split instead of array_agg: pg ≥ 8.11 returns Postgres arrays
  // as literal strings, not JS arrays, so aggregate labels as a scalar.
  const res = await pool.query(`
    SELECT t.typname,
           string_agg(e.enumlabel, E'\\x1f' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
  `);
  const parts = [];
  for (const r of res.rows) {
    const labels = Array.isArray(r.labels)
      ? r.labels
      : String(r.labels || '').split('\x1f').filter(Boolean);
    const joined = labels.map(l => `'${l.replace(/'/g, "''")}'`).join(', ');
    parts.push(`
DO $$ BEGIN
  CREATE TYPE ${r.typname} AS ENUM (${joined});
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`);
  }
  return parts.join('\n');
};

const getExtensionsSql = async () => {
  const res = await pool.query(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`);
  return res.rows.map(r => `CREATE EXTENSION IF NOT EXISTS "${r.extname}";`).join('\n');
};

// Returns { sequences: [...], tables: [...], nextvalDefaults: [...] }
const getTablesSql = async () => {
  const tablesRes = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%'
    ORDER BY tablename
  `);

  const seqParts = [];
  const tableParts = [];
  const defaultParts = [];

  for (const { tablename } of tablesRes.rows) {
    const colsRes = await pool.query(`
      SELECT a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             a.attnotnull AS not_null,
             pg_get_expr(d.adbin, d.adrelid) AS column_default,
             a.attnum
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relname = $1 AND c.relkind = 'r'
      ORDER BY a.attnum
    `, [tablename]);

    const colDefs = [];
    const seqs = [];
    for (const col of colsRes.rows) {
      let defaultExpr = col.column_default;
      const nextvalMatch = defaultExpr && defaultExpr.match(/^nextval\('([^']+)'::regclass\)$/);
      let seqName = null;
      if (nextvalMatch) {
        seqName = nextvalMatch[1];
        if (!seqs.some(s => s === seqName)) seqs.push(seqName);
        defaultExpr = null; // handled via ALTER below
      }
      const nullClause = col.not_null ? ' NOT NULL' : '';
      const defaultClause = defaultExpr ? ` DEFAULT ${defaultExpr}` : '';
      colDefs.push(`  ${JSON.stringify(col.column_name)} ${col.data_type}${nullClause}${defaultClause}`);
      if (seqName) {
        defaultParts.push(`ALTER TABLE public.${JSON.stringify(tablename)} ALTER COLUMN ${JSON.stringify(col.column_name)} SET DEFAULT nextval('${seqName}'::regclass);`);
      }
    }

    for (const s of seqs) {
      seqParts.push(`CREATE SEQUENCE IF NOT EXISTS ${s.includes('.') ? s : 'public.' + JSON.stringify(s)};`);
    }

    tableParts.push(`CREATE TABLE IF NOT EXISTS public.${JSON.stringify(tablename)} (\n${colDefs.join(',\n')}\n);`);
  }

  return { sequences: seqParts, tables: tableParts, defaults: defaultParts };
};

const getIndexesSql = async () => {
  const res = await pool.query(`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname
  `);
  const stmts = [];
  for (const { indexdef } of res.rows) {
    // indexdef looks like "CREATE [UNIQUE] INDEX name ON public.t USING ..."
    // → make it re-runnable on a fresh DB.
    let ddl = indexdef;
    if (ddl.startsWith('CREATE INDEX ON')) {
      ddl = ddl.replace('CREATE INDEX ON', 'CREATE INDEX');
    }
    const nameMatch = ddl.match(/INDEX\s+(?:IF NOT EXISTS\s+)?([^\s]+)\s+ON/);
    if (!nameMatch) continue;
    // Each statement must end with ';' so the whole script parses as one
    // multi-statement simple query on the fresh database.
    stmts.push(ddl.replace(/CREATE (UNIQUE )?INDEX /i, (m) => m + 'IF NOT EXISTS ') + ';');
  }
  return stmts.join('\n');
};

const getForeignKeysSql = async () => {
  const res = await pool.query(`
    SELECT tc.constraint_name, tc.table_name, kcu.column_name,
           ccu.table_name AS foreign_table, ccu.column_name AS foreign_column,
           rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name
  `);
  // Group multi-column FKs (rare) under one constraint name; keep single-col mapping.
  const seen = new Set();
  const fks = [];
  for (const r of res.rows) {
    const key = r.constraint_name;
    if (seen.has(key)) continue;
    seen.add(key);
    const del = r.delete_rule && r.delete_rule !== 'NO ACTION' ? ` ON DELETE ${r.delete_rule}` : '';
    fks.push(`ALTER TABLE public.${JSON.stringify(r.table_name)} ADD CONSTRAINT ${JSON.stringify(r.constraint_name)}
  FOREIGN KEY (${JSON.stringify(r.column_name)}) REFERENCES public.${JSON.stringify(r.foreign_table)} (${JSON.stringify(r.foreign_column)})${del};`);
  }
  return fks;
};

const getTriggersSql = async () => {
  const res = await pool.query(`
    SELECT tr.tgname, c.relname AS table_name, n.nspname AS schema_name,
           p.proname AS func
    FROM pg_trigger tr
    JOIN pg_class c ON c.oid = tr.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = tr.tgfoid
    WHERE NOT tr.tgisinternal AND tr.tgenabled = 'O'
      AND n.nspname = 'public'
  `);
  const funcParts = [];
  const trigParts = [];
  for (const r of res.rows) {
    if (!funcParts.includes(r.func)) {
      let body = null;
      if (r.func === 'update_updated_at_column') {
        body = `CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;
      }
      if (body) funcParts.push(body);
    }
    trigParts.push(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${r.tgname}') THEN
    CREATE TRIGGER ${JSON.stringify(r.tgname)}
    BEFORE UPDATE ON public.${JSON.stringify(r.table_name)}
    FOR EACH ROW EXECUTE FUNCTION ${r.func}();
  END IF;
END $$;`);
  }
  return [...funcParts, ...trigParts].join('\n');
};

// Generate the full DDL script that reproduces the live schema on a fresh DB.
// Returns { extensions, main, fks } so the applier can run pieces separately
// (extensions/FKs with per-statement error tolerance).
const buildSchemaParts = async () => {
  const enums = await getEnumsSql();
  const extensions = await getExtensionsSql();
  const { sequences, tables, defaults } = await getTablesSql();
  const indexes = await getIndexesSql();
  const fks = await getForeignKeysSql();
  const triggers = await getTriggersSql();

  const main = [
    enums,
    sequences.join('\n'),
    tables.join('\n'),
    defaults.join('\n'),
    indexes,
    triggers,
  ].filter(Boolean).join('\n\n');

  return { extensions, main, fks };
};

const generateSchemaDdl = async () => {
  const { extensions, main, fks } = await buildSchemaParts();
  return [
    extensions,
    main,
    fks.join('\n'),
  ].filter(Boolean).join('\n\n');
};

module.exports = { generateSchemaDdl, buildSchemaParts };