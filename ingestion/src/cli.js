#!/usr/bin/env node
// ig-ingest fetch | export | status | show | doctor

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApifyProvider } from "./apify.js";
import { InputError, parseTarget } from "./canonical.js";
import { writeJsonl, publicPost } from "./export.js";
import { Pipeline } from "./pipeline.js";
import { Store } from "./store.js";

const HELP = `usage: ig-ingest <command> [options]

  doctor                         check token and network
  fetch <handles or links...>    fetch posts
      --file handles.txt         one handle or link per line (# comments ok)
      --limit 12                 max posts per profile
      --since "6 months"         only newer posts (or a date like 2026-01-31)
      --comments 20              deepen to N comments per post (~$0.0026 each beyond the free ~10)
      --media covers|all|none    photos + video covers (default), add videos, or skip media
      --budget 1                 max USD this run may spend
      --dry-run                  print the cost estimate and stop
  export [--out file] [--include-partial] [--user-id id]
  status
  show <shortcode>

env: APIFY_TOKEN, IG_DATA_DIR (default ./data), IG_MONTHLY_CAP_USD (default 5)`;

function loadDotenv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

async function main() {
  loadDotenv();
  const [cmd, ...rest] = process.argv.slice(2);
  const dataDir = process.env.IG_DATA_DIR || "data";
  const cap = Number(process.env.IG_MONTHLY_CAP_USD || 5);
  const { values: o, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      file: { type: "string" }, limit: { type: "string", default: "12" }, since: { type: "string" },
      comments: { type: "string", default: "0" }, media: { type: "string", default: "covers" },
      budget: { type: "string", default: "1" }, "dry-run": { type: "boolean" },
      out: { type: "string" }, "include-partial": { type: "boolean" }, "user-id": { type: "string" },
    },
  });

  if (cmd === "doctor") {
    let ok = true;
    if (process.env.APIFY_TOKEN) {
      try {
        const me = await new ApifyProvider(process.env.APIFY_TOKEN).check();
        console.log(`[ok]   Apify token valid (user ${me.username}, plan ${me.plan})`);
      } catch (e) { ok = false; console.log(`[fail] Apify: ${e.message}`); }
    } else { ok = false; console.log("[fail] APIFY_TOKEN not set"); }
    for (const url of ["https://www.instagram.com/", "https://api.apify.com/v2/"]) {
      try { console.log(`[ok]   reach ${url} (HTTP ${(await fetch(url)).status})`); }
      catch (e) { ok = false; console.log(`[fail] reach ${url}: ${e.cause?.code || e.message}`); }
    }
    console.log(`data dir: ${dataDir}  monthly cap: $${cap}`);
    return ok ? 0 : 1;
  }

  const store = new Store(dataDir);
  if (cmd === "fetch") {
    const raw = [...positionals];
    if (o.file) raw.push(...readFileSync(o.file, "utf8").split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean));
    const targets = [];
    for (const r of raw) {
      try { targets.push(parseTarget(r)); } catch (e) { if (e instanceof InputError) console.error(`skipped: ${e.message}`); else throw e; }
    }
    if (!targets.length) { console.error("nothing to fetch: give handles or post links"); return 2; }
    const pipe = new Pipeline(store, [new ApifyProvider(process.env.APIFY_TOKEN)], { monthlyCapUsd: cap, runBudgetUsd: Number(o.budget) });
    const rep = await pipe.run(targets, { limit: Number(o.limit), since: o.since, comments: Number(o.comments), media: o.media, dryRun: o["dry-run"] });
    console.log(`estimated cost: $${rep.estimate_usd.toFixed(4)}`);
    if (o["dry-run"]) return 0;
    for (const [h, m] of Object.entries(rep.profiles)) console.log(`  @${h}: ${m}`);
    const counts = {};
    for (const s of Object.values(rep.posts)) counts[s.split(" ")[0]] = (counts[s.split(" ")[0]] || 0) + 1;
    console.log(`posts: ${JSON.stringify(counts)}  spent: $${rep.spent_usd.toFixed(4)}`);
    if (rep.media_errors.length) console.log(`media errors: ${rep.media_errors.length} (first: ${rep.media_errors[0]})`);
    return 0;
  }
  if (cmd === "export") {
    const out = o.out || join(dataDir, "export", "posts.jsonl");
    console.log(`wrote ${writeJsonl(store, out, { includePartial: o["include-partial"], userId: o["user-id"] ?? null })} records to ${out}`);
    return 0;
  }
  if (cmd === "status") { console.log(JSON.stringify(store.summary(), null, 2)); return 0; }
  if (cmd === "show") {
    const row = store.getPost(positionals[0]);
    if (!row) { console.error("not found"); return 1; }
    console.log(JSON.stringify({ post: publicPost(row.record), provenance: row.provenance, status: row.status, missing: row.missing }, null, 2));
    return 0;
  }
  console.log(HELP);
  return cmd ? 2 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
