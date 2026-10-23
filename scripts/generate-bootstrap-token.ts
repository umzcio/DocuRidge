#!/usr/bin/env tsx
/**
 * Print a fresh BOOTSTRAP_TOKEN value to stdout. Use to rotate manually:
 * put it in .env and recreate the app container. While /setup is pending the
 * previous token stops working immediately (setupAction checks the live value
 * and the entrypoint re-syncs the stored hash on boot).
 * Standard flow generates this automatically in the entrypoint.
 */
import { randomBytes } from 'node:crypto';
console.log(randomBytes(24).toString('base64url'));
