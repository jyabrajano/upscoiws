#!/usr/bin/env node
// ============================================================
// sync-sri.js
//
// Puts an integrity= hash on every cross-origin <script> in the
// pages, and checks the ones already there still match.
//
//   node sync-sri.js           verify (fails on a mismatch)
//   node sync-sri.js --update  accept new hashes
//
// >>> RUN THIS WHENEVER A CDN VERSION CHANGES. <<<
//
// ------------------------------------------------------------
// why this exists
// ------------------------------------------------------------
// This snapshot is the CDN build. The pages load supabase-js from
// cdn.jsdelivr.net and xlsx from cdn.sheetjs.com, and script-src
// names both origins. sync-vendor.js exists to end that arrangement
// by self-hosting both files, and its header argues at length for
// why — but it has never been run against this tree, vendor/ is not
// here, and no page references it. Reading that file leaves you
// believing a migration happened that did not.
//
// So: while the CDN tags are what actually ship, they should carry
// the one protection available to them. The versions are already
// pinned — @2.112.1, not the floating @2 they used to be — which is
// what makes SRI possible at all. A hash cannot be written for a
// floating tag, because the bytes behind it change on every release.
//
// What SRI buys, precisely: if either CDN ever serves different
// bytes than the ones vetted here, the browser refuses to execute
// the file rather than running it with full privileges on a page
// that is about to be handed a password. What it does NOT buy is
// anything about the OTHER scripts on those origins — script-src
// still trusts all of cdn.jsdelivr.net. Only self-hosting fixes
// that, which is sync-vendor.js's argument and it is still correct.
// This is the smaller half of the job, done because the larger half
// keeps not being done.
//
// ------------------------------------------------------------
// crossorigin="anonymous" is not optional
// ------------------------------------------------------------
// A browser will not check an integrity hash on a cross-origin
// script unless the request is made in CORS mode, and a plain
// <script src="https://..."> is not. Without the crossorigin
// attribute the browser does not silently skip the check — it
// BLOCKS the script outright, every time, on a correct hash.
//
// That failure is easy to misread. The symptom is a page that
// renders and then does nothing, which is the same symptom as a
// missing vendor/ file and the same symptom as a CSP refusal, and
// the console message points at integrity rather than at CORS. So
// this script always writes the two attributes together and refuses
// to write one without the other.
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const ROOT = __dirname;
const LOCKFILE = path.join(ROOT, "sri-lock.json");

// The same nine pages sync-csp.js edits, and for the same reason:
// leaving one off is a silent skip, not an error. Two of them
// (privacy, terms) carry no scripts at all today and are listed
// anyway, so that adding one later is covered without anybody
// having to remember this file exists.
const PAGES = [
  "dashboard.html",
  "editaccount.html",
  "index.html",
  "privacy.html",
  "registration.html",
  "reset-password.html",
  "soa.html",
  "terms.html",
  "users.html",
];

const UPDATE = process.argv.includes("--update");

function fail(message) {
  console.error("sync-sri: " + message);
  process.exit(1);
}

// Same downloader as sync-vendor.js, including the redirect
// following that both CDNs need. Returns a Buffer so the hash is
// over the exact bytes served rather than a decoded string.
function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "sync-sri" } }, (res) => {
        const status = res.statusCode;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft === 0) return reject(new Error("too many redirects"));
          return resolve(download(new URL(res.headers.location, url).href, redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function sri(buffer) {
  return "sha384-" + crypto.createHash("sha384").update(buffer).digest("base64");
}

// A cheap check that we got a library and not a CDN error page
// served with a 200 — the same guard sync-vendor.js uses, keyed off
// the URL because this script discovers its targets rather than
// being handed a list with markers attached.
const MARKERS = [
  { test: /supabase/i, marker: "createClient" },
  { test: /xlsx|sheetjs/i, marker: "XLSX" },
];

function markerFor(url) {
  const hit = MARKERS.find((m) => m.test.test(url));
  return hit ? hit.marker : null;
}

function readLock() {
  if (!fs.existsSync(LOCKFILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCKFILE, "utf8"));
  } catch (err) {
    fail(`sri-lock.json is not valid JSON (${err.message}). Delete it and re-run with --update.`);
  }
}

// Cross-origin <script src="https://..."> tags only. Local sources
// (config.js, page-*.js) are same-origin, covered by script-src
// 'self', and need no hash.
const CDN_TAG_RE = /<script\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+)["'][^>]*><\/script>/gi;
const COMMENTS_RE = /<!--[\s\S]*?-->/g;

// ---- 1. discover every cross-origin script across the pages ----

const found = new Map(); // url -> [file, ...]

for (const file of PAGES) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    console.warn(`sync-sri: ${file} — not found, skipped.`);
    continue;
  }
  // Comments are stripped before scanning for the same reason
  // sync-csp.js strips them: several pages discuss their own script
  // tags in a comment, and a tool that acts on its own documentation
  // gets switched off within a week.
  const bare = fs.readFileSync(p, "utf8").replace(COMMENTS_RE, "");
  for (const m of bare.matchAll(CDN_TAG_RE)) {
    if (!found.has(m[1])) found.set(m[1], []);
    found.get(m[1]).push(file);
  }
}

if (found.size === 0) {
  // Not an error. This is what a completed vendor/ migration looks
  // like: every script is same-origin and there is nothing to hash.
  console.log("sync-sri: no cross-origin scripts in any page — nothing to do.");
  console.log("sync-sri: (that is the expected result on a vendor/ build.)");
  process.exit(0);
}

// ---- 2. hash each one, against the lockfile ----

(async () => {
  const lock = readLock();
  const nextLock = {};
  const hashes = new Map(); // url -> sha384-...
  let changed = false;

  for (const [url, files] of found) {
    process.stdout.write(`sync-sri: ${url} … `);

    let body;
    try {
      body = await download(url);
    } catch (err) {
      console.log("failed");
      fail(`couldn't download ${url} — ${err.message}`);
    }

    const marker = markerFor(url);
    if (marker && !body.includes(marker)) {
      console.log("failed");
      fail(
        `${url} came back without "${marker}" in it (${body.length} bytes). ` +
        "That is usually an error page served with a 200. Nothing was written."
      );
    }

    const hash = sri(body);
    const recorded = lock[url];

    if (recorded && recorded !== hash && !UPDATE) {
      console.log("HASH MISMATCH");
      fail(
        `${url} does not match sri-lock.json.\n` +
        `  expected ${recorded}\n` +
        `  received ${hash}\n` +
        "Nothing was written. A pinned version whose bytes changed is exactly\n" +
        "the event this file exists to stop — understand it before you proceed.\n" +
        "If you meant to change versions, re-run with --update."
      );
    }

    hashes.set(url, hash);
    nextLock[url] = hash;

    if (!recorded)              { console.log(`locked ${hash}`); changed = true; }
    else if (recorded !== hash) { console.log(`updated ${hash}`); changed = true; }
    else                        { console.log("ok"); }
  }

  // ---- 3. rewrite the tags ----

  let edited = 0;
  let alreadyCurrent = 0;

  for (const file of PAGES) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;

    const src = fs.readFileSync(p, "utf8");

    // Rewritten from the ORIGINAL text, not the comment-stripped
    // copy used for discovery — the stripped version is for finding
    // URLs only and must never be written back to disk.
    const updated = src.replace(CDN_TAG_RE, (tag, url) => {
      const hash = hashes.get(url);
      if (!hash) return tag; // only inside a comment; leave it alone

      // Strip any integrity/crossorigin already present rather than
      // trying to edit them in place, then write both back together.
      // Rebuilding is what keeps a hand-added `integrity` with no
      // `crossorigin` from surviving — that pair blocks the script on
      // a correct hash, and it is the failure this script is most
      // likely to be run in response to.
      const attrs = tag
        .replace(/\sintegrity\s*=\s*["'][^"']*["']/gi, "")
        .replace(/\scrossorigin\s*=\s*["'][^"']*["']/gi, "")
        .replace(/\scrossorigin(?=[\s>])/gi, "")
        .replace(/><\/script>$/i, "");

      return `${attrs} integrity="${hash}" crossorigin="anonymous"></script>`;
    });

    if (updated === src) { alreadyCurrent++; continue; }

    fs.writeFileSync(p, updated, "utf8");
    edited++;
    console.log(`sync-sri: updated ${file}`);
  }

  fs.writeFileSync(LOCKFILE, JSON.stringify(nextLock, null, 2) + "\n");

  // ---- 4. guard: no cross-origin script may ship without both ----
  //
  // The rewrite above should make this unreachable. It runs anyway,
  // because "should be unreachable" is how the connect-src drift in
  // _htaccess survived for as long as it did — the check that never
  // fires is the one worth keeping, since it costs nothing until the
  // day the rewrite misses a tag shape nobody anticipated.

  const violations = [];
  for (const file of PAGES) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const bare = fs.readFileSync(p, "utf8").replace(COMMENTS_RE, "");
    for (const m of bare.matchAll(CDN_TAG_RE)) {
      const tag = m[0];
      if (!/\bintegrity\s*=/i.test(tag)) {
        violations.push(`${file}: ${m[1]} has no integrity=`);
      } else if (!/\bcrossorigin\b/i.test(tag)) {
        violations.push(
          `${file}: ${m[1]} has integrity= but no crossorigin — the browser ` +
          "will block it even though the hash is right"
        );
      }
    }
  }

  if (violations.length) {
    console.error("\nsync-sri: cross-origin scripts without a usable hash:\n");
    violations.forEach((v) => console.error("  " + v));
    process.exit(1);
  }

  if (changed) {
    console.log("sync-sri: sri-lock.json updated — commit it with the pages.");
  }
  console.log(
    `sync-sri: done — ${found.size} script(s) hashed, ${edited} page(s) updated, ` +
    `${alreadyCurrent} already current.`
  );
})();
