#!/usr/bin/env node
/**
 * Print the session group for a reply endpoint.
 * Usage: node scripts/session-group.js <endpoint>
 */
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node scripts/session-group.js <endpoint>');
  process.exit(1);
}
try {
  process.stdout.write(`${sessionGroupFromEndpoint(args[0])}\n`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
