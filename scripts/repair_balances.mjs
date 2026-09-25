/**
 * Recompute every party balance and every bill's cleared flag, in every store.
 *
 * partyDueCascade already keeps total_due, account_cleared and bill_cleared
 * right -- but only for parties it is invoked for, on upsert. Bills entered
 * before that, or whose payments arrived through a path that did not cascade,
 * kept stale figures: a supplier could show a credit on their account while
 * three of their bills still showed a due, and one of those dues was larger
 * than the bill itself. This runs the same cascade over everything once.
 */
import { pool, withTransaction } from '../src/db/pool.js';
import {
  cascadeSupplierAfterLedgerChange,
  cascadeCustomerAfterLedgerChange,
} from '../src/services/partyDueCascade.js';
import { newSyncHint } from '../src/services/syncRevision.js';

const dry = process.argv.includes('--dry-run');
// --store=<id>: one store only. The Firebase importer runs it this way when it finishes a
// store, so every import ends with the cascade. Without it: every store, as before.
const storeArg = process.argv.find((a) => a.startsWith('--store='));
const onlyStore = storeArg ? Number(storeArg.slice('--store='.length)) : null;
if (storeArg && !(onlyStore > 0)) {
  console.error('--store needs a store id, e.g. --store=129');
  process.exit(2);
}

async function main() {
  const { rows: stores } = await pool.query(
    onlyStore
      ? 'SELECT id, store_name FROM stores WHERE id=$1 ORDER BY id'
      : 'SELECT id, store_name FROM stores ORDER BY id',
    onlyStore ? [onlyStore] : [],
  );
  if (onlyStore && !stores.length) {
    console.error(`store ${onlyStore} not found`);
    await pool.end();
    process.exit(2);
  }
  let sup = 0, cus = 0, failures = 0;
  for (const st of stores) {
    const { rows: sups } = await pool.query(
      'SELECT local_id FROM suppliers WHERE store_pk=$1 AND NOT COALESCE(deleted,false)',
      [st.id],
    );
    const { rows: cuss } = await pool.query(
      'SELECT local_id FROM customers WHERE store_pk=$1 AND NOT COALESCE(deleted,false)',
      [st.id],
    );
    if (dry) {
      console.log(`  ${st.store_name}: ${sups.length} suppliers, ${cuss.length} customers`);
      continue;
    }
    for (const s of sups) {
      try {
        await withTransaction(async (client) => {
          await cascadeSupplierAfterLedgerChange(
            client, st.id, Number(s.local_id), newSyncHint(st.id),
          );
        });
        sup++;
      } catch (e) { failures++; console.warn(`  supplier ${s.local_id} @ ${st.store_name}: ${e.message}`); }
    }
    for (const c of cuss) {
      try {
        await withTransaction(async (client) => {
          await cascadeCustomerAfterLedgerChange(
            client, st.id, Number(c.local_id), newSyncHint(st.id),
          );
        });
        cus++;
      } catch (e) { failures++; console.warn(`  customer ${c.local_id} @ ${st.store_name}: ${e.message}`); }
    }
    console.log(`  ${st.store_name}: ${sups.length} suppliers, ${cuss.length} customers done`);
  }
  console.log(`\n  recomputed ${sup} supplier(s) and ${cus} customer(s)`);
  await pool.end();
  if (failures) {
    console.error(`  ${failures} part(y/ies) could not be recomputed`);
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
