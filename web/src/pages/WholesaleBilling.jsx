import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtExpiry, money, qs, shortNo } from '../api.js';
import { useDebounced } from './common.jsx';
import { PartyForm, WholesaleInvoice, WsPartyPicker } from './wholesale.jsx';

/**
 * The wholesale bill (owner, 18 Oct 2026): a B2B tax invoice to another medical, as the PC's
 * wholesale Sales page makes it. The party is a customer (its GSTIN, DL numbers, state, rate
 * tier and credit terms); lines are whole strips (packs) + free strips at Rate A / B / C, GST
 * excluded and added on top, with Disc % and Sch %. The server does every sum (the PC's
 * rules, webWholesale.js); this page sends what is typed and shows what comes back.
 */
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function MedicineSearch({ tier, onPick }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [hi, setHi] = useState(0);
  const q = useDebounced(text, 200);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    let live = true;
    api(`/wholesale/medicines${qs({ q, tier })}`).then((d) => { if (live) { setRows(d); setHi(0); } }).catch(() => {});
    return () => { live = false; };
  }, [q, tier]);
  function pick(r) { onPick(r); setText(''); setRows([]); }
  return (
    <div className="picker">
      <input value={text} placeholder="Search medicine (name)… Enter adds it" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setHi((h) => Math.min(rows.length - 1, h + 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setHi((h) => Math.max(0, h - 1)); e.preventDefault(); }
          if (e.key === 'Enter' && rows[hi]) { pick(rows[hi]); e.preventDefault(); }
        }} />
      {rows.length > 0 && (
        <div className="dropdown wide">
          {rows.map((r, i) => (
            <button type="button" key={r.id} className={i === hi ? 'hi' : ''} onMouseDown={() => pick(r)}>
              <span><strong>{r.name}</strong></span>
              <span className="muted small">
                batch {r.batch_no || '-'} · exp {fmtExpiry(r.expiry_date)} · stock {r.stock_packs} strip{r.stock_packs === 1 ? '' : 's'}
                {' · '}{Number(r.rate_a) > 0 ? `A ${money(r.rate_a)}` : <span className="neg">no Rate A</span>}
                {Number(r.rate_b) > 0 ? ` · B ${money(r.rate_b)}` : ''}{Number(r.rate_c) > 0 ? ` · C ${money(r.rate_c)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WholesaleBilling({ me, can }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [party, setParty] = useState(null);
  // A name typed that is not a party yet: saving the bill makes the party from the boxes.
  const [typedName, setTypedName] = useState('');
  const [partyForm, setPartyForm] = useState(null);
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [buyerGstin, setBuyerGstin] = useState('');
  const [buyerDl, setBuyerDl] = useState('');
  const [lines, setLines] = useState([]);
  const [overall, setOverall] = useState('');
  const [transport, setTransport] = useState('');
  const [lrNo, setLrNo] = useState('');
  const [eway, setEway] = useState('');
  const [mode, setMode] = useState('Due');
  const [cash, setCash] = useState('');
  const [online, setOnline] = useState('');
  const [calc, setCalc] = useState(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [version, setVersion] = useState(null);
  const [held, setHeld] = useState({});
  const [loadedRets, setLoadedRets] = useState([]);
  const [openRets, setOpenRets] = useState([]);
  const [useRets, setUseRets] = useState([]);
  const [askRets, setAskRets] = useState(false);

  async function choose(p, { keepBill = false } = {}) {
    if (!p) {
      // The pick was cleared (the name was edited): empty each box that still holds what the
      // pick filled in, so a new party saved from the boxes never carries another party's
      // GSTIN / DL on a tax invoice; what the user typed stays. Lines at the old party's tier
      // go back to Rate A (a rate typed by hand stays). Due, returns, terms follow `party`.
      const old = party;
      setParty(null);
      if (!old) return;
      const same = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
      setPhone((v) => (same(v, old.phone) ? '' : v));
      setAddress((v) => (same(v, old.address) ? '' : v));
      setBuyerGstin((v) => (same(v, old.gstin) ? '' : v));
      setBuyerDl((v) => (same(v, old.dl_numbers) ? '' : v));
      if (old.rate_tier && old.rate_tier !== 'A') {
        setLines((ls) => ls.map((l) => (l.rate_tier === old.rate_tier
          ? { ...l, rate_tier: 'A', rate: Number(l.tier_rates?.A) > 0 ? String(l.tier_rates.A) : '' } : l)));
      }
      return;
    }
    try {
      const full = await api(`/wholesale/parties/${p.id}`);
      setParty(full);
      if (!keepBill) {
        setPhone(full.phone || ''); setAddress(full.address || ''); setBuyerGstin(full.gstin || ''); setBuyerDl(full.dl_numbers || '');
      }
    } catch (e) { setError(e.message); }
  }

  // Returns of this party whose credit is not used yet (new bill): tick the ones to settle.
  useEffect(() => {
    setOpenRets([]); setUseRets([]); setAskRets(false);
    if (id || !party?.id) return;
    let live = true;
    api(`/wholesale/parties/${party.id}/open-returns`).then((r) => {
      if (!live || !r.length) return;
      setOpenRets(r); setUseRets(r.map((x) => x.return_id)); setAskRets(true);
    }).catch(() => {});
    return () => { live = false; };
  }, [party?.id, id]);

  useEffect(() => {
    if (!id) return;
    api(`/wholesale/sales/${id}`).then(async (s) => {
      await choose(s.party?.id ? s.party : { id: s.customer_id }, { keepBill: true });
      setPhone(s.party?.phone || ''); setAddress(s.party?.address || '');
      setBuyerGstin(s.buyer_gstin || ''); setBuyerDl(s.buyer_dl || '');
      setTransport(s.transport || ''); setLrNo(s.lr_no || ''); setEway(s.eway_bill_no || '');
      setLines(s.items.map((it) => ({ ...it, medicine_id: it.id, qty: String(it.qty), free: String(it.free || ''), rate: String(it.rate),
        disc_pct: String(it.disc_pct || ''), scheme_pct: String(it.scheme_pct || '') })));
      const h = {};
      for (const it of s.items) h[it.id] = (h[it.id] || 0) + it.qty + (it.free || 0);
      setHeld(h);
      setMode(s.cash_paid > 0 ? 'Cash' : s.online_paid > 0 ? 'Online' : 'Due');
      setCash(s.cash_paid ? String(s.cash_paid) : ''); setOnline(s.online_paid ? String(s.online_paid) : '');
      setVersion(s.version);
      setLoadedRets(s.returns_in_bill || []);
    }).catch((e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const items = lines.map((l) => ({
    medicine_id: l.medicine_id, qty: Number(l.qty) || 0, free: Number(l.free) || 0, rate: Number(l.rate) || 0,
    rate_tier: l.rate_tier || '', disc_pct: Number(l.disc_pct) || 0, scheme_pct: Number(l.scheme_pct) || 0,
    gst_percent: l.gst_percent, hsn_code: l.hsn_code || '',
  }));
  const pickedRets = openRets.filter((r) => useRets.includes(r.return_id));
  const retOpen = n2(pickedRets.reduce((x, r) => x + r.left, 0));
  const retSettled = n2(loadedRets.reduce((x, r) => x + Number(r.amount || 0), 0));
  const body = {
    sale_id: id ? Number(id) : undefined, customer_id: party?.id, customer_name: party || id ? undefined : typedName.trim(),
    items, buyer_gstin: buyerGstin, buyer_dl: buyerDl,
    customer_phone: phone, customer_address: address, transport, lr_no: lrNo, eway_bill_no: eway,
    payment_mode: mode, cash_paid: mode === 'Cash' ? Number(cash) || 0 : 0, online_paid: mode === 'Online' ? Number(online) || 0 : 0,
    returns_total: id ? undefined : retOpen, returns_settled: id ? retSettled : undefined,
  };
  const key = useDebounced(JSON.stringify(body), 250);
  useEffect(() => {
    if (!lines.length || lines.some((l) => !(Number(l.qty) > 0))) { setCalc(null); return; }
    let live = true;
    api('/wholesale/sales/calc', { method: 'POST', body }).then((c) => { if (live) { setCalc(c); setError(''); } })
      .catch((e) => { if (live) { setCalc(null); setError(e.message); } });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function addLine(m) {
    const at = lines.findIndex((l) => l.medicine_id === m.id);
    if (at >= 0) { setLine(at, { qty: String((Number(lines[at].qty) || 0) + 1) }); return; }
    try {
      const l = await api('/wholesale/line', { method: 'POST', body: { medicine_id: m.id, rate_tier: party?.rate_tier || 'A', disc_pct: Number(overall) || 0 } });
      setLines((ls) => [...ls, { ...l, qty: '1', free: '', rate: l.rate > 0 ? String(l.rate) : '', disc_pct: overall || '', scheme_pct: '' }]);
      if (l.warning) setNotes((x) => [...x.filter((w) => w !== l.warning), l.warning]);
    } catch (e) { setError(e.message); }
  }
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  function setOverallDisc(v) {
    setOverall(v);
    setLines((ls) => ls.map((l) => ({ ...l, disc_pct: v })));
  }

  const grand = calc?.grand_total || 0;
  const retUsed = calc?.returns_total || 0;
  const net = n2(grand - retUsed);
  const rateMissing = lines.some((l) => !(Number(l.rate) > 0));
  const newParty = !party && !id && typedName.trim() ? typedName.trim().toUpperCase() : '';
  const partyOk = !!party || !!newParty;
  const overStock = lines.filter((l) => (Number(l.qty) || 0) + (Number(l.free) || 0) > Number(l.stock_packs || 0) + (held[l.medicine_id] || 0) + 1e-9);

  async function save(andPrint) {
    setBusy(true); setError('');
    try {
      const payFull = mode !== 'Due' && !(Number(mode === 'Cash' ? cash : online) > 0);
      const b = { ...body, pay_full: payFull || undefined, apply_returns: id ? undefined : useRets };
      if (payFull && mode === 'Online') { b.online_paid = net; b.pay_full = undefined; }
      const out = id
        ? await api(`/wholesale/sales/${id}`, { method: 'PUT', body: { ...b, version } })
        : await api('/wholesale/sales', { method: 'POST', body: b });
      setSaved({ ...out, andPrint });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  function fresh() {
    setSaved(null); setParty(null); setTypedName(''); setPhone(''); setAddress(''); setBuyerGstin(''); setBuyerDl(''); setLines([]); setOverall('');
    setTransport(''); setLrNo(''); setEway(''); setMode('Due'); setCash(''); setOnline(''); setCalc(null); setNotes([]);
    setHeld({}); setLoadedRets([]); setOpenRets([]); setUseRets([]); setAskRets(false); setVersion(null);
    if (id) nav('/billing');
  }

  if (saved) {
    return (
      <div>
        <div className="card no-print row between wrap">
          <div>
            <strong>Tax invoice {shortNo(saved.bill_no)} saved.</strong> Total ₹ {money(saved.total_amount)}
            {saved.returns_applied > 0 ? ` · return credit − ₹ ${money(saved.returns_applied)} · net ₹ ${money(saved.net_total)}` : ''}
            {saved.due_date ? ` · due ${fmtDate(saved.due_date)}` : ''}
            {(saved.warnings || []).map((w) => <div key={w} className="warn small">{w}</div>)}
          </div>
          <div className="row">
            <button className="btn primary" onClick={fresh} autoFocus>New bill</button>
          </div>
        </div>
        <WholesaleInvoice saleId={saved.id} autoPrint={saved.andPrint} />
      </div>
    );
  }

  const intra = calc ? calc.intra_state : true;
  return (
    <div className="billing ws-billing">
      <div className="card">
        <h2>{id ? 'Edit tax invoice' : 'Wholesale bill (tax invoice)'} <span className="muted small">{me.today}</span></h2>
        <div className="grid4">
          <label>Party{party ? <span className="muted small"> · Rate {party.rate_tier}{party.party_type === 'medical' ? ' · medical' : ''}</span> : null}
            <WsPartyPicker value={party} onPick={(p) => choose(p)} onType={setTypedName} autoFocus={!id} />
            {newParty && <span className="muted small">New party: saved with this bill (Rate A) from the boxes here</span>}</label>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label>Address<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Town / address" /></label>
          <div className="row">
            {party && <button className="btn small" onClick={() => setPartyForm(party)}>Party details</button>}
            <button className="btn small" onClick={() => setPartyForm({})}>+ New party</button>
          </div>
          <label>GSTIN{calc?.place_of_supply ? <span className="muted small"> · POS {calc.place_of_supply} {calc.place_of_supply_name}</span> : null}
            <input value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())} placeholder={party ? 'Unregistered' : ''} /></label>
          <label>DL numbers<input value={buyerDl} onChange={(e) => setBuyerDl(e.target.value)} placeholder={party ? 'Not on file' : ''} /></label>
          <label>Previous due{party?.credit_limit > 0 ? <span className="muted small"> · limit ₹ {money(party.credit_limit)}</span> : null}
            <input readOnly value={party ? money(party.total_due) : ''} /></label>
          <label>Due date{party ? <span className="muted small"> · {party.credit_days || 0} days credit</span> : null}
            <input readOnly value={calc?.due_date ? fmtDate(calc.due_date) : ''} /></label>
        </div>
        {openRets.length > 0 && !askRets && (
          <p className="okmsg small">Return credit: {pickedRets.length ? `${pickedRets.map((r) => r.return_no).join(', ')} settled in this bill` : 'not used in this bill'}
            {' '}<button className="btn small" onClick={() => setAskRets(true)}>Change</button></p>)}
      </div>

      <div className="card scrollx">
        <MedicineSearch tier={party?.rate_tier || 'A'} onPick={addLine} />
        <table className="grid compact ws-lines">
          <thead><tr>
            <th>Sr</th><th>Medicine</th><th>Batch</th><th>Exp</th><th>HSN</th><th className="r">Qty <span className="muted">strips</span></th>
            <th className="r">Free</th><th className="r">Rate <span className="muted">per strip</span></th><th className="r">Disc %</th><th className="r">Sch %</th>
            <th className="r">Taxable</th><th className="r">GST %</th><th className="r">GST</th><th className="r">Amount</th><th />
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const c = calc?.lines?.[i];
              const over = overStock.includes(l);
              const noRate = !(Number(l.rate) > 0);
              return (
                <tr key={`${l.medicine_id}-${i}`} className={noRate ? 'ws-rate-missing' : ''}>
                  <td>{i + 1}</td>
                  <td>{l.name}{over ? <span className="neg small"> · stock {l.stock_packs}</span> : null}</td>
                  <td>{l.batch}</td>
                  <td>{fmtExpiry(l.expiry)}</td>
                  <td><input className="num hsn" value={l.hsn_code || ''} onChange={(e) => setLine(i, { hsn_code: e.target.value })} /></td>
                  <td className="r"><input className="num" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                  <td className="r"><input className="num" value={l.free} onChange={(e) => setLine(i, { free: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                  <td className="r">
                    <input className="num" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value, rate_tier: '' })}
                      title={['A', 'B', 'C'].map((t) => `Rate ${t}: ${l.tier_rates?.[t] ? money(l.tier_rates[t]) : '—'}`).join('\n')} />
                    {l.rate_tier ? <span className="tag">{l.rate_tier}</span> : null}
                    {noRate && <div className="neg small">Rate A is required</div>}
                  </td>
                  <td className="r"><input className="num" value={l.disc_pct} onChange={(e) => setLine(i, { disc_pct: e.target.value })} /></td>
                  <td className="r"><input className="num" value={l.scheme_pct} onChange={(e) => setLine(i, { scheme_pct: e.target.value })} /></td>
                  <td className="r">{c ? money(c.taxable) : ''}</td>
                  <td className="r">{Number(l.gst_percent)}</td>
                  <td className="r">{c ? money(c.gst_amt) : ''}</td>
                  <td className="r">{c ? money(c.amount) : ''}</td>
                  <td><button className="btn small danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              );
            })}
            {!lines.length && <tr><td colSpan={15} className="muted center">Pick the party, then search a medicine above and press Enter.</td></tr>}
            {[...pickedRets, ...loadedRets].map((r) => [
              <tr key={`r${r.return_id}`} className="ret-head"><td colSpan={15}>Return {r.return_no} {fmtDate(r.return_date)}</td></tr>,
              ...r.items.map((it, j) => (
                <tr key={`r${r.return_id}-${j}`} className="ret-line">
                  <td>{j + 1}</td><td colSpan={4}>{it.name}</td><td className="r">{it.qty}</td><td colSpan={7} />
                  <td className="r">− {money(it.amount)}</td><td />
                </tr>)),
              <tr key={`r${r.return_id}-t`} className="ret-total">
                <td colSpan={13} className="r">Return total <span className="muted small">(bill {r.bill_no || ''})</span></td>
                <td className="r">− {money(r.left ?? r.amount)}</td><td />
              </tr>,
            ])}
          </tbody>
        </table>
        {notes.map((w) => <div key={w} className="warn small">{w}</div>)}
      </div>

      <div className="card totals">
        <div className="grid4">
          <label>Overall Disc %<input value={overall} onChange={(e) => setOverallDisc(e.target.value)} title="Puts this Disc % on every line" /></label>
          <label>Transport<input value={transport} onChange={(e) => setTransport(e.target.value)} placeholder="optional" /></label>
          <label>LR No.<input value={lrNo} onChange={(e) => setLrNo(e.target.value)} placeholder="optional" /></label>
          <label>E-way Bill No.<input value={eway} onChange={(e) => setEway(e.target.value)} placeholder="optional" /></label>
          <label>Payment<select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="Due">Due (credit)</option><option value="Cash">Cash</option><option value="Online">Online</option>
          </select></label>
          {mode === 'Cash' && <label>Cash<input value={cash} onChange={(e) => setCash(e.target.value)} placeholder={calc ? money(net) : ''} /></label>}
          {mode === 'Online' && <label>Online<input value={online} onChange={(e) => setOnline(e.target.value)} placeholder={calc ? money(net) : ''} /></label>}
          <div className="sum">
            {calc ? (
              <>
                <div>Taxable {money(calc.taxable_total)}{intra
                  ? ` · CGST ${money(calc.cgst_total)} + SGST ${money(calc.sgst_total)}`
                  : ` · IGST ${money(calc.igst_total)}`}{calc.round_off ? ` · round ${money(calc.round_off)}` : ''}</div>
                <div className={retUsed > 0 ? '' : 'big'}>{retUsed > 0 ? 'Grand total ' : ''}₹ {money(grand)}</div>
                {retUsed > 0 && <div>Return total − ₹ {money(retUsed)}</div>}
                {retUsed > 0 && <div className="big">Net to pay ₹ {money(net)}</div>}
                <div className="muted small">{calc.amount_in_words}</div>
                {mode === 'Due' && <div className="warn">Due on this bill: {money(net)}</div>}
              </>
            ) : <div className="muted">Totals appear here</div>}
          </div>
        </div>
        {(calc?.warnings || []).map((w) => <div key={w} className="warn">{w}</div>)}
        {mode !== 'Due' && !(Number(mode === 'Cash' ? cash : online) > 0) && calc && <p className="muted small">Leave the amount empty for a bill paid in full.</p>}
        {askRets && (
          <div className="modal-back" onClick={() => setAskRets(false)}>
            <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
              <h3>{party?.name} has return credit</h3>
              <p className="small">Tick the returns to settle in this bill. They show on the invoice as Return rows and as the CR/DR NOTE.</p>
              <table className="grid compact"><tbody>{openRets.map((r) => (
                <tr key={r.return_id}>
                  <td><input type="checkbox" checked={useRets.includes(r.return_id)}
                    onChange={(e) => setUseRets((u) => (e.target.checked ? [...u, r.return_id] : u.filter((x) => x !== r.return_id)))} /></td>
                  <td>{r.return_no}<div className="muted small">{fmtDate(r.return_date)} · bill {r.bill_no}</div>
                    <div className="muted small">{r.items.map((it) => `${it.name} × ${it.qty} strip${it.qty === 1 ? '' : 's'}`).join(', ')}</div></td>
                  <td className="r">₹ {money(r.left)}</td>
                </tr>))}</tbody></table>
              <div className="row end">
                <button className="btn" onClick={() => { setUseRets([]); setAskRets(false); }}>Not in this bill</button>
                <button className="btn primary" autoFocus onClick={() => setAskRets(false)}>Use ticked</button>
              </div>
            </div>
          </div>)}
        {error && <div className="error">{error}</div>}
        <div className="row end">
          {id && <button className="btn" onClick={() => nav('/sales')}>Cancel</button>}
          <button className="btn" disabled={busy || !calc || !partyOk || rateMissing || overStock.length > 0} onClick={() => save(false)}>Save bill</button>
          <button className="btn primary" disabled={busy || !calc || !partyOk || rateMissing || overStock.length > 0} onClick={() => save(true)}>{busy ? 'Saving…' : 'Save & print'}</button>
        </div>
        {!partyOk && lines.length > 0 && <p className="warn small">Pick the party, or type a new party's name.</p>}
      </div>
      {partyForm && <PartyForm party={partyForm.id ? partyForm : null} onClose={() => setPartyForm(null)}
        onSaved={(p) => { setPartyForm(null); choose(p); }} />}
      {!can('billing') && <p className="muted">You can view only.</p>}
    </div>
  );
}
