"""Doctor margin rules parity vectors, made by RUNNING the PC python.

usage: python scripts/make-doctor-margin-rules-vectors.py <mac2 checkout> <out.json>

  pure    random rules / bills / purchases -> compute() and the saved-lines pipeline
          (bill_lines at save, read in saved order, the report's rate choice by with_basis)
  units   margin_unit_divisor / _units_per_pack (no logged stock units)
  store   a real PC store (SQLite, db_setup): bills saved, rules changed, a bill saved before
          any rules, Recalculate of one day, a later purchase -> build_report, with the raw rows
          in the server's shape and the times each thing happened
Every store is built here; no real data.
"""
import json
import os
import random
import sqlite3
import sys
import tempfile
from unittest import mock

ROOT, OUT = sys.argv[1], sys.argv[2]
sys.path.insert(0, ROOT)

from core import doctor_margin_rules as dmr  # noqa: E402
from core import doctor_margin_rules_report as rr  # noqa: E402

rng = random.Random(20261023)
TYPES = ["Injection", "Tablet", "Syrup", "Capsule", "Drops"]
DOCTORS = ["Dr A", "dr  b", "DR C", "", "Dr D", "(No doctor)"]

# medicine rows: (id, product, type, batch)
MEDS = []
mid = 0
for t in TYPES:
    for p in range(4):
        name = f"{t[:3].upper()} PROD {p}" + (" 1GM" if t == "Injection" else "")
        for b in range(rng.choice([1, 2, 3])):
            mid += 1
            MEDS.append((mid, name, t, f"B{p}{b}"))


def variant(s):
    """The same name as the shop might type it: case and spaces."""
    r = rng.random()
    if r < 0.3:
        return s.lower()
    if r < 0.5:
        return "  " + s.replace(" ", "   ") + " "
    return s


def rand_margin(allow_none):
    k = rng.choice(["mrp_rate", "pct_mrp", "fixed"] + (["none"] if allow_none else []))
    v = {"pct_mrp": rng.choice([5, 7.5, 10, 12.5, 33.3, 0]), "fixed": rng.choice([1, 2.5, 3.33, 10, 0.07, 0])}.get(k, 0)
    return {"kind": k, "value": v}


def rand_type_rule(t):
    mode = rng.choice(["none", "type", "groups", "groups", "bogus"])
    rule = {"type": variant(t), "mode": mode}
    if mode == "type":
        rule["margin"] = rand_margin(False) if rng.random() < 0.85 else None
    elif mode == "groups":
        prods = sorted({m[1] for m in MEDS if m[2] == t})
        groups = []
        for gi in range(rng.choice([1, 2, 3])):
            items = []
            for p in rng.sample(prods, rng.choice([1, 1, 2, 3])):
                batches = [m[3] for m in MEDS if m[1] == p]
                pick = [] if rng.random() < 0.6 else rng.sample(batches, 1)
                items.append({"product": variant(p), "batches": [variant(b) for b in pick]})
            if rng.random() < 0.1:
                items = []  # a group with no products is dropped
            groups.append({"name": rng.choice(["", f"G{gi}", "  Cef  group "]), "margin": rand_margin(True), "items": items})
        rule["groups"] = groups
        rule["rest"] = rand_margin(True) if rng.random() < 0.6 else None
    return rule


def rand_rules():
    sets = [{"doctor": "", "types": [rand_type_rule(t) for t in TYPES if rng.random() < 0.8]}]
    for d in rng.sample(["Dr A", "DR C", "dr d", "(No doctor)"], rng.choice([0, 1, 2])):
        sets.append({"doctor": variant(d), "rate_basis": rng.choice([None, "purchase", "purchase_free", "x"]),
                     "types": [rand_type_rule(t) for t in TYPES if rng.random() < 0.4]})
    rng.shuffle(sets)
    return {"rate_basis": rng.choice(["purchase", "purchase_free", "", "PURCHASE_FREE"]), "sets": sets,
            "updated": "2026-10-20T10:00:00"}


def rand_sales(n):
    sales = []
    for sid in range(1, n + 1):
        items = []
        for k in range(rng.choice([1, 2, 3, 4, 5])):
            m = rng.choice(MEDS)
            div = rng.choice([1, 1, 10, 15, 3])
            mrp = rng.choice([66.64, 100, 45.5, 12.35, 250, 9.99])
            items.append({
                "id": sid * 100 + k, "medicine_id": m[0], "name": m[1], "type": m[2], "batch": m[3],
                "qty": rng.choice([1, 2, 3, 5, 10, 12, 0]),
                "mrp_unit": mrp / div,
                "med_rate_unit": rng.choice([0, 0, mrp * 0.7 / div]),
                "cost_price": rng.choice([0, 0, round(mrp * 0.65 / div, 4)]),
            })
        returns = []
        if rng.random() < 0.3:
            it = rng.choice(items)
            returns.append({"medicine_id": it["medicine_id"], "qty": rng.choice([1, 2, 7])})
        sales.append({"id": sid, "bill_no": f"SCB{sid % 7}" if rng.random() < 0.2 else f"SCB{sid}",
                      "date": f"2026-10-{rng.randint(11, 20)}", "patient": f"PATIENT {sid}",
                      "doctor": rng.choice(DOCTORS), "items": items, "returns": returns})
    return sales


def rand_purchases():
    out = []
    for m in MEDS:
        if rng.random() < 0.25:
            continue  # no purchase line: the batch's own rate / the bill's cost
        for _ in range(rng.choice([1, 1, 2, 3])):
            out.append({"medicine_id": m[0], "qty": rng.choice([0, 2, 5, 10, 3.5]), "free_qty": rng.choice([0, 0, 1, 5]),
                        "rate": rng.choice([10, 21.47, 50, 33.33, 66.67, 120]), "units": rng.choice([1, 1, 10, 15])})
    return out


def saved_pipeline(sales, purchases, rules, opts):
    """The PC's saved-lines report in memory: bill_lines when saved (no rate choice), the
    lines of the doctors asked in read_lines order, then the report's rate choice."""
    res = dmr.Resolver(rules)
    rates = dmr.batch_rates(purchases)
    want = {dmr.norm_name(d) for d in (opts.get("doctors") or []) if dmr.norm_name(d)}
    lines = []
    for s in sales:
        lines.extend(r for r in dmr.bill_lines(res, s, rates) if r["qty"] > 0)
    lines = [r for r in lines if not want or r["doctor"] in want]
    lines.sort(key=lambda r: (r["doctor"], r["name"], r["batch"], r["date"], r["bill_no"], r["line_no"]))
    basis = str(opts.get("rate_basis") or "").strip().lower()
    if basis in dmr.RATE_BASES:
        lines = [dmr.with_basis(r, basis) for r in lines]
    rep = dmr.assemble(lines)
    rep["products"] = rr.by_product(rep["rows"])
    return rep


def pure_cases():
    cases = []
    for i in range(6):
        rules = rand_rules()
        sales = rand_sales(25)
        purchases = rand_purchases()
        try:
            clean = dmr.clean_rules(rules)
        except ValueError as exc:
            cases.append({"name": f"random {i} (refused)", "rules": rules, "error": str(exc)})
            continue
        probes = []
        for _ in range(40):
            m = rng.choice(MEDS)
            d = rng.choice(DOCTORS)
            probes.append({"args": [d, variant(m[2]), variant(m[1]), variant(m[3])], "out": dmr.Resolver(rules).resolve(d, variant(m[2]), m[1], m[3])})
        runs = []
        for opts in ({}, {"rate_basis": "purchase"}, {"rate_basis": "purchase_free", "doctors": ["dr a", "DR C ", ""]}):
            runs.append({"opts": opts, "compute": dmr.compute(sales, purchases, rules, opts),
                         "saved": saved_pipeline(sales, purchases, rules, opts)})
        cases.append({
            "name": f"random {i}", "rules": rules, "clean": clean, "has_rules": dmr.has_rules(rules),
            "sales": sales, "purchases": purchases,
            "rates": {str(k): v for k, v in dmr.batch_rates(purchases).items()},
            "probes": probes, "runs": runs,
        })
    return cases


def clean_cases():
    inputs = [
        None, "", "not json", "[1,2]", {"rate_basis": "PURCHASE_FREE"},
        {"sets": [{"doctor": "Dr  x", "types": [{"type": " Tablet ", "mode": "TYPE", "margin": {"kind": "pct_mrp", "value": "12.5"}}]}]},
        {"sets": [{"doctor": "", "types": [{"type": "Tablet", "mode": "type", "margin": {"kind": "pct_mrp", "value": 140}}]}]},
        {"sets": [{"doctor": "", "types": [{"type": "Tablet", "mode": "type", "margin": {"kind": "fixed", "value": -1}}]}]},
        {"sets": [{"doctor": "", "types": [{"type": "Inj", "mode": "groups", "groups": [
            {"name": "", "margin": {"kind": "fixed", "value": 3}, "items": ["zifi", {"product": "ZIFI", "batches": ["b2"]},
                                                                              {"name": "lyc", "batches": ["x", " y "]},
                                                                              {"product": "lyc", "batches": ["a"]}]},
            {"name": "E", "margin": None, "items": [{"product": " "}]},
            {"name": "N", "margin": "bad", "items": ["one"]}], "rest": {"kind": "none"}}]},
            {"doctor": "dr b", "types": []}, {"doctor": "DR B", "types": [{"type": "x", "mode": "none"}]},
            {"doctor": "(no doctor)", "types": []}, "junk"]},
        json.dumps({"updated": "2026-10-22T11:00:00", "sets": [{"doctor": "Z", "rate_basis": "purchase_free", "types": [
            {"type": "Syrup", "mode": "groups", "groups": [], "rest": {"kind": "mrp_rate", "value": 9}},
            {"type": "syrup", "mode": "type"}]}]}),
    ]
    out = []
    for raw in inputs:
        try:
            out.append({"in": raw, "out": dmr.clean_rules(raw), "has": dmr.has_rules(raw)})
        except ValueError as exc:
            out.append({"in": raw, "error": str(exc)})
    return out


def unit_cases():
    from core.doctor_margin_report import _units_per_pack
    from core.margin_utils import margin_unit_divisor

    div = []
    for t in ["Tablet", "tablet", "Capsule", "Bolus", "Tablet Pack", "Syrup", "Injection", "Ointment", "Others", "Gel"]:
        for u in ["10", "1", "", "15", "1*10", "1X15", "30ML", "d", "TAB", "100GM", "10.5", "strip of 10", "0"]:
            for n in ["DOLO 650", "ZIFI 10 TAB", "AB 1*15 STRIP", "CROCIN 500MG", "X 2 CAPSULE"]:
                with mock.patch("core.sync_prefs.is_online_mode", lambda *a, **k: False):
                    d = margin_unit_divisor({"type": t, "unit": u or "1", "name": n})
                div.append({"type": t, "unit": u, "name": n, "div": d})
    units = []
    cache = {}
    for t in ["Tablet", "Capsule", "Bolus", "Tablet Pack", "Syrup", "Injection", "Others"]:
        for u in ["10", "1", "15", "1*10", "30ML", "d", "2000", "0"]:
            for q, fr in ((2, 1), (10, 0), (0, 0), (3.5, 0.5)):
                units.append({"type": t, "unit": u, "qty": q, "free": fr,
                              "units": _units_per_pack(t, u, float(q), float(fr), None, cache)})
    return {"divisor": div, "units_per_pack": units}


# ── a real PC store ───────────────────────────────────────────────────────────────────────

def store_case():
    from core import db_setup
    from core import doctor_margin_store as st
    from core.desktop_settings_service import _setting_get, _setting_set

    p = mock.patch("core.sync_prefs.is_online_mode", lambda *a, **k: False)
    p.start()
    try:
        conn = sqlite3.connect(os.path.join(tempfile.mkdtemp(), "store.db"))
        db_setup.initialise(conn)
        c = conn
        sup = c.execute("INSERT INTO suppliers (name) VALUES ('TEST SUPPLIER')").lastrowid
        meds = {}

        def med(key, name, mtype, batch, unit, mrp, rate=0):
            meds[key] = c.execute("INSERT INTO medicines (name, type, batch_no, unit, mrp, rate, stock_qty) "
                                  "VALUES (?,?,?,?,?,?,50)", (name, mtype, batch, unit, mrp, rate)).lastrowid

        med("zifi", "ZIFI 1GM", "Injection", "Z1", "1", 66.64)
        med("zifi2", "ZIFI 1GM", "Injection", "Z2", "1", 70)
        med("lyc", "LYCEFT 1GM", "Injection", "L1", "1", 66.40)
        med("tab", "TAB S", "Tablet", "T1", "10", 100)
        med("tab15", "DOLO 15 TAB", "Tablet", "D1", "1", 30)   # strip MRP on a unit-1 row: 15 from the name
        med("syr", "SYR Z", "Syrup", "S1", "1", 90)
        med("old", "OPENING INJ", "Injection", "O1", "1", 50, rate=20)  # no purchase bill
        clock = {"t": 1_000_000}
        times = {}

        def tick(label):
            clock["t"] += 60_000
            times[label] = clock["t"]
            return clock["t"]

        purchases = []  # server shape

        def purchase(label, lines):
            pid = c.execute("INSERT INTO purchases (purchase_no, supplier_id, purchase_date) VALUES (?,?, '2026-10-01')",
                            (label, sup)).lastrowid
            at = tick(label)
            for key, mtype, qty, free, rate in lines:
                c.execute("INSERT INTO purchase_items (purchase_id, medicine_id, type, qty, free_qty, rate) VALUES (?,?,?,?,?,?)",
                          (pid, meds[key], mtype, qty, free, rate))
                purchases.append({"medicine_id": meds[key], "qty": qty, "free_qty": free, "rate": rate, "type": mtype,
                                  "unit": c.execute("SELECT unit FROM medicines WHERE id=?", (meds[key],)).fetchone()[0],
                                  "tps": 0, "saved_ms": at})
            c.commit()

        bills = []

        def sale(bill, doctor, lines, date, sync=True):
            cust = c.execute("INSERT INTO customers (name) VALUES (?)", (f"PATIENT {bill}",)).lastrowid
            sid = c.execute("INSERT INTO sales (bill_no, bill_date, doctor_name, customer_id, customer_name, total_amount) "
                            "VALUES (?,?,?,?,?,0)", (bill, date, doctor, cust, f"PATIENT {bill}")).lastrowid
            for key, qty in lines:
                c.execute("INSERT INTO sales_items (sale_id, medicine_id, qty, rate, amount, cost_price) VALUES (?,?,?,?,?,?)",
                          (sid, meds[key], qty, 1, qty, 4 if key == "old" else 0))
            c.commit()
            at = tick(bill)
            bills.append({"id": sid, "local_id": sid, "bill_no": bill, "d": date, "doctor_name": doctor,
                          "patient": f"PATIENT {bill}", "saved_ms": at})
            if sync:
                st.sync_sale(c, sid)
            return sid

        def rules_set(rules, updated):
            r = dmr.clean_rules(dict(rules, updated=updated))
            _setting_set(c, dmr.SETTING_NAME, json.dumps(r, separators=(",", ":")))
            c.commit()
            return {"value": json.dumps(r, separators=(",", ":")), "at": tick(f"rules {updated}"), "updated": updated}

        purchase("P1", [("zifi", "Injection", 10, 5, 10), ("zifi2", "Injection", 10, 0, 40), ("lyc", "Injection", 10, 0, 21.47),
                        ("tab", "Tablet", 2, 0, 50), ("tab15", "Tablet", 4, 1, 22.5), ("syr", "Syrup", 5, 0, 40)])
        e = sale("S1", "Dr A", [("zifi", 2), ("tab15", 9)], "2026-10-11")  # before any rules: worked out later
        v1 = rules_set({"rate_basis": "purchase_free", "sets": [
            {"doctor": "", "types": [
                {"type": "Injection", "mode": "groups", "rest": {"kind": "pct_mrp", "value": 5}, "groups": [
                    {"name": "Zifi own", "margin": {"kind": "mrp_rate"}, "items": [{"product": "ZIFI 1GM"}]},
                    {"name": "Z2 only", "margin": {"kind": "fixed", "value": 7}, "items": [{"product": "ZIFI 1GM", "batches": ["Z2"]}]}]},
                {"type": "Tablet", "mode": "type", "margin": {"kind": "mrp_rate"}}]},
            {"doctor": "Dr B", "rate_basis": "purchase", "types": [{"type": "Injection", "mode": "type", "margin": {"kind": "fixed", "value": 3}}]}]},
            "2026-10-12T09:00:00")
        rr.build_report(c, {"from": "2026-10-01", "to": "2026-10-31"})  # the report opened: S1 worked out with v1
        a = sale("S2", "Dr A", [("zifi", 3), ("syr", 1), ("tab", 10), ("zifi", 1)], "2026-10-12")
        b = sale("S3", "Dr B", [("zifi2", 4), ("lyc", 2), ("old", 2)], "2026-10-13")
        v2 = rules_set({"rate_basis": "purchase", "sets": [{"doctor": "", "types": [
            {"type": "Injection", "mode": "type", "margin": {"kind": "pct_mrp", "value": 10}},
            {"type": "Tablet", "mode": "none"}]}]}, "2026-10-14T09:00:00")
        cc = sale("S4", "Dr A", [("zifi", 2), ("lyc", 1), ("tab", 5)], "2026-10-14")
        d = sale("S5", "dr b", [("zifi", 6)], "2026-10-15")
        purchase("P2", [("zifi", "Injection", 10, 0, 30), ("lyc", "Injection", 5, 5, 20)])  # after S1..S5
        # returns
        rid = c.execute("INSERT INTO sales_returns (return_no, sale_id, return_date) VALUES ('R1',?, '2026-10-16')", (a,)).lastrowid
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,3)", (rid, meds["zifi"]))
        rid2 = c.execute("INSERT INTO sales_returns (return_no, sale_id, return_date) VALUES ('R2',?, '2026-10-16')", (d,)).lastrowid
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,2)", (rid2, meds["zifi"]))
        c.commit()
        st.refresh_returns(c, [a, d])
        # Recalculate the day of S3 only: S3 with v2 and today's purchases (P2 too)
        rr.build_report(c, {"from": "2026-10-13", "to": "2026-10-13", "recalculate": True})
        run = json.loads(_setting_get(c, dmr.RECALC_SETTING, ""))["runs"][-1]
        recalc_at = tick("recalc")
        f = sale("S6", "DR C", [("zifi", 1), ("tab15", 30)], "2026-10-13", sync=False)  # arrived by sync after the recalc
        reports = []
        for body in ({}, {"rate_basis": "purchase"}, {"rate_basis": "purchase_free", "doctors": ["DR A", "dr b"]},
                     {"view": "detail"}):
            q = dict({"from": "2026-10-10", "to": "2026-10-20"}, **body)
            rep = rr.build_report(c, q)
            for row in rep["rows"]:
                row.pop("saved_at", None)
            for g in rep["products"]:
                for row in g["lines"]:
                    row.pop("saved_at", None)
            reports.append({"q": q, "expect": {k: rep[k] for k in ("rows", "summary", "doctors", "totals", "products", "flag_counts")}})
        items = []
        for sid, iid, mid, qty, cost in c.execute(
                "SELECT sale_id, id, medicine_id, qty, cost_price FROM sales_items ORDER BY sale_id, id"):
            name, mtype, batch, unit, mrp, rate = c.execute(
                "SELECT name, type, batch_no, unit, mrp, rate FROM medicines WHERE id=?", (mid,)).fetchone()
            items.append({"id": iid, "sale_id": sid, "medicine_id": mid, "name": name, "type": mtype, "batch": batch,
                          "unit": unit, "mrp": mrp, "rate": rate, "qty": qty, "cost_price": cost})
        rets = [{"sale_id": s, "medicine_id": m, "qty": q} for s, m, q in c.execute(
            "SELECT sr.sale_id, sri.medicine_id, SUM(sri.qty) FROM sales_return_items sri JOIN sales_returns sr "
            "ON sr.id = sri.return_id GROUP BY sr.sale_id, sri.medicine_id ORDER BY 1, 2")]
        conn.close()
        return {
            "name": "PC store: rules changed, a bill before any rules, a recalculated day, a later purchase",
            "history": [{"id": 1, "value": v1["value"], "effective_at": v1["at"], "saved_at": v1["at"]},
                        {"id": 2, "value": v2["value"], "effective_at": v2["at"], "saved_at": v2["at"]}],
            "current": {"value": v2["value"], "updated_at": v2["at"]},
            "recalc": {"version": 1, "runs": [dict(run, at=recalc_at)]},
            "bills": bills, "items": items, "returns": rets, "purchases": purchases,
            "reports": reports, "ids": {"S1": e, "S2": a, "S3": b, "S4": cc, "S5": d, "S6": f},
        }
    finally:
        p.stop()


out = {
    "made_by": "scripts/make-doctor-margin-rules-vectors.py over the PC's core/doctor_margin_rules.py (python, seeded)",
    "pure": pure_cases(),
    "clean": clean_cases(),
    "units": unit_cases(),
    "store": store_case(),
}
with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
print("cases", len(out["pure"]), "clean", len(out["clean"]), "div", len(out["units"]["divisor"]),
      "store reports", len(out["store"]["reports"]), "bytes", os.path.getsize(OUT))
