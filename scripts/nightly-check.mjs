// Nightly stock + dues check for every active store (services/nightlyCheck.js).
// cron: 30 21 * * *  (02:00 IST, after the 21:00 UTC backup)
//   cd /opt/Satpuda-Core-Server && node scripts/nightly-check.mjs >> /var/log/satpuda-nightly-check.log 2>&1
// One store only:  node scripts/nightly-check.mjs 4
import { pool } from '../src/db/pool.js';
import { runAllStoreChecks, runStoreCheck } from '../src/services/nightlyCheck.js';

const one = Number(process.argv[2]);
const started = new Date().toISOString();
try {
  const results = Number.isFinite(one) && one > 0 ? [await runStoreCheck(one)] : await runAllStoreChecks();
  for (const r of results) {
    if (r.error) {
      console.log(`${started} store ${r.store_pk}: ERROR ${r.error}`);
    } else {
      console.log(
        `${started} store ${r.store_pk}: ${r.baseline ? 'baseline' : 'checked'} `
        + `stock ${r.stock_mismatches}/${r.stock_checked} differ, dues ${r.dues_mismatches}/${r.dues_checked} differ, `
        + `open flags ${r.open_flags}`,
      );
    }
  }
} finally {
  await pool.end();
}
