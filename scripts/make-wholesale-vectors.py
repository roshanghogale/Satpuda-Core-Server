"""Record the PC engine's wholesale answers for the web's port (src/services/wholesaleSale.js,
src/services/wholesaleInvoice.js). Synthetic data only, no shop data, no database.

    python scripts/make-wholesale-vectors.py <path to mac2 checkout> > test/fixtures/wholesale_vectors.json

test/wholesaleSale.test.mjs must match every answer.
"""
from __future__ import annotations

import json
import random
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else r"D:\projects\mac2")

from bill_templates.wholesale_invoice import render_wholesale_invoices_html  # noqa: E402
from core import wholesale_party, wholesale_sale as ws  # noqa: E402
from core.customer_gst import gstin_problem  # noqa: E402

rng = random.Random(20261019)
RATES = (0, 5, 12, 18, 28)
HSN = ("3004", "30049099", "3003", "", "9018")
STATE_CASES = ("27", "27", "27", "24", "", "7", "99")


def rate():
    kind = rng.random()
    if kind < 0.4:
        return round(rng.uniform(1, 900), 2)
    if kind < 0.7:
        return round(rng.uniform(0.5, 120), 4)
    if kind < 0.85:
        return rng.choice([10, 25.5, 99.99, 0.125, 2.675, 1.005, 333.335])
    return str(round(rng.uniform(1, 500), 3))


def line():
    return {
        "qty": rng.choice([1, 2, 3, 5, 10, 12, 25, 100, 7, "4", 0, -2, 2.5]),
        "free": rng.choice([0, 0, 0, 1, 2, 5, None]),
        "rate": rate(),
        "disc_pct": rng.choice([0, 0, 2.5, 5, 7.25, 10, 12.5, "3", None]),
        "scheme_pct": rng.choice([0, 0, 0, 2, 3.5, 5, 8.33]),
        "gst_percent": rng.choice(RATES + (12,) * 3),
        "hsn_code": rng.choice(HSN),
        "name": "MED",
    }


out = {"invoices": [], "words": [], "from_row": [], "credit": [], "returns_used": [], "states": [],
       "gstin": [], "party": [], "tier": [], "pack": [], "city": [], "html": []}

for n in range(400):
    lines = [line() for _ in range(rng.randint(1, 9))]
    shop = rng.choice(STATE_CASES)
    pos = rng.choice(STATE_CASES)
    res = ws.calc_invoice(lines, shop_state=shop, pos=pos)
    out["invoices"].append({"lines": lines, "shop_state": shop, "pos": pos, "expect": res})
    # a saved line read back: units = (packs + free) x units per pack
    for ln in res["lines"]:
        ups = rng.choice([1, 10, 15, 1])
        row = {"qty": (ln["qty"] + ln["free"]) * ups, "free_qty": ln["free"], "taxable": ln["taxable"],
               "item_discount": round(ln["disc_amt"] + ln["scheme_amt"], 2), "scheme_pct": ln["scheme_pct"]}
        if ln["qty"] > 0:
            out["from_row"].append({"row": row, "ups": ups, "expect": ws.line_from_row(row, ups)})

for v in [0, 1, 0.5, 0.05, 7, 19, 20, 21, 99, 100, 101, 999, 1000, 1001, 1205.5, 10000, 99999, 100000,
          100001, 1234567.89, 10000000, 12345678.9, 987654321.01, -45.25, 0.01, 0.99, 2.675, 1.005,
          "1500", None] + [round(rng.uniform(0, 5e6), rng.choice([0, 1, 2])) for _ in range(80)]:
    out["words"].append({"amount": v, "expect": ws.amount_in_words(v)})

for _ in range(120):
    p = {"name": rng.choice(["A MEDICAL", "", None]), "credit_limit": rng.choice([0, 1000, 5000, 25000.5, None]),
         "total_due": rng.choice([0, 500, 4999.99, 12000, None])}
    bill = round(rng.uniform(0, 8000), 2)
    paid = rng.choice([0, 0, 100, bill, round(rng.uniform(0, 8000), 2)])
    this_due = rng.choice([0, 0, 300, 5000])
    out["credit"].append({"party": p, "bill": bill, "paid": paid, "this_due": this_due,
                          "expect": ws.credit_warning(p, bill, paid, this_bill_due=this_due)})
    body = {"returns_settled": rng.choice([0, 0, 50, 900.5]), "returns_total": rng.choice([0, 120.25, 5000])}
    out["returns_used"].append({"grand": bill, "paid": paid, "body": body,
                                "expect": ws.returns_used_in_calc(bill, paid, body)})

for g in ["27AAAPA1234A1Z5", "27aaapa1234a1z5", "24ABCDE1234F1Z9", "", "07", "99AAAPA1234A1Z5", "  27-AAAPA-1234-A1Z5 "]:
    for st in ["27", "7", "", "99", "24", "x5"]:
        for shop in ["27", "", "24"]:
            out["states"].append({"gstin": g, "state": st, "shop": shop,
                                  "pos": ws.place_of_supply(g, st, shop), "clean": ws.clean_state(st),
                                  "name": ws.state_name(st), "from_gstin": ws.state_from_gstin(g),
                                  "intra": ws.is_intra_state(ws.place_of_supply(g, st, shop), ws.clean_state(shop))})

CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def with_check(base14):
    total = 0
    for i, ch in enumerate(base14):
        v = CHARS.index(ch) * (2 if i % 2 else 1)
        total += v // 36 + v % 36
    return base14 + CHARS[(36 - total % 36) % 36]


good = [with_check("27AAAPA1234A1Z"), with_check("24ABCDE1234F1Z"), with_check("07ZZZZZ9999Z9Z")]
for g in good + [good[0][:-1] + ("A" if good[0][-1] != "A" else "B"), "27AAAPA1234A1Z", "ABCDE", "",
                 "99AAAPA1234A1Z5", "27AAAPA1234A0Z5", good[1].lower()]:
    out["gstin"].append({"gstin": g, "ok": gstin_problem(g) == ""})

for data in [
    {"party_type": "Medical", "dl_numbers": " 20B: 123   21B: 456 ", "rate_tier": "b", "credit_limit": "5000",
     "credit_days": "30", "gstin": good[0]},
    {"party_type": "retail", "state_code": "7"},
    {"state_code": "24", "gstin": ""},
    {"rate_tier": "", "credit_limit": "", "credit_days": ""},
    {"credit_days": "12.9", "credit_limit": 100.555},
    {"party_type": "wholesaler"}, {"rate_tier": "D"}, {"credit_limit": -1}, {"credit_days": 4000},
    {"credit_limit": "abc"}, {"gstin": "27AAAPA1234A1Z4"}, {"state_code": "99"}, {"gstin": good[1], "state_code": "27"},
]:
    try:
        res = {"ok": True, "out": wholesale_party.clean_party(dict(data))}
    except ValueError:
        res = {"ok": False}
    out["party"].append({"data": data, "expect": res})

for med in [{"rate_a": 10, "rate_b": 9.5, "rate_c": 0}, {"rate_a": 0, "rate_b": 8}, {"rate_a": "12.34567"},
            {}, {"rate_a": 5, "rate_c": 4.12345}]:
    for t in ["A", "b", "C", "", "Z", None]:
        rate_, used = ws.tier_rate(med, t)
        out["tier"].append({"med": med, "tier": t, "rate": rate_, "used": used})

for unit, ups in [("10", 10), ("10", 1), ("1", 1), ("", 1), ("100ML", 1), ("15s", 15), ("1x10", 10), (None, 1)]:
    out["pack"].append({"unit": unit, "ups": ups, "expect": ws.pack_text(unit, ups)})

for addr in ["Main Road, Shirpur, Dhule - 425405, Maharashtra", "SHOP 4, STATION ROAD\nNANDURBAR 425412",
             "", "425405", "Market Yard, Jalgaon., India", "Near Bus Stand, M.S"]:
    out["city"].append({"address": addr, "expect": ws._city(addr)})


def context(n_lines, intra, with_returns, paper_note=""):
    lines = []
    for i in range(n_lines):
        raw = line()
        raw["qty"] = rng.choice([1, 2, 5, 10, 20])
        raw["name"] = f"Test Med {i + 1} <tab> & co"
        lines.append(raw)
    inv = ws.calc_invoice(lines, shop_state="27", pos="27" if intra else "24")
    shown = []
    for ln in inv["lines"]:
        ups = rng.choice([1, 10])
        shown.append({**ln, "batch": f"B{rng.randint(100, 999)}", "expiry": "2027-08-01",
                      "mfg": "acme pharma", "pack": ws.pack_text("10" if ups > 1 else "100ML", ups),
                      "units_per_pack": ups, "mrp": rng.choice([0, 120.5, 45]),
                      "line_discount": round(ln["disc_amt"] + ln["scheme_amt"], 2)})
    returns = []
    if with_returns:
        returns = [
            {"kind": "return", "return_no": "SR1-7", "return_date": "2026-10-17", "name": "", "qty": 0.0,
             "amount": 150.0, "refund": 200.0, "batch": "", "expiry": "", "mrp": 0.0, "sr": 0},
            {"kind": "medicine", "return_no": "SR1-7", "return_date": "", "name": "Old Med", "qty": 2.0,
             "amount": 200.0, "refund": 0.0, "batch": "X1", "expiry": "2027-01-01", "mrp": 55.0, "sr": 1},
            {"kind": "total", "return_no": "SR1-7", "return_date": "", "name": "", "qty": 0.0,
             "amount": 150.0, "refund": 200.0, "batch": "", "expiry": "", "mrp": 0.0, "sr": 0},
        ]
    ret_total = 150.0 if with_returns else 0.0
    sub = round(sum(ln["taxable"] + ln["line_discount"] for ln in shown), 2)
    return {
        "bill_no": "SCB12", "bill_date": "2026-10-19", "due_date": rng.choice(["2026-11-18", "2026-10-19"]),
        "transport": rng.choice(["", "VRL Logistics"]), "lr_no": rng.choice(["", "LR-55"]), "eway_bill_no": "",
        "shop": {"name": "Test Wholesale Agencies", "address": "Main Road, Testpur, 425405",
                 "phone": "9000000000", "dl_numbers": "20B-1, 21B-2", "gstin": with_check("27AAAPA1234A1Z"),
                 "bank": rng.choice([[], [("Bank", "Test Bank"), ("A/c No", "123456789"), ("IFSC", "TEST0001"),
                                          ("Branch", "Testpur")]])},
        "buyer": {"name": "A & B Medical", "address": "Station Road", "phone": "9111111111",
                  "gstin": with_check("24ABCDE1234F1Z") if not intra else with_check("27ABCDE1234F1Z"),
                  "dl_numbers": "DL-9", "state_code": "27" if intra else "24",
                  "state_name": "Maharashtra" if intra else "Gujarat"},
        "intra_state": intra, "place_of_supply": inv["place_of_supply"],
        "place_of_supply_name": inv["place_of_supply_name"],
        "lines": shown, "returns": returns, "returns_total": ret_total,
        "sub_total": sub, "line_discount": round(sum(ln["line_discount"] for ln in shown), 2),
        "bill_discount": 0.0, "cgst_total": inv["cgst_total"], "sgst_total": inv["sgst_total"],
        "igst_total": inv["igst_total"], "round_off": inv["round_off"],
        "grand_total": inv["grand_total"], "party_total": round(inv["grand_total"] - ret_total, 2),
        "party_total_words": ws.amount_in_words(round(inv["grand_total"] - ret_total, 2)),
        "amount_in_words": inv["amount_in_words"], "amount_paid": rng.choice([0.0, 100.0]),
        "receipts": rng.choice([[], [{"receipt_no": "R-12", "amount": 50.0, "date": "2026-10-19"}]]),
        "ledger_balance": rng.choice([1234.5, -20.0, 0.0]),
        "pay_label": rng.choice(["CASH", "CREDIT"]), "total_items": len(shown),
        "total_qty": sum(ln["qty"] for ln in shown),
        "declaration": ws.DEFAULT_DECLARATION.replace("{city}", "TESTPUR"),
        "signature_src": rng.choice(["", "data:image/png;base64,iVBORw0KGgo="]),
        "signature_look": "transform: rotate(2.00deg);",
    }


for n_lines, intra, rets in [(3, True, False), (5, False, True), (25, True, True), (0, True, False), (18, False, False)]:
    ctx = context(n_lines, intra, rets)
    for paper in ("A4", "A5"):
        out["html"].append({"inv": ctx, "paper": paper, "copy_label": "" if paper == "A4" else "DUPLICATE",
                            "expect": render_wholesale_invoices_html([ctx], paper=paper,
                                                                     copy_label="" if paper == "A4" else "DUPLICATE")})
two = [context(2, True, False), context(4, False, False)]
out["html"].append({"invs": two, "paper": "A4", "copy_label": "",
                    "expect": render_wholesale_invoices_html(two, paper="A4")})

json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"), default=float)
print()
