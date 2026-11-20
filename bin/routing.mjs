#!/usr/bin/env node
// Agent CLI: node bin/routing.mjs resolve|set-route ...  (see README "Agent CLI").
import "../test/ts-resolve.mjs";

const { main } = await import("../cli/routing.ts");
process.exitCode = await main(process.argv.slice(2));
