import { query, pool } from './pool.js';

async function main() {
  const { rows } = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log(`Tables (${rows.length}):`);
  for (const r of rows) console.log(' -', r.table_name);

  const expected = [
    'admins', 'stores', 'store_devices', 'store_api_tokens',
    'customers', 'suppliers', 'doctors', 'medicines', 'medicines_master',
    'sales', 'sales_items', 'purchases', 'purchase_items',
    'customer_payments', 'supplier_payments',
    'sales_returns', 'sales_return_items', 'purchase_returns', 'purchase_return_items',
    'pharmacy_profiles', 'store_settings', 'store_dropdowns',
    'general_products', 'stock_disposals', 'pending_orders',
    'racks', 'sections', 'boxes', 'shelves', 'medicine_shelf', 'shelf_settings',
    'medicine_suppliers', 'fy_serials', 'sync_watermarks', 'audit_log',
  ];
  const have = new Set(rows.map((r) => r.table_name));
  const missing = expected.filter((t) => !have.has(t));
  if (missing.length) {
    console.error('MISSING:', missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log('All expected tables present.');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
