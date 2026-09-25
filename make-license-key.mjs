/**
 * Make the licence signing key.
 *
 *   node make-license-key.mjs [--force]
 *
 * Writes an RSA-2048 private key to LICENSE_SIGNING_KEY_PATH (default
 * /opt/Satpuda-Core-Server/secrets/license-signing.key.pem) with mode 0600, and
 * prints the PUBLIC half plus the block to paste into the desktop build's
 * core/license_seal.py.
 *
 * REFUSES to overwrite an existing key without --force, and says why: every
 * signed licence already on a shop's PC was signed by the key that is there now.
 * Replacing it makes all of them fail verification at once, and every shop in
 * the fleet has to fetch a new blob before it can open. That is a supported
 * thing to do -- it is how a leaked key is retired -- but it is not a thing to
 * do by running a script twice.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const target =
  process.env.LICENSE_SIGNING_KEY_PATH || '/opt/Satpuda-Core-Server/secrets/license-signing.key.pem';
const force = process.argv.includes('--force');

if (fs.existsSync(target) && !force) {
  console.error(`A signing key already exists at ${target}`);
  console.error('');
  console.error('Every licence file on every shop PC was signed by that key. Replacing it');
  console.error('invalidates all of them at once and each shop must fetch a new one before');
  console.error('it can open. Re-run with --force only if that is what you mean to do.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
fs.writeFileSync(target, privPem, { mode: 0o600 });
fs.chmodSync(target, 0o600);

const der = publicKey.export({ type: 'spki', format: 'der' });
const kid = crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
const b64 = Buffer.from(der).toString('base64');
const lines = b64.match(/.{1,64}/g) || [];

console.log(`Private key written: ${target}  (mode 0600)`);
console.log('');
console.log(`kid: ${kid}`);
console.log('');
console.log('Paste this into core/license_seal.py in the desktop repo:');
console.log('');
console.log('_PUBLIC_KEYS = {');
console.log(`    "${kid}": (`);
for (const l of lines) console.log(`        "${l}"`);
console.log('    ),');
console.log('}');
console.log('');
console.log('Public key (PEM), the same thing in the usual spelling:');
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim());
