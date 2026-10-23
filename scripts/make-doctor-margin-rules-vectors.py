"""Doctor margin rules parity vectors, made by RUNNING the PC python.

usage: python scripts/make-doctor-margin-rules-vectors.py <mac2 checkout> <out.json>

  pure    random rules (version 2 -- modes none / groups / sales, "All products" groups,
          sales_pct set and null -- and version 1 still read: mode 'type', 'rest') / bills
          (lines with sale_rate / amount / disc / pack) / purchases -> compute() and the
          saved-lines pipeline (bill_lines at save, read in saved order, the report's rate
          choice by with_basis); both ways, `sales` and `grand`
  units   margin_unit_divisor / _units_per_pack (no logged stock units) / pack_text
  store   a real PC store (SQLite, db_setup): bills saved, rules changed (a version 1 value,
          then version 2 with total-sales types and an All-products group, then a new %), a
          bill saved before any rules, Recalculate of one day, a later purchase, returns on
          both ways -> build_report, with the raw rows in the server's shape and the times
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
    # "type" (and "rest") are version 1: still read, turned into version 2.
    mode = rng.choice(["none", "type", "groups", "groups", "groups", "sales", "sales", "bogus", "SALES"])
    rule = {"type": variant(t), "mode": mode}
    if mode == "type":
        rule["margin"] = rand_margin(False) if rng.random() < 0.85 else None
    elif mode == "groups":
        prods = sorted({m[1] for m in MEDS if m[2] == t})
        groups = []
        for gi in range(rng.choice([1, 2, 3])):
            if rng.random() < 0.2:  # "All products of this type" (odd truthy / falsy values too)
                groups.append({"name": rng.choice(["", f"All G{gi}"]), "margin": rand_margin(True),
                               "all": rng.choice([True, True, 1, "yes", 0, [], None]),
                               "items": rng.choice([[], [variant(prods[0])]])})
                continue
            items = []
            for p in rng.sample(prods, rng.choice([1, 1, 2, 3])):
                batches = [m[3] for m in MEDS if m[1] == p]
                pick = [] if rng.random() < 0.6 else rng.sample(batches, 1)
                items.append({"product": variant(p), "batches": [variant(b) for b in pick]})
            if rng.random() < 0.1:
                items = []  # a group with no products is dropped
            groups.append({"name": rng.choice(["", f"G{gi}", "  Cef  group "]), "margin": rand_margin(True),
                           "all": rng.choice([False, False, None]), "items": items})
        rule["groups"] = groups
        if rng.random() < 0.4:
            rule["rest"] = rand_margin(True)  # version 1: dropped
    return rule


def rand_rules():
    sets = [{"doctor": "", "sales_pct": rng.choice([None, 0, 5, 7.5, "10", 12.345, ""]),
             "types": [rand_type_rule(t) for t in TYPES if rng.random() < 0.8]}]
    for d in rng.sample(["Dr A", "DR C", "dr d", "(No doctor)"], rng.choice([0, 1, 2])):
        sets.append({"doctor": variant(d), "rate_basis": rng.choice([None, "purchase", "purchase_free", "x"]),
                     "sales_pct": rng.choice([None, 3, 15, "", "2.5", 0]),
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
            qty = rng.choice([1, 2, 3, 5, 10, 12, 0])
            sale_rate = round(mrp / div * rng.choice([1, 1, 0.9, 0.955]), rng.choice([2, 4]))
            disc = rng.choice([0, 0, 0, 1.5, round(qty * sale_rate * 0.1, 2), 0.333])
            items.append({
                "id": sid * 100 + k, "medicine_id": m[0], "name": m[1], "type": m[2], "batch": m[3],
                "qty": qty,
                "mrp_unit": mrp / div,
                "med_rate_unit": rng.choice([0, 0, mrp * 0.7 / div]),
                "cost_price": rng.choice([0, 0, round(mrp * 0.65 / div, 4)]),
                "sale_rate": sale_rate, "disc": disc,
                "amount": rng.choice([qty * sale_rate - disc, round(qty * sale_rate - disc, 2), qty * sale_rate]),
                "pack": rng.choice(["", "10", "15", "30ML", "1*10"]),
            })
        returns = []
        if rng.random() < 0.3:
            it = rng.choice(items)
            returns.append({"medicine_id": it["medicine_id"], "qty": rng.choice([1, 2, 7, 0.5])})
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
    for i in range(8):
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
    v2 = {"version": 2, "rate_basis": "purchase", "updated": "2026-10-23T10:00:00", "sets": [
        {"doctor": "", "sales_pct": "7.5", "types": [
            {"type": "Syrup", "mode": "sales"},
            {"type": "Injection", "mode": "groups", "groups": [
                {"name": "", "all": True, "margin": {"kind": "pct_mrp", "value": 10}, "items": ["dropped"]},
                {"name": "Own", "all": False, "margin": {"kind": "fixed", "value": 2}, "items": ["zifi"]},
                {"name": "Empty all", "all": [], "margin": {"kind": "fixed", "value": 2}, "items": []}]}]},
        {"doctor": "dr q", "sales_pct": None, "types": [{"type": "Tablet", "mode": "Sales"}]},
        {"doctor": "dr r", "sales_pct": "", "types": []},
        {"doctor": "dr s", "sales_pct": 0, "types": [{"type": "Tablet", "mode": "groups", "groups": [
            {"all": "yes", "margin": None}]}]}]}
    inputs = [
        v2, json.dumps(v2),
        {"sets": [{"doctor": "", "sales_pct": None, "types": [{"type": "Syrup", "mode": "sales"}]}]},
        {"sets": [{"doctor": "", "sales_pct": 140, "types": []}]},
        {"sets": [{"doctor": "dr x", "sales_pct": -1, "types": []}]},
        {"sets": [{"doctor": "", "sales_pct": "ten", "types": []}]},
        {"sets": [{"doctor": "", "sales_pct": 0, "types": [{"type": "Syrup", "mode": "sales"}]}]},
        {"sets": [{"doctor": "", "types": [{"type": "Inj", "mode": "groups", "groups": [
            {"name": "N", "all": True, "margin": {"kind": "none"}}]}]}]},
        {"version": 1, "sets": [{"doctor": "", "types": [{"type": "Tablet", "mode": "type"},
                                                          {"type": "Inj", "mode": "groups", "groups": [],
                                                           "rest": {"kind": "fixed", "value": 1}}]}]},
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
    from core.doctor_margin_store import pack_text

    packs = [{"unit": u, "pack": pack_text(u)} for u in ["10", "1", "", "0", " 30  ML ", "1*15", None, 15, 1, 0]]
    units = []
    cache = {}
    for t in ["Tablet", "Capsule", "Bolus", "Tablet Pack", "Syrup", "Injection", "Others"]:
        for u in ["10", "1", "15", "1*10", "30ML", "d", "2000", "0"]:
            for q, fr in ((2, 1), (10, 0), (0, 0), (3.5, 0.5)):
                units.append({"type": t, "unit": u, "qty": q, "free": fr,
                              "units": _units_per_pack(t, u, float(q), float(fr), None, cache)})
    return {"divisor": div, "units_per_pack": units, "pack": packs}


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
        med("syr", "SYR Z", "Syrup", "S1", "100ML", 90)
        med("cap", "CAP OMEZ", "Capsule", "C1", "15", 150)     # total sales: rate per capsule
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
            """lines: (medicine, qty) or (medicine, qty, rate per unit as billed, line discount)."""
            cust = c.execute("INSERT INTO customers (name) VALUES (?)", (f"PATIENT {bill}",)).lastrowid
            sid = c.execute("INSERT INTO sales (bill_no, bill_date, doctor_name, customer_id, customer_name, total_amount) "
                            "VALUES (?,?,?,?,?,0)", (bill, date, doctor, cust, f"PATIENT {bill}")).lastrowid
            for ln in lines:
                key, qty = ln[0], ln[1]
                rate, disc = (ln[2], ln[3]) if len(ln) > 2 else (1, 0)
                c.execute("INSERT INTO sales_items (sale_id, medicine_id, qty, rate, amount, item_discount, cost_price) "
                          "VALUES (?,?,?,?,?,?,?)",
                          (sid, meds[key], qty, rate, round(qty * rate - disc, 2), disc, 4 if key == "old" else 0))
            c.commit()
            at = tick(bill)
            bills.append({"id": sid, "local_id": sid, "bill_no": bill, "d": date, "doctor_name": doctor,
                          "patient": f"PATIENT {bill}", "saved_ms": at})
            if sync:
                st.sync_sale(c, sid)
            return sid

        def rules_set(rules, updated, raw=False):
            """raw: the value kept exactly as given (a version 1 value a PC of 22 Oct wrote)."""
            r = dict(rules, updated=updated) if raw else dmr.clean_rules(dict(rules, updated=updated))
            _setting_set(c, dmr.SETTING_NAME, json.dumps(r, separators=(",", ":")))
            c.commit()
            return {"value": json.dumps(r, separators=(",", ":")), "at": tick(f"rules {updated}"), "updated": updated}

        purchase("P1", [("zifi", "Injection", 10, 5, 10), ("zifi2", "Injection", 10, 0, 40), ("lyc", "Injection", 10, 0, 21.47),
                        ("tab", "Tablet", 2, 0, 50), ("tab15", "Tablet", 4, 1, 22.5), ("syr", "Syrup", 5, 0, 40),
                        ("cap", "Capsule", 3, 0, 90)])
        e = sale("S1", "Dr A", [("zifi", 2), ("tab15", 9), ("syr", 1, 90, 4.5)], "2026-10-11")  # before any rules
        v1 = rules_set({"version": 1, "rate_basis": "purchase_free", "sets": [
            {"doctor": "", "types": [
                {"type": "Injection", "mode": "groups", "rest": {"kind": "pct_mrp", "value": 5}, "groups": [
                    {"name": "Zifi own", "margin": {"kind": "mrp_rate"}, "items": [{"product": "ZIFI 1GM"}]},
                    {"name": "Z2 only", "margin": {"kind": "fixed", "value": 7}, "items": [{"product": "ZIFI 1GM", "batches": ["Z2"]}]}]},
                {"type": "Tablet", "mode": "type", "margin": {"kind": "mrp_rate"}}]},
            {"doctor": "Dr B", "rate_basis": "purchase", "types": [{"type": "Injection", "mode": "type", "margin": {"kind": "fixed", "value": 3}}]}]},
            "2026-10-12T09:00:00", raw=True)
        rr.build_report(c, {"from": "2026-10-01", "to": "2026-10-31"})  # the report opened: S1 worked out with v1
        a = sale("S2", "Dr A", [("zifi", 3), ("syr", 1, 90, 0), ("tab", 10), ("zifi", 1), ("cap", 15, 10, 7.5)], "2026-10-12")
        b = sale("S3", "Dr B", [("zifi2", 4), ("lyc", 2), ("old", 2), ("syr", 2, 85.5, 0)], "2026-10-13")
        two_ways = {"rate_basis": "purchase", "sets": [
            {"doctor": "", "sales_pct": 5, "types": [
                {"type": "Injection", "mode": "groups", "groups": [
                    {"name": "All injections", "all": True, "margin": {"kind": "pct_mrp", "value": 10}},
                    {"name": "Lyc", "margin": {"kind": "fixed", "value": 4}, "items": [{"product": "LYCEFT 1GM"}]}]},
                {"type": "Tablet", "mode": "none"},
                {"type": "Syrup", "mode": "sales"},
                {"type": "Capsule", "mode": "sales"}]},
            {"doctor": "Dr B", "sales_pct": 12.5, "types": [{"type": "Capsule", "mode": "sales"}]},
            {"doctor": "DR C", "sales_pct": None, "types": [{"type": "Tablet", "mode": "sales"}]}]}
        v2 = rules_set(two_ways, "2026-10-14T09:00:00")
        cc = sale("S4", "Dr A", [("zifi", 2), ("lyc", 1), ("tab", 5), ("syr", 3, 90, 13.5), ("cap", 10, 10, 0)], "2026-10-14")
        d = sale("S5", "dr b", [("zifi", 6), ("cap", 5, 9.5, 2.5), ("syr", 1, 90, 0)], "2026-10-15")
        v3 = rules_set(dict(two_ways, sets=[dict(two_ways["sets"][0], sales_pct=8)] + two_ways["sets"][1:]),
                       "2026-10-15T18:00:00")
        g = sale("S7", "Dr A", [("syr", 2, 90, 0), ("cap", 3, 10, 1)], "2026-10-16")  # the new %: two % for Dr A
        purchase("P2", [("zifi", "Injection", 10, 0, 30), ("lyc", "Injection", 5, 5, 20)])  # after S1..S7
        # returns: on profit lines and on total-sales lines (pro rata)
        rid = c.execute("INSERT INTO sales_returns (return_no, sale_id, return_date) VALUES ('R1',?, '2026-10-16')", (a,)).lastrowid
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,3)", (rid, meds["zifi"]))
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,5)", (rid, meds["cap"]))
        rid2 = c.execute("INSERT INTO sales_returns (return_no, sale_id, return_date) VALUES ('R2',?, '2026-10-16')", (d,)).lastrowid
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,2)", (rid2, meds["zifi"]))
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,1)", (rid2, meds["syr"]))
        rid3 = c.execute("INSERT INTO sales_returns (return_no, sale_id, return_date) VALUES ('R3',?, '2026-10-16')", (cc,)).lastrowid
        c.execute("INSERT INTO sales_return_items (return_id, medicine_id, qty) VALUES (?,?,4)", (rid3, meds["cap"]))
        c.commit()
        st.refresh_returns(c, [a, d, cc])
        # Recalculate the day of S3 only: S3 with today's rules (v3) and today's purchases (P2 too)
        rr.build_report(c, {"from": "2026-10-13", "to": "2026-10-13", "recalculate": True})
        run = json.loads(_setting_get(c, dmr.RECALC_SETTING, ""))["runs"][-1]
        recalc_at = tick("recalc")
        f = sale("S6", "DR C", [("zifi", 1), ("tab15", 30, 2, 3), ("syr", 1, 90, 0)], "2026-10-13", sync=False)  # by sync
        reports = []
        for body in ({}, {"rate_basis": "purchase"}, {"rate_basis": "purchase_free", "doctors": ["DR A", "dr b"]},
                     {"view": "detail"}):
            q = dict({"from": "2026-10-10", "to": "2026-10-20"}, **body)
            rep = rr.build_report(c, q)
            for row in rep["rows"] + rep["sales"]["rows"]:  # the products' lines are these same rows
                row.pop("saved_at", None)
            reports.append({"q": q, "expect": {k: rep[k] for k in ("rows", "summary", "doctors", "totals", "products",
                                                                   "flag_counts", "sales", "grand")}})
        items = []
        for sid, iid, mid, qty, cost, srate, amount, disc in c.execute(
                "SELECT sale_id, id, medicine_id, qty, cost_price, rate, amount, item_discount FROM sales_items "
                "ORDER BY sale_id, id"):
            name, mtype, batch, unit, mrp, rate = c.execute(
                "SELECT name, type, batch_no, unit, mrp, rate FROM medicines WHERE id=?", (mid,)).fetchone()
            items.append({"id": iid, "sale_id": sid, "medicine_id": mid, "name": name, "type": mtype, "batch": batch,
                          "unit": unit, "mrp": mrp, "rate": rate, "qty": qty, "cost_price": cost,
                          "sale_rate": srate, "amount": amount, "disc": disc})
        rets = [{"sale_id": s, "medicine_id": m, "qty": q} for s, m, q in c.execute(
            "SELECT sr.sale_id, sri.medicine_id, SUM(sri.qty) FROM sales_return_items sri JOIN sales_returns sr "
            "ON sr.id = sri.return_id GROUP BY sr.sale_id, sri.medicine_id ORDER BY 1, 2")]
        conn.close()
        return {
            "name": "PC store: rules v1 -> v2 (two ways) -> a new %, a bill before any rules, a recalculated day, "
                    "a later purchase, returns on both ways",
            "history": [{"id": n, "value": v["value"], "effective_at": v["at"], "saved_at": v["at"]}
                        for n, v in enumerate((v1, v2, v3), 1)],
            "current": {"value": v3["value"], "updated_at": v3["at"]},
            "recalc": {"version": 1, "runs": [dict(run, at=recalc_at)]},
            "bills": bills, "items": items, "returns": rets, "purchases": purchases,
            "reports": reports, "ids": {"S1": e, "S2": a, "S3": b, "S4": cc, "S5": d, "S6": f, "S7": g},
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
