import 'dotenv/config';
import pg from 'pg';

const sql = `
CREATE INDEX IF NOT EXISTS idx_cust_pay_customer
  ON customer_payments (store_pk, customer_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_sales_ret_customer
  ON sales_returns (store_pk, customer_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_supp_pay_supplier
  ON supplier_payments (store_pk, supplier_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_purch_ret_supplier
  ON purchase_returns (store_pk, supplier_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_purch_ret_purchase
  ON purchase_returns (store_pk, purchase_id) WHERE NOT deleted;
`;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(sql);
console.log('indexes ok');
await c.end();
