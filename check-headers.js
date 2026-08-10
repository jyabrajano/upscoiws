#!/usr/bin/env node
// =====================================================================
// check-headers.js — the two header files must say the same thing.
//
// Read-only. Exits non-zero on a difference. Chains with the others:
//
//   node sync-sri.js && node sync-csp.js && node check-headers.js && node check-drift.js
//
// WHY THIS EXISTS
//
// .htaccess is Apache configuration and the site deploys to Vercel, so
// every line of it is inert in production. That is fine on its own —
// vercel.json is a translation of it and carries the same rules. What
// is not fine is that nothing checked the translation was still
// faithful. Add a header to .htaccess and it applies on precisely zero
// deployed hosts, with no error, no warning, and a file that reads as
// though the protection is in place. VERCEL.md already warns about the
// whole-file version of this ("`.htaccess` does nothing on Vercel");
// this is the per-directive version, and it is the one that bites
// later, because by then the file looks maintained.
//
// So the rule is: the Apache file may stay, but only as a mirror that
// is proven to be a mirror. Anything either file has and the other
// lacks is a failure here, and the fix is to add it to the other —
// never to quietly drop it from the one that has it.
//
// WHAT IS COMPARED
//
//   1. Response headers, per scope (all files / .html / .js / static).
//   2. The <meta> CSP in the nine pages against the header CSP.
//      frame-ancestors is the one permitted difference: <meta> ignores
//      that directive entirely, which is the whole reason a response
//      header is needed at all.
//   3. Every path .htaccess refuses to serve has a .vercelignore entry.
//      On Apache those files are present and denied; on Vercel the only
//      equivalent is never uploading them.
//
// WHAT IS DELIBERATELY NOT COMPARED
//
// AddType, AddDefaultCharset, Options -Indexes and DirectoryIndex.
// Vercel does not serve directory listings, serves index.html at / by
// default, and gets JS content types right, so there is nothing on the
// other side to compare them to. See VERCEL.md.
// =====================================================================

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

const PAGES = [
  "dashboard.html", "editaccount.html", "index.html", "privacy.html",
  "registration.html", "reset-password.html", "soa.html", "terms.html",
  "users.html",
];

const problems = [];
const notes = [];

// The repo carries these as `_htaccess` / `_vercelignore` so they are
// visible in a file listing and survive a copy; build-clean.js restores
// the dot. Accept either spelling, same as it does.
function resolve(name) {
  for (const candidate of [`.${name}`, `_${name}`]) {
    const p = path.join(ROOT, candidate);
    if (fs.existsSync(p)) return { path: p, name: candidate };
  }
  return null;
}

function fail(message) {
  console.error("check-headers: " + message);
  process.exit(2);
}

// ---- scopes ---------------------------------------------------------
//
// Apache says <FilesMatch "\.(html)$"> and Vercel says "/(.*)\.html".
// Neither string is worth comparing directly; both are reduced to the
// set of extensions they cover, which is the thing that actually has
// to agree. "all" is the unscoped block on one side and "/(.*)" on the
// other.

const STATIC_EXTS = "gif|ico|jpeg|jpg|png|svg|webp|woff|woff2";

function scopeFromExtensions(exts) {
  const set = [...new Set(exts.map(e => e.toLowerCase()))].sort();
  if (set.length === 1 && set[0] === "html") return "html";
  if (set.length === 1 && set[0] === "js") return "js";
  if (set.join("|") === STATIC_EXTS) return "static";
  return "ext:" + set.join("|");
}

// woff2? in a regex means two extensions. Expand it rather than
// treating the literal "woff2?" as one, or the two files compare
// unequal for a reason that is purely notation.
function expandExtAlternation(body) {
  const out = [];
  for (const raw of body.split("|")) {
    const e = raw.trim();
    if (!e) continue;
    const opt = /^(.*)\?$/.exec(e);
    if (opt) {
      out.push(opt[1].slice(0, -1));
      out.push(opt[1]);
    } else {
      out.push(e);
    }
  }
  return out;
}

// ---- .htaccess ------------------------------------------------------

function parseHtaccess(src) {
  const headers = new Map();   // scope -> Map(name -> value)
  const denials = [];
  let scope = "all";
  let denyingBlock = null;

  const put = (sc, name, value) => {
    if (!headers.has(sc)) headers.set(sc, new Map());
    headers.get(sc).set(name.toLowerCase(), value);
  };

  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const open = /^<FilesMatch\s+"([^"]+)"\s*>$/i.exec(line);
    if (open) {
      const pattern = open[1];
      const extBlock = /^\\\.\(([^)]+)\)\$$/.exec(pattern);
      if (extBlock) {
        scope = scopeFromExtensions(expandExtAlternation(extBlock[1]));
      } else {
        scope = "files:" + pattern;
      }
      denyingBlock = { pattern, denied: false };
      continue;
    }

    if (/^<\/FilesMatch>$/i.test(line)) {
      if (denyingBlock && denyingBlock.denied) denials.push(denyingBlock.pattern);
      scope = "all";
      denyingBlock = null;
      continue;
    }

    if (/^Require\s+all\s+denied$/i.test(line)) {
      if (denyingBlock) denyingBlock.denied = true;
      continue;
    }

    const header = /^Header\s+(?:always\s+)?set\s+([A-Za-z0-9-]+)\s+"([\s\S]*)"$/i.exec(line);
    if (header) put(scope, header[1], header[2]);
  }

  return { headers, denials };
}

// ---- vercel.json ----------------------------------------------------

function scopeFromSource(source) {
  if (source === "/(.*)") return "all";
  // "/" is the bare root. Apache reaches it through DirectoryIndex, so
  // it is index.html by another name and belongs with the html scope.
  if (source === "/") return "html";
  const single = /^\/\(\.\*\)\\\.([a-z0-9]+)$/i.exec(source);
  if (single) return scopeFromExtensions([single[1]]);
  const group = /^\/\(\.\*\)\\\.\(([^)]+)\)$/i.exec(source);
  if (group) return scopeFromExtensions(expandExtAlternation(group[1]));
  return "source:" + source;
}

function parseVercel(json) {
  const headers = new Map();
  const rootSources = new Set();

  for (const rule of json.headers || []) {
    const scope = scopeFromSource(rule.source);
    if (rule.source === "/") rootSources.add("/");
    if (!headers.has(scope)) headers.set(scope, new Map());
    const bucket = headers.get(scope);
    for (const h of rule.headers || []) {
      const key = String(h.key).toLowerCase();
      const existing = bucket.get(key);
      // Two sources folding into one scope (html gets both
      // "/(.*)\.html" and "/") must not disagree with each other.
      if (existing !== undefined && existing !== h.value) {
        problems.push(
          `vercel.json: ${h.key} differs between two sources that cover the same files ` +
          `(${JSON.stringify(existing)} vs ${JSON.stringify(h.value)})`
        );
      }
      bucket.set(key, h.value);
    }
  }

  if (!rootSources.has("/")) {
    problems.push(
      'vercel.json: no rule for source "/" — Vercel serves index.html at the bare ' +
      "root and matches sources literally, so the html Cache-Control does not " +
      "reach the first page anyone loads."
    );
  }

  return headers;
}

// ---- normalising a header value ------------------------------------
//
// The CSP is one line in .htaccess and one line in vercel.json but the
// <meta> copies are indented across ten lines. Compare the directives,
// not the whitespace.

function normaliseValue(name, value) {
  const flat = value.replace(/\s+/g, " ").trim();
  if (name !== "content-security-policy") return flat;
  return flat
    .split(";")
    .map(d => d.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join("; ");
}

function directives(csp) {
  const map = new Map();
  for (const chunk of csp.split(";")) {
    const d = chunk.trim().replace(/\s+/g, " ");
    if (!d) continue;
    const sp = d.indexOf(" ");
    map.set(sp === -1 ? d : d.slice(0, sp), sp === -1 ? "" : d.slice(sp + 1));
  }
  return map;
}

// ---- run ------------------------------------------------------------

const ht = resolve("htaccess");
if (!ht) fail("no .htaccess (or _htaccess) here. Run this from the repo root.");

const vercelPath = path.join(ROOT, "vercel.json");
if (!fs.existsSync(vercelPath)) {
  fail("vercel.json not found — that file IS the deployed header set. See VERCEL.md.");
}

let vercelJson;
try {
  vercelJson = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
} catch (err) {
  fail(`vercel.json is not valid JSON (${err.message}). Vercel would ignore it and ` +
       "deploy with no headers at all.");
}

const apache = parseHtaccess(fs.readFileSync(ht.path, "utf8"));
const vercel = parseVercel(vercelJson);

// 1. header parity, per scope
const scopes = [...new Set([...apache.headers.keys(), ...vercel.keys()])].sort();

for (const scope of scopes) {
  const a = apache.headers.get(scope) || new Map();
  const v = vercel.get(scope) || new Map();
  const names = [...new Set([...a.keys(), ...v.keys()])].sort();

  for (const name of names) {
    const inA = a.has(name);
    const inV = v.has(name);

    if (inA && !inV) {
      problems.push(
        `${scope}: ${name} is set in ${ht.name} and not in vercel.json — ` +
        "so it applies on no deployed host."
      );
      continue;
    }
    if (!inA && inV) {
      problems.push(
        `${scope}: ${name} is set in vercel.json and not in ${ht.name} — ` +
        "an Apache deploy would ship without it."
      );
      continue;
    }
    const av = normaliseValue(name, a.get(name));
    const vv = normaliseValue(name, v.get(name));
    if (av !== vv) {
      problems.push(
        `${scope}: ${name} differs.\n` +
        `      ${ht.name}:   ${a.get(name).replace(/\s+/g, " ").trim()}\n` +
        `      vercel.json: ${v.get(name).replace(/\s+/g, " ").trim()}`
      );
    }
  }
}

// 2. the <meta> CSP in the pages vs the header CSP
const headerCsp = (vercel.get("all") || new Map()).get("content-security-policy");

if (!headerCsp) {
  problems.push("vercel.json has no Content-Security-Policy for /(.*) — the pages' " +
                "<meta> tags cannot supply frame-ancestors, so nothing does.");
} else {
  const headerDirs = directives(headerCsp);

  if (!headerDirs.has("frame-ancestors")) {
    problems.push("the header CSP has no frame-ancestors. <meta> ignores that " +
                  "directive, so this is the only place clickjacking can be refused.");
  }

  const META_RE = /<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*\bcontent\s*=\s*["']([\s\S]*?)["']\s*\/?>/i;

  for (const page of PAGES) {
    const p = path.join(ROOT, page);
    if (!fs.existsSync(p)) {
      problems.push(`${page}: not found.`);
      continue;
    }
    const m = META_RE.exec(fs.readFileSync(p, "utf8"));
    if (!m) {
      problems.push(`${page}: no <meta http-equiv="Content-Security-Policy">.`);
      continue;
    }
    const pageDirs = directives(m[1]);

    if (pageDirs.has("frame-ancestors")) {
      notes.push(`${page}: <meta> carries frame-ancestors, which browsers ignore ` +
                 "there. Harmless, but it reads as protection that is not present.");
    }

    for (const [name, value] of headerDirs) {
      if (name === "frame-ancestors") continue;
      if (!pageDirs.has(name)) {
        problems.push(`${page}: <meta> CSP is missing ${name} — the header has it.`);
      } else if (pageDirs.get(name) !== value) {
        problems.push(
          `${page}: ${name} differs from the header CSP.\n` +
          `      page:   ${name} ${pageDirs.get(name)}\n` +
          `      header: ${name} ${value}`
        );
      }
    }
    for (const name of pageDirs.keys()) {
      if (name === "frame-ancestors") continue;
      if (!headerDirs.has(name)) {
        problems.push(
          `${page}: <meta> CSP has ${name} and the header does not. Both policies ` +
          "are enforced independently, so the stricter one wins and this one is " +
          "invisible until the header changes."
        );
      }
    }
  }
}

// 3. .htaccess denies vs .vercelignore
//
// Apache keeps these files on disk and refuses to serve them. Vercel
// has no such rule; the only equivalent is not uploading them. A deny
// pattern with no counterpart means the file is fetchable in prod.

const vi = resolve("vercelignore");
const ignored = vi
  ? fs.readFileSync(vi.path, "utf8")
      .split("\n").map(l => l.trim())
      .filter(l => l && !l.startsWith("#"))
  : null;

if (apache.denials.length) {
  if (!ignored) {
    problems.push(
      `${ht.name} refuses to serve ${apache.denials.length} pattern(s) and there is ` +
      "no .vercelignore. On Vercel every one of them is uploaded and fetchable."
    );
  } else {
    const covered = (pattern) => {
      const exts = /^\\\.\(([^)]+)\)\$$/.exec(pattern);
      const prefixes = /^\^\(([^)]+)\)/.exec(pattern);
      const wanted = exts
        ? expandExtAlternation(exts[1]).map(e => "." + e)
        : prefixes
          ? prefixes[1].split("|").map(s => s.trim()).filter(Boolean)
          : [];
      if (!wanted.length) return null;   // shape not understood; report it
      return wanted.filter(w => !ignored.some(entry => {
        const e = entry.replace(/\/$/, "");
        return w.startsWith(".")
          ? e.endsWith(w) || e === "*" + w
          : e.startsWith(w) || e.includes("/" + w);
      }));
    };

    for (const pattern of apache.denials) {
      const uncovered = covered(pattern);
      if (uncovered === null) {
        notes.push(`${ht.name}: deny pattern ${pattern} is not a shape this script ` +
                   "understands — check its .vercelignore cover by hand.");
      } else if (uncovered.length) {
        notes.push(
          `${ht.name} denies ${pattern}, and .vercelignore has nothing matching ` +
          `${uncovered.join(", ")}. Fine if no such file is committed; a live ` +
          "download the moment one is."
        );
      }
    }
  }
}

// ---- report ---------------------------------------------------------

console.log(`check-headers: ${ht.name} vs vercel.json`);
console.log(`  scopes compared: ${scopes.join(", ")}`);
console.log(`  pages checked:   ${PAGES.length}`);
console.log("");

for (const n of notes) console.log(`note: ${n}\n`);

if (problems.length === 0) {
  console.log("Both files say the same thing. The Apache copy is a faithful mirror,");
  console.log("so a header added to one and not the other cannot ship unnoticed.");
  process.exit(0);
}

console.error(`FAILED — ${problems.length} difference(s):\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error(
  "\nAdd the missing rule to the file that lacks it. Do not delete it from the\n" +
  "file that has it: vercel.json is what production reads, and .htaccess is\n" +
  "what an Apache deploy reads, and the point of keeping both is that either\n" +
  "host gets the full set.\n"
);
process.exit(1);
