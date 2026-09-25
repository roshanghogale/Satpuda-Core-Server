"""
Firebase → Postgres importer (Firebase READ-ONLY).
Runs on VPS with local Postgres. Never writes to Firebase.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras
from google.cloud import firestore
from google.oauth2 import service_account

COLLECTIONS = [
    "customers",
    "suppliers",
    "medicines",
    "doctors",
    "sales",
    "purchases",
    "customer_payments",
    "supplier_payments",
    "sales_returns",
    "purchase_returns",
]

SA_PATH = Path(os.environ.get("FIREBASE_SA", "/opt/Satpuda-Core-Server/secrets/firebase_service_account.json"))
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://satpuda:satpudacore@127.0.0.1:5432/satpuda_core",
)


def fb_client():
    creds = service_account.Credentials.from_service_account_file(str(SA_PATH))
    pid = json.loads(SA_PATH.read_text())["project_id"]
    return firestore.Client(project=pid, credentials=creds)


def parse_ts(v):
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        try:
            return v
        except Exception:
            return None
    if isinstance(v, str) and v.strip():
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


def parse_date(v):
    """Return YYYY-MM-DD or None; reject impossible months/days from dirty Firebase data."""
    if v is None or v == "":
        return None
    if hasattr(v, "date") and callable(getattr(v, "date", None)):
        try:
            return v.date().isoformat()
        except Exception:
            pass
    if hasattr(v, "isoformat") and not isinstance(v, str):
        try:
            s = str(v)[:10]
        except Exception:
            return None
    else:
        s = str(v).strip()[:10]
    if len(s) < 10 or s[4] != "-" or s[7] != "-":
        return None
    try:
        y, m, d = int(s[0:4]), int(s[5:7]), int(s[8:10])
        if not (1 <= m <= 12 and 1 <= d <= 31 and 1900 <= y <= 2100):
            return None
        # validate real calendar date
        datetime(y, m, d)
        return f"{y:04d}-{m:02d}-{d:02d}"
    except Exception:
        return None


def to_bool(v):
    if isinstance(v, bool):
        return v
    if v in (1, "1", "true", "True"):
        return True
    return False


def safe_float(v, default=0.0):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except Exception:
        return default


def safe_int(v, default=0):
    if v is None or v == "":
        return default
    try:
        return int(float(v))
    except Exception:
        return default


def slug_store(name: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", (name or "").lower()).strip("_")
    return f"store_{s}"[:60] if not s.startswith("store_") else s[:60]


def ensure_store(cur, store_id: str, store_name: str | None, android_key: str | None):
    if android_key:
        # pairing key must be unique — detach from any other store first
        cur.execute(
            "UPDATE stores SET android_key=NULL WHERE android_key=%s AND store_id<>%s",
            (android_key, store_id),
        )
    cur.execute("SELECT id FROM stores WHERE store_id=%s", (store_id,))
    row = cur.fetchone()
    if row:
        store_pk = row[0]
        if android_key:
            cur.execute(
                "UPDATE stores SET android_key=%s, store_name=COALESCE(NULLIF(%s,''), store_name), updated_at=NOW() WHERE id=%s",
                (android_key, store_name or "", store_pk),
            )
        elif store_name:
            cur.execute(
                "UPDATE stores SET store_name=%s, updated_at=NOW() WHERE id=%s",
                (store_name, store_pk),
            )
        return store_pk

    name = store_name or store_id.replace("store_", "").replace("_", " ").title()
    store_key = "Store_" + name.replace(" ", "_")
    cur.execute(
        """
        INSERT INTO stores (store_id, store_key, store_name, android_key, app_mode, is_active)
        VALUES (%s,%s,%s,%s,'online', TRUE)
        RETURNING id
        """,
        (store_id, store_key, name, android_key),
    )
    store_pk = cur.fetchone()[0]
    cur.execute(
        "INSERT INTO pharmacy_profiles (store_pk, name, gst_enabled) VALUES (%s,%s,TRUE) ON CONFLICT DO NOTHING",
        (store_pk, name),
    )
    cur.execute("INSERT INTO store_dropdowns (store_pk) VALUES (%s) ON CONFLICT DO NOTHING", (store_pk,))
    return store_pk


# Return lines refused by the importer, per store: {store_pk: [(collection, return_id, qty, amount)]}
REJECTED_RETURN_LINES: dict = {}


def importable_return_items(collection, store_pk, d):
    """The return lines that name a medicine.

    A line with medicine 0 names nothing: it cannot move stock and cannot be checked
    against the bill. Firebase-era returns carried such blank placeholders (medicine 0,
    qty 0, rate 0) while their refund still counted them -- store 4's SR1, SR50, SR51 and
    PR1, PR34 arrived that way. They are left out and listed in the import report.
    """
    kept = []
    for it in d.get("items") or []:
        if safe_int((it or {}).get("medicine_id")) > 0:
            kept.append(it)
        else:
            REJECTED_RETURN_LINES.setdefault(store_pk, []).append(
                (collection, d.get("id"), safe_float((it or {}).get("qty")), safe_float((it or {}).get("amount")))
            )
    return kept


def purchase_amount_paid(d):
    """amount_paid, taken from amount_paid_at_entry when the device left it at 0.

    Android keeps the money paid at entry in amount_paid_at_entry and could leave
    amount_paid 0, so every screen reading amount_paid showed a paid bill as unpaid
    (store 127: 79 bills, Rs 1,71,965). Dues were right either way.
    """
    paid = float(d.get("amount_paid") or 0)
    entry = float(d.get("amount_paid_at_entry") or 0)
    if paid == 0 and entry > 0:
        return entry
    return paid


def run_party_cascade(store_pk) -> bool:
    """Recompute every customer and supplier balance of one store with the server's own
    cascade (scripts/repair_balances.mjs -> src/services/partyDueCascade.js).

    The rows are copied as they were, due figures included, and nothing recomputed them:
    imported bills kept the device's old dues until some later payment happened to
    cascade that one party (store 127: 48 bills, Rs 4,798.57 overstated).
    """
    script = Path(__file__).resolve().parent / "repair_balances.mjs"
    env = dict(os.environ)
    env["DATABASE_URL"] = DATABASE_URL
    try:
        proc = subprocess.run(
            ["node", str(script), f"--store={int(store_pk)}"],
            cwd=str(script.parent.parent),
            env=env,
            capture_output=True,
            text=True,
            timeout=3600,
        )
    except Exception as e:
        print(f"  CASCADE FAIL store {store_pk}: {e}")
        return False
    for line in (proc.stdout or "").strip().splitlines()[-2:]:
        print("  " + line.strip())
    if proc.returncode != 0:
        print(f"  CASCADE FAIL store {store_pk}: exit {proc.returncode}: {(proc.stderr or '').strip()[-400:]}")
        return False
    return True


def upsert_simple(cur, table, store_pk, local_id, cols: dict):
    cols = dict(cols)
    cols.setdefault("updated_at", datetime.now(timezone.utc))
    cols.setdefault("version", 1)
    cols.setdefault("deleted", False)
    cols.setdefault("sync_status", "synced")
    keys = list(cols.keys())
    vals = [cols[k] for k in keys]
    placeholders = ",".join(["%s"] * (2 + len(keys)))
    assignments = ", ".join([f"{k}=EXCLUDED.{k}" for k in keys])
    cur.execute(
        f"""
        INSERT INTO {table} (store_pk, local_id, {", ".join(keys)})
        VALUES (%s,%s,{','.join(['%s']*len(keys))})
        ON CONFLICT (store_pk, local_id) DO UPDATE SET {assignments}
        """,
        [store_pk, local_id, *vals],
    )


def import_customers(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        upsert_simple(
            cur,
            "customers",
            store_pk,
            lid,
            {
                "name": (d.get("name") or "").upper(),
                "phone": d.get("phone"),
                "address": d.get("address"),
                "document_name": d.get("document_name"),
                "total_due": float(d.get("total_due") or 0),
                "total_credit": float(d.get("total_credit") or 0),
                "created_at": parse_ts(d.get("created_at")),
                "last_updated": parse_ts(d.get("last_updated")),
                "updated_at": parse_ts(d.get("updated_at")) or parse_ts(d.get("synced_at")) or datetime.now(timezone.utc),
                "version": int(d.get("version") or 1),
                "device_id": d.get("device_id"),
                "deleted": to_bool(d.get("deleted")),
            },
        )


def import_suppliers(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        upsert_simple(
            cur,
            "suppliers",
            store_pk,
            lid,
            {
                "name": (d.get("name") or "").upper(),
                "address": d.get("address"),
                "phone": d.get("phone"),
                "gstin": d.get("gstin"),
                "dl_numbers": d.get("dl_numbers"),
                "total_due": float(d.get("total_due") or 0),
                "total_credit": float(d.get("total_credit") or 0),
                "created_at": parse_ts(d.get("created_at")),
                "updated_at": parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                "version": int(d.get("version") or 1),
                "device_id": d.get("device_id"),
                "deleted": to_bool(d.get("deleted")),
            },
        )


def import_doctors(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        upsert_simple(
            cur,
            "doctors",
            store_pk,
            lid,
            {
                "name": (d.get("name") or "").upper(),
                "phone": d.get("phone"),
                "registration_number": d.get("registration_number"),
                "created_at": parse_ts(d.get("created_at")),
                "updated_at": parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                "version": int(d.get("version") or 1),
                "device_id": d.get("device_id"),
                "deleted": to_bool(d.get("deleted")),
            },
        )


def import_medicines(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        exp = parse_date(d.get("expiry_date"))
        upsert_simple(
            cur,
            "medicines",
            store_pk,
            lid,
            {
                "name": (d.get("name") or "").upper(),
                "type": d.get("type"),
                "stock_qty": int(d.get("stock_qty") or 0),
                "unit": d.get("unit"),
                "gst_percent": d.get("gst_percent"),
                "mrp": d.get("mrp"),
                "rate": d.get("rate"),
                "manufacturer": d.get("manufacturer"),
                "batch_no": d.get("batch_no"),
                "expiry_date": exp,
                "hsn_code": d.get("hsn_code"),
                "schedule": d.get("schedule"),
                "location": d.get("location"),
                "content_drug": d.get("content_drug"),
                "is_hidden": to_bool(d.get("is_hidden")),
                "synced_at": parse_ts(d.get("synced_at")),
                "created_at": parse_ts(d.get("created_at")),
                "updated_at": parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                "version": int(d.get("version") or 1),
                "device_id": d.get("device_id"),
                "deleted": to_bool(d.get("deleted")),
            },
        )


def import_sales(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        bill_date = parse_date(d.get("bill_date")) or datetime.now(timezone.utc).date().isoformat()
        bill_no = d.get("bill_no") or f"SCB{lid}"
        # Avoid unique (store_pk, bill_no) collisions from dirty Firebase data
        cur.execute(
            "SELECT local_id FROM sales WHERE store_pk=%s AND bill_no=%s AND local_id<>%s",
            (store_pk, bill_no, lid),
        )
        if cur.fetchone():
            bill_no = f"{bill_no}#{lid}"
        cur.execute(
            """
            INSERT INTO sales (
              store_pk, local_id, bill_no, customer_id, bill_date, total_amount, discount, discount_pct,
              rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
              due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
              doctor_name, is_autosave, fy_start_year, fy_serial, customer_name, customer_phone,
              customer_address, item_count, created_at, updated_at, version, device_id, deleted, sync_status
            ) VALUES (
              %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s
            )
            ON CONFLICT (store_pk, local_id) DO UPDATE SET
              bill_no=EXCLUDED.bill_no, customer_id=EXCLUDED.customer_id, bill_date=EXCLUDED.bill_date,
              total_amount=EXCLUDED.total_amount, discount=EXCLUDED.discount, discount_pct=EXCLUDED.discount_pct,
              rounding=EXCLUDED.rounding, amount_paid=EXCLUDED.amount_paid, cash_paid=EXCLUDED.cash_paid,
              online_paid=EXCLUDED.online_paid, previous_due=EXCLUDED.previous_due, previous_credit=EXCLUDED.previous_credit,
              due_amount=EXCLUDED.due_amount, credit_amount=EXCLUDED.credit_amount, total_due=EXCLUDED.total_due,
              paid_due=EXCLUDED.paid_due, bill_cleared=EXCLUDED.bill_cleared, account_cleared=EXCLUDED.account_cleared,
              doctor_name=EXCLUDED.doctor_name, is_autosave=EXCLUDED.is_autosave, fy_start_year=EXCLUDED.fy_start_year,
              fy_serial=EXCLUDED.fy_serial, customer_name=EXCLUDED.customer_name, customer_phone=EXCLUDED.customer_phone,
              customer_address=EXCLUDED.customer_address, item_count=EXCLUDED.item_count,
              updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
              deleted=EXCLUDED.deleted
            RETURNING id
            """,
            [
                store_pk,
                lid,
                bill_no,
                d.get("customer_id"),
                bill_date,
                safe_float(d.get("total_amount")),
                safe_float(d.get("discount")),
                safe_float(d.get("discount_pct")),
                safe_float(d.get("rounding")),
                safe_float(d.get("amount_paid")),
                safe_float(d.get("cash_paid")),
                safe_float(d.get("online_paid")),
                safe_float(d.get("previous_due")),
                safe_float(d.get("previous_credit")),
                safe_float(d.get("due_amount")),
                safe_float(d.get("credit_amount")),
                safe_float(d.get("total_due")),
                safe_float(d.get("paid_due")),
                to_bool(d.get("bill_cleared")),
                to_bool(d.get("account_cleared")),
                d.get("doctor_name"),
                to_bool(d.get("is_autosave")),
                d.get("fy_start_year"),
                d.get("fy_serial"),
                d.get("customer_name"),
                d.get("customer_phone"),
                d.get("customer_address"),
                safe_int(d.get("item_count"), len(d.get("items") or [])),
                parse_ts(d.get("created_at")),
                parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                safe_int(d.get("version"), 1),
                d.get("device_id"),
                to_bool(d.get("deleted")),
                "synced",
            ],
        )
        sale_pk = cur.fetchone()[0]
        cur.execute("DELETE FROM sales_items WHERE sale_id=%s", (sale_pk,))
        for it in d.get("items") or []:
            cur.execute(
                """
                INSERT INTO sales_items (
                  store_pk, sale_id, medicine_id, name, type, batch_no, expiry_date, hsn_code,
                  schedule, manufacturer, qty, rate, gst_percent, amount, item_discount, cost_price
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                [
                    store_pk,
                    sale_pk,
                    it.get("medicine_id"),
                    it.get("name"),
                    it.get("type"),
                    it.get("batch_no"),
                    parse_date(it.get("expiry_date")),
                    it.get("hsn_code"),
                    it.get("schedule"),
                    it.get("manufacturer"),
                    safe_int(it.get("qty")),
                    safe_float(it.get("rate")),
                    it.get("gst_percent"),
                    safe_float(it.get("amount")),
                    safe_float(it.get("item_discount")),
                    safe_float(it.get("cost_price")),
                ],
            )


def import_purchases(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        pdate = parse_date(d.get("purchase_date")) or datetime.now(timezone.utc).date().isoformat()
        cur.execute(
            """
            INSERT INTO purchases (
              store_pk, local_id, purchase_no, supplier_id, purchase_date, bill_number,
              subtotal, total_gst, cgst, sgst, total_amount, overall_discount, rounding,
              need_to_pay, final_amount, amount_paid, amount_paid_at_entry, cash_paid_at_entry,
              online_paid_at_entry, previous_due, previous_credit, due, current_credit, total_due,
              due_amount, credit_amount, paid_due, bill_cleared, account_cleared, gst_calc_method,
              expenditure, is_autosave, fy_start_year, fy_serial, supplier_name, supplier_phone,
              item_count, created_at, updated_at, version, device_id, deleted, sync_status
            ) VALUES (
              %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s
            )
            ON CONFLICT (store_pk, local_id) DO UPDATE SET
              purchase_no=EXCLUDED.purchase_no, supplier_id=EXCLUDED.supplier_id, purchase_date=EXCLUDED.purchase_date,
              bill_number=EXCLUDED.bill_number, subtotal=EXCLUDED.subtotal, total_gst=EXCLUDED.total_gst,
              cgst=EXCLUDED.cgst, sgst=EXCLUDED.sgst, total_amount=EXCLUDED.total_amount,
              overall_discount=EXCLUDED.overall_discount, rounding=EXCLUDED.rounding,
              need_to_pay=EXCLUDED.need_to_pay, final_amount=EXCLUDED.final_amount,
              amount_paid=EXCLUDED.amount_paid, amount_paid_at_entry=EXCLUDED.amount_paid_at_entry,
              cash_paid_at_entry=EXCLUDED.cash_paid_at_entry, online_paid_at_entry=EXCLUDED.online_paid_at_entry,
              previous_due=EXCLUDED.previous_due, previous_credit=EXCLUDED.previous_credit,
              due=EXCLUDED.due, current_credit=EXCLUDED.current_credit, total_due=EXCLUDED.total_due,
              due_amount=EXCLUDED.due_amount, credit_amount=EXCLUDED.credit_amount, paid_due=EXCLUDED.paid_due,
              bill_cleared=EXCLUDED.bill_cleared, account_cleared=EXCLUDED.account_cleared,
              gst_calc_method=EXCLUDED.gst_calc_method, expenditure=EXCLUDED.expenditure,
              is_autosave=EXCLUDED.is_autosave, fy_start_year=EXCLUDED.fy_start_year, fy_serial=EXCLUDED.fy_serial,
              supplier_name=EXCLUDED.supplier_name, supplier_phone=EXCLUDED.supplier_phone,
              item_count=EXCLUDED.item_count, updated_at=EXCLUDED.updated_at, version=EXCLUDED.version,
              device_id=EXCLUDED.device_id, deleted=EXCLUDED.deleted
            RETURNING id
            """,
            [
                store_pk,
                lid,
                d.get("purchase_no") or str(lid),
                d.get("supplier_id"),
                pdate,
                d.get("bill_number"),
                float(d.get("subtotal") or 0),
                float(d.get("total_gst") or 0),
                float(d.get("cgst") or 0),
                float(d.get("sgst") or 0),
                float(d.get("total_amount") or 0),
                float(d.get("overall_discount") or 0),
                float(d.get("rounding") or 0),
                float(d.get("need_to_pay") or 0),
                float(d.get("final_amount") or 0),
                purchase_amount_paid(d),
                float(d.get("amount_paid_at_entry") or 0),
                float(d.get("cash_paid_at_entry") or 0),
                float(d.get("online_paid_at_entry") or 0),
                float(d.get("previous_due") or 0),
                float(d.get("previous_credit") or 0),
                float(d.get("due") or 0),
                float(d.get("current_credit") or 0),
                float(d.get("total_due") or 0),
                float(d.get("due_amount") or 0),
                float(d.get("credit_amount") or 0),
                float(d.get("paid_due") or 0),
                to_bool(d.get("bill_cleared")),
                to_bool(d.get("account_cleared")),
                d.get("gst_calc_method"),
                float(d.get("expenditure") or 0),
                to_bool(d.get("is_autosave")),
                d.get("fy_start_year"),
                d.get("fy_serial"),
                d.get("supplier_name"),
                d.get("supplier_phone"),
                int(d.get("item_count") or len(d.get("items") or [])),
                parse_ts(d.get("created_at")),
                parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                int(d.get("version") or 1),
                d.get("device_id"),
                to_bool(d.get("deleted")),
                "synced",
            ],
        )
        purchase_pk = cur.fetchone()[0]
        cur.execute("DELETE FROM purchase_items WHERE purchase_id=%s", (purchase_pk,))
        for it in d.get("items") or []:
            cur.execute(
                """
                INSERT INTO purchase_items (
                  store_pk, purchase_id, medicine_id, name, qty, free_qty, type, hsn_code, gst_pct,
                  mrp, rate, manufacturer, batch_no, expiry_date, schedule, discount_pct,
                  taxable, gst_amt, item_amount
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                [
                    store_pk,
                    purchase_pk,
                    it.get("medicine_id"),
                    it.get("name"),
                    float(it.get("qty") or 0),
                    float(it.get("free_qty") or 0),
                    it.get("type"),
                    it.get("hsn_code"),
                    float(it.get("gst_pct") if it.get("gst_pct") is not None else it.get("gst_percent") or 0),
                    float(it.get("mrp") or 0),
                    float(it.get("rate") or 0),
                    it.get("manufacturer"),
                    it.get("batch_no"),
                    parse_date(it.get("expiry_date")),
                    it.get("schedule"),
                    float(it.get("discount_pct") if it.get("discount_pct") is not None else it.get("discount_percent") or 0),
                    float(it.get("taxable") or 0),
                    float(it.get("gst_amt") if it.get("gst_amt") is not None else it.get("gst_value") or 0),
                    float(it.get("item_amount") if it.get("item_amount") is not None else it.get("amount") or 0),
                ],
            )


def import_customer_payments(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        pdate = parse_date(d.get("payment_date")) or datetime.now(timezone.utc).date().isoformat()
        upsert_simple(
            cur,
            "customer_payments",
            store_pk,
            lid,
            {
                "customer_id": int(d.get("customer_id") or 0),
                "customer_name": d.get("customer_name"),
                "payment_date": pdate,
                "amount": float(d.get("amount") or 0),
                "payment_mode": d.get("payment_mode") or "cash",
                "cash_amount": float(d.get("cash_amount") or 0),
                "online_amount": float(d.get("online_amount") or 0),
                "reference_no": d.get("reference_no"),
                "note": d.get("note"),
                "created_at": parse_ts(d.get("created_at")),
                "updated_at": parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                "version": int(d.get("version") or 1),
                "device_id": d.get("device_id"),
                "deleted": to_bool(d.get("deleted")),
            },
        )


def import_supplier_payments(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        pdate = parse_date(d.get("payment_date")) or datetime.now(timezone.utc).date().isoformat()
        upsert_simple(
            cur,
            "supplier_payments",
            store_pk,
            lid,
            {
                "payment_no": d.get("payment_no") or f"SP{lid}",
                "supplier_id": int(d.get("supplier_id") or 0),
                "supplier_name": d.get("supplier_name"),
                "payment_date": pdate,
                "amount": float(d.get("amount") or 0),
                "mode": d.get("mode") or "Cash",
                "reference": d.get("reference"),
                "due_before": float(d.get("due_before") or 0),
                "due_after": float(d.get("due_after") or 0),
                "created_at": parse_ts(d.get("created_at")),
                "updated_at": parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                "version": int(d.get("version") or 1),
                "device_id": d.get("device_id"),
                "deleted": to_bool(d.get("deleted")),
            },
        )


def import_sales_returns(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        items = importable_return_items("sales_returns", store_pk, d)
        dropped = len(d.get("items") or []) - len(items)
        rdate = parse_date(d.get("return_date")) or datetime.now(timezone.utc).date().isoformat()
        cur.execute(
            """
            INSERT INTO sales_returns (
              store_pk, local_id, return_no, sale_id, bill_no, customer_id, customer_name,
              return_date, refund_amount, discount, reason, item_count, created_at,
              updated_at, version, device_id, deleted, sync_status
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (store_pk, local_id) DO UPDATE SET
              return_no=EXCLUDED.return_no, sale_id=EXCLUDED.sale_id, bill_no=EXCLUDED.bill_no,
              customer_id=EXCLUDED.customer_id, customer_name=EXCLUDED.customer_name,
              return_date=EXCLUDED.return_date, refund_amount=EXCLUDED.refund_amount,
              discount=EXCLUDED.discount, reason=EXCLUDED.reason, item_count=EXCLUDED.item_count,
              updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
              deleted=EXCLUDED.deleted
            RETURNING id
            """,
            [
                store_pk,
                lid,
                d.get("return_no") or f"SR{lid}",
                d.get("sale_id"),
                d.get("bill_no"),
                d.get("customer_id"),
                d.get("customer_name"),
                rdate,
                float(d.get("refund_amount") or 0),
                float(d.get("discount") or 0),
                d.get("reason"),
                len(items) if dropped else int(d.get("item_count") or len(items)),
                parse_ts(d.get("created_at")),
                parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                int(d.get("version") or 1),
                d.get("device_id"),
                to_bool(d.get("deleted")),
                "synced",
            ],
        )
        ret_pk = cur.fetchone()[0]
        cur.execute("DELETE FROM sales_return_items WHERE return_id=%s", (ret_pk,))
        for it in items:
            cur.execute(
                """
                INSERT INTO sales_return_items (store_pk, return_id, medicine_id, name, batch_no, qty, rate, amount)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                [
                    store_pk,
                    ret_pk,
                    it.get("medicine_id"),
                    it.get("name"),
                    it.get("batch_no") or it.get("batch"),
                    float(it.get("qty") or 0),
                    float(it.get("rate") or 0),
                    float(it.get("amount") or 0),
                ],
            )


def import_purchase_returns(cur, store_pk, docs):
    for d in docs:
        lid = int(d["id"])
        items = importable_return_items("purchase_returns", store_pk, d)
        dropped = len(d.get("items") or []) - len(items)
        rdate = parse_date(d.get("return_date")) or datetime.now(timezone.utc).date().isoformat()
        cur.execute(
            """
            INSERT INTO purchase_returns (
              store_pk, local_id, return_no, purchase_id, purchase_no, supplier_id, supplier_name,
              return_date, refund_amount, discount, reason, item_count, created_at,
              updated_at, version, device_id, deleted, sync_status
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (store_pk, local_id) DO UPDATE SET
              return_no=EXCLUDED.return_no, purchase_id=EXCLUDED.purchase_id, purchase_no=EXCLUDED.purchase_no,
              supplier_id=EXCLUDED.supplier_id, supplier_name=EXCLUDED.supplier_name,
              return_date=EXCLUDED.return_date, refund_amount=EXCLUDED.refund_amount,
              discount=EXCLUDED.discount, reason=EXCLUDED.reason, item_count=EXCLUDED.item_count,
              updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
              deleted=EXCLUDED.deleted
            RETURNING id
            """,
            [
                store_pk,
                lid,
                d.get("return_no") or f"PR{lid}",
                d.get("purchase_id"),
                d.get("purchase_no"),
                d.get("supplier_id"),
                d.get("supplier_name"),
                rdate,
                float(d.get("refund_amount") or 0),
                float(d.get("discount") or 0),
                d.get("reason"),
                len(items) if dropped else int(d.get("item_count") or len(items)),
                parse_ts(d.get("created_at")),
                parse_ts(d.get("updated_at")) or datetime.now(timezone.utc),
                int(d.get("version") or 1),
                d.get("device_id"),
                to_bool(d.get("deleted")),
                "synced",
            ],
        )
        ret_pk = cur.fetchone()[0]
        cur.execute("DELETE FROM purchase_return_items WHERE return_id=%s", (ret_pk,))
        for it in items:
            cur.execute(
                """
                INSERT INTO purchase_return_items (store_pk, return_id, medicine_id, name, batch_no, qty, rate, amount)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                [
                    store_pk,
                    ret_pk,
                    it.get("medicine_id"),
                    it.get("name"),
                    it.get("batch_no") or it.get("batch"),
                    float(it.get("qty") or 0),
                    float(it.get("rate") or 0),
                    float(it.get("amount") or 0),
                ],
            )


IMPORTERS = {
    "customers": import_customers,
    "suppliers": import_suppliers,
    "doctors": import_doctors,
    "medicines": import_medicines,
    "sales": import_sales,
    "purchases": import_purchases,
    "customer_payments": import_customer_payments,
    "supplier_payments": import_supplier_payments,
    "sales_returns": import_sales_returns,
    "purchase_returns": import_purchase_returns,
}


def stream_collection(db, store_id, col):
    docs = []
    for snap in db.collection("stores").document(store_id).collection(col).stream():
        d = snap.to_dict() or {}
        d["id"] = int(snap.id) if str(snap.id).isdigit() else snap.id
        # convert timestamps to iso strings for safety in nested
        docs.append(d)
    return docs


def import_settings(cur, store_pk, db, store_id):
    sref = db.collection("stores").document(store_id).collection("settings")
    try:
        profile = sref.document("pharmacy_profile").get()
        if profile.exists:
            d = profile.to_dict() or {}
            cur.execute(
                """
                INSERT INTO pharmacy_profiles (
                  store_pk, name, address, phone, email, gstin, dl_number, gst_enabled,
                  fssai_number, show_fssai_on_bill, updated_at, version, device_id
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),%s,%s)
                ON CONFLICT (store_pk) DO UPDATE SET
                  name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
                  email=EXCLUDED.email, gstin=EXCLUDED.gstin, dl_number=EXCLUDED.dl_number,
                  gst_enabled=EXCLUDED.gst_enabled, fssai_number=EXCLUDED.fssai_number,
                  show_fssai_on_bill=EXCLUDED.show_fssai_on_bill, updated_at=NOW()
                """,
                [
                    store_pk,
                    d.get("name"),
                    d.get("address"),
                    d.get("phone"),
                    d.get("email"),
                    d.get("gstin"),
                    d.get("dl_number"),
                    to_bool(d.get("gst_enabled", True)),
                    d.get("fssai_number"),
                    to_bool(d.get("show_fssai_on_bill")),
                    int(d.get("version") or 1),
                    d.get("device_id"),
                ],
            )
    except Exception as e:
        print("  settings/pharmacy_profile skip:", e)

    try:
        dd = sref.document("dropdowns").get()
        if dd.exists:
            d = dd.to_dict() or {}
            cur.execute(
                """
                INSERT INTO store_dropdowns (store_pk, villages, default_village, med_types, schedules, updated_at)
                VALUES (%s,%s::jsonb,%s,%s::jsonb,%s::jsonb,NOW())
                ON CONFLICT (store_pk) DO UPDATE SET
                  villages=EXCLUDED.villages, default_village=EXCLUDED.default_village,
                  med_types=EXCLUDED.med_types, schedules=EXCLUDED.schedules, updated_at=NOW()
                """,
                [
                    store_pk,
                    json.dumps(d.get("villages") or []),
                    d.get("default_village"),
                    json.dumps(d.get("med_types") or []),
                    json.dumps(d.get("schedules") or []),
                ],
            )
    except Exception as e:
        print("  settings/dropdowns skip:", e)


def main():
    print("Firebase READ-ONLY import → Postgres")
    print("SA:", SA_PATH)
    if not SA_PATH.is_file():
        print("Missing service account")
        sys.exit(2)

    db = fb_client()
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    # Map store_id -> preferred android_key (latest)
    key_map = {}
    name_map = {}
    print("Reading store_keys (read-only)...")
    for snap in db.collection("store_keys").stream():
        d = snap.to_dict() or {}
        sid = d.get("store_id")
        if not sid:
            continue
        key_map[sid] = snap.id  # last wins; ok
        if d.get("store_name"):
            name_map[sid] = d.get("store_name")
        print(f"  key {snap.id} -> {sid} ({d.get('store_name')})")

    store_refs = [r for r in db.collection("stores").list_documents() if r.id != "_probe"]
    summary = {}
    cascade_failures = []

    for sref in store_refs:
        store_id = sref.id
        print(f"\n======== IMPORT {store_id} ========")
        store_pk = ensure_store(cur, store_id, name_map.get(store_id), key_map.get(store_id))
        conn.commit()
        counts = {}
        for col in COLLECTIONS:
            print(f"  reading {col}...")
            try:
                docs = stream_collection(db, store_id, col)
            except Exception as e:
                print(f"  READ FAIL {col}: {e}")
                counts[col] = f"FAIL:{e}"
                conn.rollback()
                continue
            print(f"  importing {col}: {len(docs)}")
            try:
                IMPORTERS[col](cur, store_pk, docs)
                conn.commit()
                counts[col] = len(docs)
            except Exception as e:
                conn.rollback()
                print(f"  IMPORT FAIL {col}: {e}")
                counts[col] = f"FAIL:{e}"
        import_settings(cur, store_pk, db, store_id)
        conn.commit()
        # Every import ends with the party cascade, so no imported bill keeps a stale due.
        cascade_ok = run_party_cascade(store_pk)
        if not cascade_ok:
            cascade_failures.append(store_id)
        rejected = REJECTED_RETURN_LINES.get(store_pk, [])
        if rejected:
            print(f"  refused {len(rejected)} return line(s) with medicine 0")
        summary[store_id] = {
            "store_pk": store_pk,
            "android_key": key_map.get(store_id),
            "counts": counts,
            "party_cascade": "ok" if cascade_ok else "FAILED -- run scripts/repair_balances.mjs --store=%s" % store_pk,
            "rejected_return_lines": [
                {"collection": c, "return_id": rid, "qty": q, "amount": a} for (c, rid, q, a) in rejected
            ],
        }

    # deactivate demo seed stores that aren't in firebase if desired? keep them.
    cur.close()
    conn.close()

    out = Path("/opt/Satpuda-Core-Server/firebase_import_report.json")
    out.write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print("\nWrote", out)
    print(json.dumps(summary, indent=2, default=str))
    if cascade_failures:
        print("Party cascade FAILED for:", ", ".join(cascade_failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
