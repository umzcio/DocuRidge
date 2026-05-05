#!/usr/bin/env tsx
/**
 * Print a fresh BOOTSTRAP_TOKEN value to stdout. Use to rotate manually.
 * Standard flow generates this automatically in the entrypoint.
 */
import { randomBytes } from 'node:crypto';
console.log(randomBytes(24).toString('base64url'));
