#!/usr/bin/env node
const fs = require("fs");

const path = require("path");

const SCHEMA = path.join(__dirname, "deploy-schema.sql");

const EXPECTED = {
  tables: 18,
  indexes: 29,
  functions: 80,
  rowTriggers: 15,
  eventTriggers: 1,
  publicPolicies: 17,
  storagePolicies: 4,
  buckets: 1,
  rlsTables: 18,
  cronJobs: 1,
  realtimeTables: 1
};

const DENY_ALL_BY_DESIGN = new Set([ "admins", "admin_invites", "admin_removal_requests", "ai_assistant_usage", "anon_probe_budget", "transactions_staging" ]);

const EXTENSION_FUNCTIONS = new Set([ "similarity", "word_similarity", "show_trgm", "gen_random_uuid", "gen_random_bytes", "crypt", "digest", "uuid_generate_v4" ]);

function split(sql) {
  let out = "";
  const bodies = [];
  let i = 0;
  while (i < sql.length) {
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      bodies.push(sql.slice(i + tag.length, end === -1 ? sql.length : end));
      out += " ";
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return {
    stripped: out,
    bodies: bodies
  };
}

function inventory(stripped) {
  const all = (re, group = 1) => {
    const found = [];
    let m;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    while ((m = r.exec(stripped)) !== null) found.push(m[group]);
    return found;
  };
  const tables = new Map;
  const tableRe = /create\s+(?:unlogged\s+|temporary\s+|temp\s+)?table\s+public\.([a-z_0-9]+)\s*\(/gi;
  let m;
  while ((m = tableRe.exec(stripped)) !== null) {
    const name = m[1];
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === "(") depth += 1; else if (stripped[i] === ")") depth -= 1;
      i += 1;
    }
    const body = stripped.slice(m.index + m[0].length, i - 1);
    const cols = new Set;
    let depth2 = 0;
    let start = 0;
    const parts = [];
    for (let k = 0; k <= body.length; k += 1) {
      const c = body[k];
      if (c === "(") depth2 += 1; else if (c === ")") depth2 -= 1;
      if (c === "," && depth2 === 0 || k === body.length) {
        parts.push(body.slice(start, k));
        start = k + 1;
      }
    }
    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      if (/^(constraint|primary\s+key|unique|check|foreign\s+key|exclude)\b/i.test(t)) continue;
      const id = /^"?([a-z_][a-z_0-9]*)"?/i.exec(t);
      if (id) cols.add(id[1].toLowerCase());
    }
    tables.set(name, cols);
  }
  return {
    tables: tables,
    functions: new Set(all(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)/i)),
    indexes: all(/create\s+(?:unique\s+)?index\s+([a-z_0-9]+)\s+on\s+public\./i),
    indexTargets: all(/create\s+(?:unique\s+)?index\s+[a-z_0-9]+\s+on\s+public\.([a-z_0-9]+)/i),
    rowTriggers: all(/create\s+trigger\s+([a-z_0-9]+)/i),
    eventTriggers: all(/create\s+event\s+trigger\s+([a-z_0-9]+)/i),
    publicPolicies: all(/create\s+policy\s+([a-z_0-9]+)\s+on\s+public\./i),
    policyTargets: all(/create\s+policy\s+[a-z_0-9]+\s+on\s+public\.([a-z_0-9]+)/i),
    storagePolicies: all(/create\s+policy\s+([a-z_0-9]+)\s+on\s+storage\./i),
    rlsTables: all(/alter\s+table\s+public\.([a-z_0-9]+)\s+enable\s+row\s+level\s+security/i),
    buckets: all(/insert\s+into\s+storage\.buckets[\s\S]*?values\s*\(\s*'([a-z_0-9-]+)'/i),
    realtimeTables: all(/alter\s+publication\s+supabase_realtime\s+add\s+table\s+public\.([a-z_0-9]+)/i),
    cronJobs: all(/cron\.schedule\(\s*\n?\s*'([a-z_0-9-]+)'/i)
  };
}

function clientReferences() {
  const out = new Map;
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith(".js") && f !== path.basename(__filename) && !f.startsWith("sync-")).map(f => ({
    label: f,
    full: path.join(__dirname, f)
  })).concat(edgeFunctionSources());
  for (const {label: file, full: full} of files) {
    const src = fs.readFileSync(full, "utf8");
    const columns = [];
    const rpcs = new Set;
    let rm;
    const rpcRe = /\.rpc\(\s*["']([a-z_0-9]+)["']/gi;
    while ((rm = rpcRe.exec(src)) !== null) rpcs.add(rm[1].toLowerCase());
    const fromRe = /\.from\(\s*["']([a-z_0-9]+)["']\s*\)/gi;
    const starts = [];
    let fm;
    while ((fm = fromRe.exec(src)) !== null) starts.push({
      table: fm[1],
      at: fm.index + fm[0].length
    });
    for (let i = 0; i < starts.length; i += 1) {
      const {table: table, at: at} = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
      const chunk = src.slice(at, Math.min(end, at + 1200));
      const selRe = /\.select\(\s*"([^"]*)"/g;
      let sm;
      while ((sm = selRe.exec(chunk)) !== null) {
        if (sm[1].includes("*") || sm[1].includes("(") || sm[1].includes(":")) continue;
        for (const raw of sm[1].split(",")) {
          const col = raw.trim().toLowerCase();
          if (/^[a-z_][a-z_0-9]*$/.test(col)) columns.push({
            table: table,
            column: col
          });
        }
      }
      const objRe = /\.(insert|update|upsert)\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
      let om;
      while ((om = objRe.exec(chunk)) !== null) {
        const keyRe = /(?:^|[,{]\s*)([a-z_][a-z_0-9]*)\s*:/gi;
        let km;
        while ((km = keyRe.exec(om[2])) !== null) {
          columns.push({
            table: table,
            column: km[1].toLowerCase()
          });
        }
      }
      const filterRe = /\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|order)\(\s*"([a-z_][a-z_0-9]*)"/g;
      let flm;
      while ((flm = filterRe.exec(chunk)) !== null) columns.push({
        table: table,
        column: flm[2].toLowerCase()
      });
    }
    if (columns.length || rpcs.size) out.set(file, {
      columns: columns,
      rpcs: rpcs
    });
  }
  return out;
}

function edgeFunctionSources() {
  const root = path.join(__dirname, "supabase", "functions");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const slug of fs.readdirSync(root)) {
    const entry = path.join(root, slug, "index.ts");
    if (fs.existsSync(entry)) out.push({
      label: `supabase/functions/${slug}/index.ts`,
      full: entry
    });
  }
  return out;
}

function offline() {
  const raw = fs.readFileSync(SCHEMA, "utf8");
  const {stripped: stripped, bodies: bodies} = split(raw);
  const inv = inventory(stripped);
  const problems = [];
  const notes = [];
  const actual = {
    tables: inv.tables.size,
    indexes: new Set(inv.indexes).size,
    functions: inv.functions.size,
    rowTriggers: inv.rowTriggers.length,
    eventTriggers: inv.eventTriggers.length,
    publicPolicies: inv.publicPolicies.length,
    storagePolicies: inv.storagePolicies.length,
    buckets: inv.buckets.length,
    rlsTables: inv.rlsTables.length,
    cronJobs: inv.cronJobs.length,
    realtimeTables: inv.realtimeTables.length
  };
  for (const [k, want] of Object.entries(EXPECTED)) {
    if (actual[k] !== want) {
      problems.push(`header inventory says ${want} ${k}, file contains ${actual[k]}. ` + `Update the CURRENT INVENTORY block in deploy-schema.sql (and EXPECTED here).`);
    }
  }
  const tableNames = new Set(inv.tables.keys());
  const targets = [ [ "index", inv.indexTargets ], [ "policy", inv.policyTargets ], [ "RLS enable", inv.rlsTables ], [ "realtime publication", inv.realtimeTables ] ];
  for (const [what, list] of targets) {
    for (const t of list) {
      if (!tableNames.has(t)) problems.push(`${what} refers to public.${t}, which this file never creates`);
    }
  }
  const idxRe = /create\s+(?:unique\s+)?index\s+([a-z_0-9]+)\s+on\s+public\.([a-z_0-9]+)\s+(?:using\s+[a-z]+\s*)?([\s\S]*?);/gi;
  let im;
  while ((im = idxRe.exec(stripped)) !== null) {
    const [, idxName, tbl, expr] = im;
    const cols = inv.tables.get(tbl);
    if (!cols) continue;
    const noStrings = expr.replace(/'(?:[^']|'')*'/g, "''");
    const ids = noStrings.match(/\b[a-z_][a-z_0-9]*\b(?!\s*\()/gi) || [];
    const NOISE = new Set([ "using", "btree", "gin", "gist", "hash", "brin", "where", "desc", "asc", "nulls", "first", "last", "and", "or", "not", "null", "is", "true", "false", "text", "ops", "trgm", "gin_trgm_ops", "gist_trgm_ops", "public", "on", "in", "any", "array", "collate", "with", "include" ]);
    for (const id of ids) {
      const lower = id.toLowerCase();
      if (NOISE.has(lower)) continue;
      if (lower === tbl) continue;
      if (!cols.has(lower)) {
        problems.push(`index ${idxName} refers to ${tbl}.${lower}, which is not a column of public.${tbl} in this file`);
      }
    }
  }
  const haystack = stripped + "\n" + bodies.join("\n");
  const callRe = /public\.([a-z_0-9]+)\s*\(/gi;
  let cm;
  const unresolved = new Set;
  while ((cm = callRe.exec(haystack)) !== null) {
    const fn = cm[1].toLowerCase();
    if (inv.functions.has(fn)) continue;
    if (tableNames.has(fn)) continue;
    if (EXTENSION_FUNCTIONS.has(fn)) continue;
    unresolved.add(fn);
  }
  for (const fn of unresolved) {
    problems.push(`public.${fn}() is called somewhere in this file but never created here. ` + `If it comes from an extension, add it to EXTENSION_FUNCTIONS in check-drift.js.`);
  }
  const grantRe = /(grant|revoke)\s+execute\s+on\s+function\s+public\.([a-z_0-9]+)/gi;
  let gm;
  while ((gm = grantRe.exec(stripped)) !== null) {
    if (!inv.functions.has(gm[2].toLowerCase())) {
      problems.push(`${gm[1].toLowerCase()} execute names public.${gm[2]}(), which this file never creates`);
    }
  }
  const execRe = /execute\s+function\s+public\.([a-z_0-9]+)/gi;
  let em;
  while ((em = execRe.exec(stripped)) !== null) {
    if (!inv.functions.has(em[1].toLowerCase())) {
      problems.push(`a trigger executes public.${em[1]}(), which this file never creates`);
    }
  }
  const withPolicy = new Set(inv.policyTargets);
  for (const t of inv.rlsTables) {
    if (withPolicy.has(t) || DENY_ALL_BY_DESIGN.has(t)) continue;
    problems.push(`public.${t} has RLS enabled and no policy, and is not listed in DENY_ALL_BY_DESIGN. ` + `That denies everything — intended, or a policy that got lost?`);
  }
  const rlsOn = new Set(inv.rlsTables);
  for (const t of new Set(inv.policyTargets)) {
    if (!rlsOn.has(t)) {
      problems.push(`public.${t} has policies but RLS is never enabled on it — the policies are inert`);
    }
  }
  const buckets = new Set(inv.buckets);
  const bucketRefs = stripped.match(/bucket_id\s*=\s*'([a-z_0-9-]+)'/gi) || [];
  for (const ref of bucketRefs) {
    const id = /'([a-z_0-9-]+)'/.exec(ref)[1];
    if (!buckets.has(id)) {
      problems.push(`a storage policy scopes to bucket '${id}', which this file never creates`);
    }
  }
  if (inv.storagePolicies.length > 0 && buckets.size === 0) {
    problems.push("there are storage policies but no bucket is ever created");
  }
  for (const [file, refs] of clientReferences()) {
    for (const {table: table, column: column} of refs.columns) {
      const cols = inv.tables.get(table);
      if (!cols) {
        problems.push(`${file} reads public.${table}, which this file never creates`);
        continue;
      }
      if (!cols.has(column)) {
        problems.push(`${file} asks for ${table}.${column}; deploy-schema.sql has no such column. ` + `PostgREST returns 400 for the whole request, not just that field.`);
      }
    }
    for (const fn of refs.rpcs) {
      if (!inv.functions.has(fn)) {
        problems.push(`${file} calls rpc("${fn}"), which this file never creates`);
      }
    }
  }
  return {
    problems: [ ...new Set(problems) ],
    notes: [ ...new Set(notes) ],
    actual: actual
  };
}

const CATALOG_SQL = `-- check-drift.js --compare\n-- Paste into the Supabase SQL Editor, run, copy the single cell,\n-- save it as live.json, then: node check-drift.js --compare live.json\nselect jsonb_pretty(jsonb_build_object(\n  'tables', (select jsonb_agg(c.relname order by c.relname)\n               from pg_class c join pg_namespace n on n.oid=c.relnamespace\n              where n.nspname='public' and c.relkind='r'),\n  'columns', (select jsonb_object_agg(t, cols) from (\n                select c.relname as t,\n                       jsonb_agg(a.attname order by a.attname) as cols\n                  from pg_class c\n                  join pg_namespace n on n.oid=c.relnamespace\n                  join pg_attribute a on a.attrelid=c.oid\n                 where n.nspname='public' and c.relkind='r'\n                   and a.attnum>0 and not a.attisdropped\n                 group by c.relname) s),\n  'functions', (select jsonb_agg(distinct p.proname)\n                  from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n                 where n.nspname='public'\n                   and not exists (select 1 from pg_depend d\n                                    where d.objid=p.oid and d.deptype='e')),\n  -- Indexes created by a PRIMARY KEY or UNIQUE constraint are excluded:\n  -- deploy-schema.sql declares those inline on the table, not as separate\n  -- CREATE INDEX statements. Section 3 of that file says as much.\n  'indexes', (select jsonb_agg(c.relname order by c.relname)\n                from pg_class c\n                join pg_namespace n on n.oid=c.relnamespace\n               where n.nspname='public' and c.relkind='i'\n                 and not exists (select 1 from pg_constraint con\n                                  where con.conindid=c.oid)),\n  -- public and auth only: this file creates two triggers on auth.users.\n  -- Supabase's own triggers live in storage/realtime/cron and are not ours.\n  'row_triggers', (select jsonb_agg(t.tgname order by t.tgname)\n                     from pg_trigger t\n                     join pg_class c on c.oid=t.tgrelid\n                     join pg_namespace n on n.oid=c.relnamespace\n                    where not t.tgisinternal and n.nspname in ('public','auth')),\n  -- everything except the event triggers Supabase installs itself\n  'event_triggers', (select jsonb_agg(evtname order by evtname)\n                       from pg_event_trigger\n                      where evtname not in ('issue_pg_cron_access',\n                                            'issue_pg_graphql_access',\n                                            'issue_pg_net_access',\n                                            'issue_graphql_placeholder',\n                                            'pgrst_ddl_watch',\n                                            'pgrst_drop_watch')),\n  'public_policies', (select jsonb_agg(pol.polname order by pol.polname)\n                        from pg_policy pol\n                        join pg_class c on c.oid=pol.polrelid\n                        join pg_namespace n on n.oid=c.relnamespace\n                       where n.nspname='public'),\n  'storage_policies', (select jsonb_agg(polname order by polname)\n                         from pg_policy where polrelid='storage.objects'::regclass),\n  'buckets', (select jsonb_agg(id order by id) from storage.buckets),\n  'rls_tables', (select jsonb_agg(c.relname order by c.relname)\n                   from pg_class c join pg_namespace n on n.oid=c.relnamespace\n                  where n.nspname='public' and c.relkind='r' and c.relrowsecurity),\n  'cron_jobs', (select jsonb_agg(jobname order by jobname) from cron.job),\n  'realtime_tables', (select jsonb_agg(c.relname order by c.relname)\n                        from pg_publication_rel pr\n                        join pg_class c on c.oid=pr.prrelid\n                        join pg_publication pub on pub.oid=pr.prpubid\n                       where pub.pubname='supabase_realtime')\n)) as inventory;`;

function compare(file) {
  const raw = fs.readFileSync(SCHEMA, "utf8");
  const {stripped: stripped} = split(raw);
  const inv = inventory(stripped);
  let live;
  try {
    live = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`could not read ${file} as JSON: ${err.message}`);
    console.error("It should be the single cell that --sql's query returns.");
    process.exit(2);
  }
  const problems = [];
  const diff = (label, fileSet, liveList) => {
    const L = new Set(liveList || []);
    for (const x of fileSet) if (!L.has(x)) problems.push(`${label}: ${x} is in deploy-schema.sql but NOT live`);
    for (const x of L) if (!fileSet.has(x)) problems.push(`${label}: ${x} is live but NOT in deploy-schema.sql`);
  };
  diff("table", new Set(inv.tables.keys()), live.tables);
  diff("function", inv.functions, live.functions);
  diff("index", new Set(inv.indexes), live.indexes);
  diff("row trigger", new Set(inv.rowTriggers), live.row_triggers);
  diff("event trigger", new Set(inv.eventTriggers), live.event_triggers);
  diff("policy", new Set(inv.publicPolicies), live.public_policies);
  diff("storage policy", new Set(inv.storagePolicies), live.storage_policies);
  diff("bucket", new Set(inv.buckets), live.buckets);
  diff("RLS-enabled table", new Set(inv.rlsTables), live.rls_tables);
  diff("cron job", new Set(inv.cronJobs), live.cron_jobs);
  diff("realtime table", new Set(inv.realtimeTables), live.realtime_tables);
  for (const [tbl, cols] of inv.tables) {
    const liveCols = new Set(live.columns && live.columns[tbl] || []);
    if (liveCols.size === 0) continue;
    for (const c of cols) if (!liveCols.has(c)) problems.push(`column: ${tbl}.${c} is in deploy-schema.sql but NOT live`);
    for (const c of liveCols) if (!cols.has(c)) problems.push(`column: ${tbl}.${c} is live but NOT in deploy-schema.sql`);
  }
  return [ ...new Set(problems) ];
}

const arg = process.argv[2];

if (arg === "--sql") {
  console.log(CATALOG_SQL);
  process.exit(0);
}

if (arg === "--compare") {
  const file = process.argv[3];
  if (!file) {
    console.error("usage: node check-drift.js --compare live.json");
    process.exit(2);
  }
  const problems = compare(file);
  if (problems.length === 0) {
    console.log("deploy-schema.sql matches live. Nothing to do.");
    process.exit(0);
  }
  console.error(`DRIFT — ${problems.length} difference(s) between deploy-schema.sql and live:\n`);
  for (const p of problems.sort()) console.error(`  - ${p}`);
  console.error("\nDecide which side is right before you fix either. A column that is live " + "and not in the file is usually the file falling behind; a column in the " + "file and not live is usually a migration that never ran.");
  process.exit(1);
}

if (arg && arg !== "--check") {
  console.error(`unknown option: ${arg}`);
  console.error("usage: node check-drift.js [--sql | --compare live.json]");
  process.exit(2);
}

const {problems: problems, notes: notes, actual: actual} = offline();

console.log("deploy-schema.sql declares:");

for (const [k, v] of Object.entries(actual)) console.log(`  ${String(v).padStart(3)}  ${k}`);

console.log("");

for (const n of notes) console.log(`note: ${n}\n`);

if (problems.length === 0) {
  console.log("Self-consistent: everything this file refers to, this file creates.");
  console.log("For drift against the live database: node check-drift.js --sql");
  process.exit(0);
}

console.error(`FAILED — ${problems.length} problem(s) in deploy-schema.sql:\n`);

for (const p of problems) console.error(`  - ${p}`);

console.error("\nA fresh deploy from this file will not produce the database you expect.");

process.exit(1);
