/**
 * The bill heading (owner, 22 Oct 2026): "Tax Invoice" (today's bills, the default) or
 * "Bill of Supply" (Rule 49 of the CGST Rules -- a composition dealer, or a shop selling
 * exempt goods). Kept like the bank details, as two of the store's own settings rows, so
 * the PC, the phone and the web print the same heading:
 *
 *   profile_bill_heading        "tax_invoice" (default; empty or anything else) | "bill_of_supply"
 *   profile_bill_supply_reason  "composition" (default) | "exempt"
 *
 * A Bill of Supply prints "BILL OF SUPPLY" and no tax: no GST columns, no GST rows, no
 * CGST/SGST/IGST or taxable summary. A composition dealer's also carries the declaration
 * below. The amounts are the bill's own -- only the printing changes; the saved bill and
 * the reports never look at this. No database here: the renderers import it, and they run
 * without one (webStore.storeBillHeading reads the rows).
 */
export const HEADING_KV = 'profile_bill_heading';
export const REASON_KV = 'profile_bill_supply_reason';
export const TAX_INVOICE = 'tax_invoice';
export const BILL_OF_SUPPLY = 'bill_of_supply';
export const COMPOSITION = 'composition';
export const EXEMPT = 'exempt';
export const BILL_OF_SUPPLY_TITLE = 'BILL OF SUPPLY';
export const COMPOSITION_DECLARATION = 'Composition taxable person, not eligible to collect tax on supplies';

/** A settings value as plain words (a JSON-quoted "bill_of_supply" reads the same). */
function word(raw) {
  return String(raw ?? '').trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
}

export function cleanHeading(raw) {
  return word(raw) === BILL_OF_SUPPLY ? BILL_OF_SUPPLY : TAX_INVOICE;
}

export function cleanReason(raw) {
  return word(raw) === EXEMPT ? EXEMPT : COMPOSITION;
}

/** What a bill prints for this heading and reason (both raw settings values). */
export function billHeadingInfo(heading, reason) {
  const h = cleanHeading(heading);
  const r = cleanReason(reason);
  const bos = h === BILL_OF_SUPPLY;
  return {
    bill_heading: h,
    bill_supply_reason: r,
    bill_of_supply: bos,
    supply_declaration: bos && r === COMPOSITION ? COMPOSITION_DECLARATION : '',
  };
}
