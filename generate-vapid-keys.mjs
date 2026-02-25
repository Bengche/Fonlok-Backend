/**
 * generate-vapid-keys.mjs
 *
 * Run this ONCE to generate your VAPID keys, then copy the output into your .env file.
 *
 * Usage:
 *   node generate-vapid-keys.mjs
 */

import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("\n✅  VAPID keys generated! Add these to your .env file:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_EMAIL=support@fonlok.com`);
console.log("\nAlso add the public key to your frontend .env.local:\n");
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log("\n");
