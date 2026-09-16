#!/usr/bin/env node
import { main } from "../cli.js";

// No process.exit() on success: picker cleanup already pauses stdin, so the event loop
// drains on its own — an explicit exit() races libuv handle teardown on Windows
// (UV_HANDLE_CLOSING assert, exit code 127) whenever searchNpm's socket was in flight.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === "number" ? code : (process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1); // error path: never risk hanging on a resumed/raw stdin
  });
