#!/usr/bin/env node
// ============================================================
// sync-vendor.js
//
// Downloads the two third-party libraries this portal depends on,
// checks them against a recorded SHA-384, and writes them into
// vendor/ to be served from the same origin as everything else.
//
//   node sync-vendor.js          download / verify
//   node sync-vendor.js --update accept new hashes (see below)
//
// >>> RUN THIS ONCE BEFORE THE FIRST DEPLOY. <<<
// The pages load vendor/supabase.js and vendor/xlsx.full.min.js.
// Until this has run, those files do not exist and every page will
// fail to start. That is deliberate — see "why not a CDN" below.
//
// ------------------------------------------------------------
// why not a CDN
// ------------------------------------------------------------
// The pages used to load both libraries from cdn.jsdelivr.net, and
// script-src had to name that origin to allow it. Two problems came
// with that, and they compound:
//
//   1. The supabase tag was @2 — a FLOATING major. Whatever jsdelivr
//      served at page-load time ran with full privileges. A bad 2.x
//      publish, or a compromised npm token, lands in production on the
//      next reload with nothing in this repo changing.
//
//   2. Naming an origin in script-src trusts EVERY script on it, not
//      the two we wanted. The rest of the CSP is strict — no
//      'unsafe-inline', object-src 'none', base-uri 'self', every
//      handler moved out into a page-*.js file precisely so the
//      directive could stay off. Whitelisting a public CDN is a much
//      larger hole than the one all that work closed.
//
// Subresource Integrity fixes (1) but not (2), and cannot be used with
// a floating tag at all — the hash changes every release. Self-hosting
// fixes both: cdn.jsdelivr.net is now gone from script-src entirely,
// so the only scripts the browser will run are the ones on this host.
//
// The hash is still recorded and still checked, because it is what
// makes the download reproducible: run this on two machines a year
// apart and you find out if what arrived differs.
//
// ------------------------------------------------------------
// upgrading
// ------------------------------------------------------------
// Change the version in LIBRARIES below, then:
//
//   node sync-vendor.js --update
//
// which downloads, prints the new hash, and rewrites vendor-lock.json.
// Commit the lockfile AND the vendor/ files together. Without
// --update, a hash that doesn't match the lockfile is a hard failure,
// which is the point: an unexpected change in a file nobody edited is
// exactly the event worth stopping for.
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const ROOT = __dirname;
const VENDOR_DIR = path.join(ROOT, "vendor");
const LOCKFILE = path.join(ROOT, "vendor-lock.json");

// `marker` is a string that must appear in the downloaded file. It is
// a cheap check that we got the library and not a CDN error page, a
// redirect stub, or a 404 body served with a 200.
const LIBRARIES = [
  {
    name: "@supabase/supabase-js",
    version: "2.112.1",
    url: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.1/dist/umd/supabase.js",
    file: "supabase.js",
    marker: "createClient",
  },
  {
    name: "xlsx (SheetJS Community Edition)",
    version: "0.20.3",
    // NOT the npm package. The npm registry's newest xlsx is 0.18.5,
    // which carries CVE-2023-30533 (prototype pollution when READING a
    // crafted file) and CVE-2024-22363. The fix shipped in 0.19.3 and
    // was never published to npm, so every npm-backed CDN — jsdelivr
    // and unpkg included — can only serve the vulnerable build.
    //
    // As used here the CVE was not exploitable: page-soa.js only ever
    // writes (json_to_sheet / writeFile) and never parses an incoming
    // file, and the advisory excludes export-only workflows. Pinning
    // the fixed version anyway costs nothing and means the finding is
    // already answered the next time a scanner raises it, and that
    // nobody has to re-derive the argument if an import feature is
    // added later.
    url: "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
    file: "xlsx.full.min.js",
    marker: "XLSX",
  },
];

const UPDATE = process.argv.includes("--update");

function fail(message) {
  console.error("sync-vendor: " + message);
  process.exit(1);
}

// Follows redirects, which both CDNs use. Returns the body as a Buffer
// so the hash is over the exact bytes served, not a decoded string.
function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "sync-vendor" } }, (res) => {
        const status = res.statusCode;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft === 0) return reject(new Error("too many redirects"));
          const next = new URL(res.headers.location, url).href;
          return resolve(download(next, redirectsLeft - 1));
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

// The same format Subresource Integrity uses, so the recorded value
// can be pasted straight into an integrity= attribute if these ever
// go back to being loaded cross-origin.
function sri(buffer) {
  return "sha384-" + crypto.createHash("sha384").update(buffer).digest("base64");
}

function readLock() {
  if (!fs.existsSync(LOCKFILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCKFILE, "utf8"));
  } catch (err) {
    fail(`vendor-lock.json is not valid JSON (${err.message}). Delete it and re-run with --update.`);
  }
}

(async () => {
  const lock = readLock();
  const nextLock = {};
  let changed = false;

  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  for (const lib of LIBRARIES) {
    const label = `${lib.name}@${lib.version}`;
    process.stdout.write(`sync-vendor: ${label} … `);

    let body;
    try {
      body = await download(lib.url);
    } catch (err) {
      console.log("failed");
      fail(`couldn't download ${lib.url} — ${err.message}`);
    }

    if (!body.includes(lib.marker)) {
      console.log("failed");
      fail(
        `${lib.url} came back without "${lib.marker}" in it (${body.length} bytes). ` +
        "That is usually an error page served with a 200. Nothing was written."
      );
    }

    const hash = sri(body);
    const key = `${lib.name}@${lib.version}`;
    const recorded = lock[key];
    const destination = path.join(VENDOR_DIR, lib.file);
    const onDisk = fs.existsSync(destination);

    if (recorded && recorded !== hash && !UPDATE) {
      console.log("HASH MISMATCH");
      fail(
        `${label} does not match vendor-lock.json.\n` +
        `  expected ${recorded}\n` +
        `  received ${hash}\n` +
        "Nothing was written. Either the CDN served something different from last " +
        "time — which is worth understanding before you proceed — or you meant to " +
        "change versions, in which case re-run with --update."
      );
    }

    fs.writeFileSync(destination, body);
    nextLock[key] = hash;

    if (!recorded)              { console.log(`locked ${hash}`); changed = true; }
    else if (recorded !== hash) { console.log(`updated ${hash}`); changed = true; }
    else if (!onDisk)           { console.log("restored, hash matches"); }
    else                        { console.log("ok"); }
  }

  // Keys for versions no longer in LIBRARIES are dropped rather than
  // carried forever — a lockfile listing things nothing loads invites
  // the wrong conclusion about what is actually being served.
  fs.writeFileSync(LOCKFILE, JSON.stringify(nextLock, null, 2) + "\n");

  if (changed) {
    console.log("sync-vendor: vendor-lock.json updated — commit it with the vendor/ files.");
  }
  console.log(`sync-vendor: ${LIBRARIES.length} file(s) in ${path.relative(ROOT, VENDOR_DIR)}/`);
})();
