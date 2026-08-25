import { Activity, AlertCircle, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Filter, Gauge, Inbox, LayoutDashboard, Loader2, MessageCircleMore, PackageSearch, RefreshCw, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { getLeadMatches, getLeadOpsDashboard, getLeadOpsFacets, getLeadOpsItems, updateLeadOpsStatus } from '../lib/api';
import type { LeadOpsDashboard, LeadOpsFacets, LeadOpsItem, LeadOpsPage } from '../types';

type View = 'overview' | 'inbox' | 'search';
type Queue = 'leads' | 'offerings' | 'ignored';
type Props = { onOpenConversation: (conversationId: number) => void };

const EMPTY_FACETS: LeadOpsFacets = { brands: [], models: [] };
const LEAD_STATUSES = ['open', 'matched', 'closed', 'archived'];
const OFFERING_STATUSES = ['complete', 'pending_price', 'sold', 'archived'];

function money(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
}

function compactRange(minimum: number | null, maximum: number | null, formatter: (value: number | null) => string) {
  if (minimum === null && maximum === null) return '—';
  if (minimum === maximum || maximum === null) return formatter(minimum);
  if (minimum === null) return formatter(maximum);
  return `${formatter(minimum)}–${formatter(maximum)}`;
}

function productName(item: LeadOpsItem) {
  return [item.brand, item.model, item.variant].filter(Boolean).join(' ') || (item.type === 'ignored' ? 'Unclassified message' : 'Unspecified product');
}

function confidenceLabel(confidence: number | null) {
  if (confidence === null) return 'Imported';
  return `${Math.round(confidence * 100)}%`;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`crm-status crm-status--${status}`}><i />{status.replace('_', ' ')}</span>;
}

function QueueTable({ items, selectedId, onSelect }: { items: LeadOpsItem[]; selectedId?: number; onSelect: (item: LeadOpsItem) => void }) {
  return (
    <div className="crm-table-wrap leadops-table-wrap">
      <table className="crm-data-table leadops-data-table">
        <thead><tr><th>Product / message</th><th>Contact</th><th>Quantity</th><th>Price</th><th>Confidence</th><th>Status</th><th>Received</th></tr></thead>
        <tbody>{items.map((item) => (
          <tr key={`${item.type}-${item.id}`} className={selectedId === item.id ? 'is-selected' : ''} onClick={() => onSelect(item)}>
            <td data-label="Product / message"><div className="leadops-product-cell"><span className={`leadops-type-mark leadops-type-mark--${item.type}`} /><div><strong>{productName(item)}</strong><small>{item.sourceText || 'No message text'}</small></div></div></td>
            <td data-label="Contact"><strong>{item.contactName}</strong><small className="crm-table-subline">{item.phoneNumber}</small></td>
            <td data-label="Quantity">{compactRange(item.quantityMin, item.quantityMax, (value) => value === null ? '—' : String(value))}</td>
            <td data-label="Price" className="crm-mono">{compactRange(item.priceMin, item.priceMax, money)}</td>
            <td data-label="Confidence"><span className="leadops-confidence"><i style={{ '--confidence': `${(item.confidence || 0) * 100}%` } as CSSProperties} />{confidenceLabel(item.confidence)}</span></td>
            <td data-label="Status"><StatusBadge status={item.status} /></td>
            <td data-label="Received"><time>{new Date(item.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></td>
          </tr>
        ))}</tbody>
      </table>
      {items.length === 0 && <div className="crm-empty-state"><PackageSearch size={28} /><h2>No records found</h2><p>Change the filters or use a wider date window.</p></div>}
    </div>
  );
}

export function LeadOpsWorkspace({ onOpenConversation }: Props) {
  const [view, setView] = useState<View>('overview');
  const [queue, setQueue] = useState<Queue>('leads');
  const [days, setDays] = useState(30);
  const [dashboard, setDashboard] = useState<LeadOpsDashboard | null>(null);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [page, setPage] = useState<LeadOpsPage | null>(null);
  const [recent, setRecent] = useState<LeadOpsItem[]>([]);
  const [searchDraft, setSearchDraft] = useState('');
  const search = useDeferredValue(searchDraft);
  const [filters, setFilters] = useState({ brand: '', model: '', status: '', minPrice: '', maxPrice: '', minQuantity: '' });
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LeadOpsItem | null>(null);
  const [matches, setMatches] = useState<LeadOpsItem[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true); setError('');
    try {
      const [nextDashboard, nextFacets, leads, offerings] = await Promise.all([
        getLeadOpsDashboard(days), getLeadOpsFacets(days),
        getLeadOpsItems({ type: 'leads', days, page: 1, limit: 6 }),
        getLeadOpsItems({ type: 'offerings', days, page: 1, limit: 6 }),
      ]);
      setDashboard(nextDashboard); setFacets(nextFacets);
      setRecent([...leads.items, ...offerings.items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()).slice(0, 8));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Lead intelligence could not be loaded.'); }
    finally { setSummaryLoading(false); }
  }, [days]);

  const loadItems = useCallback(async (targetPage = 1) => {
    setItemsLoading(true); setError('');
    try { setPage(await getLeadOpsItems({ type: queue, days, search, ...filters, page: targetPage, limit: 40 })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The operational queue could not be loaded.'); }
    finally { setItemsLoading(false); }
  }, [days, filters, queue, search]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { if (view !== 'overview') void loadItems(1); }, [loadItems, view]);
  useEffect(() => { setSelected(null); setMatches([]); }, [queue]);

  async function changeStatus(item: LeadOpsItem, status: string) {
    const previous = item.status;
    setSelected((current) => current ? { ...current, status } : current);
    setPage((current) => current ? { ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, status } : candidate) } : current);
    try { await updateLeadOpsStatus(item.type as 'lead' | 'offering', item.id, status); await loadSummary(); }
    catch (reason) {
      setSelected((current) => current ? { ...current, status: previous } : current);
      setPage((current) => current ? { ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, status: previous } : candidate) } : current);
      setError(reason instanceof Error ? reason.message : 'Status could not be updated.');
    }
  }

  async function loadMatches(lead: LeadOpsItem) {
    setMatchesLoading(true); setMatches([]);
    try { setMatches(await getLeadMatches(lead.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Matches could not be loaded.'); }
    finally { setMatchesLoading(false); }
  }

  function selectItem(item: LeadOpsItem) {
    setSelected(item); setMatches([]);
    if (item.type === 'lead') void loadMatches(item);
  }

  const stats = dashboard?.totals;
  const maxTrend = useMemo(() => Math.max(1, ...(dashboard?.trend.map((point) => point.leads + point.offerings + point.ignored) || [1])), [dashboard]);
  const lowestOfferings = useMemo(() => recent.filter((item) => item.type === 'offering' && item.priceMin !== null).sort((left, right) => Number(left.priceMin) - Number(right.priceMin)).slice(0, 5), [recent]);

  return (
    <section className="crm-module leadops-module" aria-label="Lead intelligence">
      <header className="crm-module-header leadops-module-header">
        <div><span className="crm-eyebrow">Intelligence workspace</span><h1>Lead operations</h1><p>Turn incoming WhatsApp inventory traffic into structured, actionable opportunities.</p></div>
        <div className="crm-header-actions"><span className="leadops-live"><i />Extraction active</span><button type="button" className="crm-icon-button" onClick={() => void Promise.all([loadSummary(), view !== 'overview' ? loadItems(page?.page || 1) : Promise.resolve()])} title="Refresh"><RefreshCw size={17} /></button></div>
      </header>
      <nav className="crm-subnav">{([{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'inbox', label: 'Operational inbox', icon: Inbox }, { id: 'search', label: 'Market search', icon: Search }] as const).map((item) => <button key={item.id} type="button" className={view === item.id ? 'is-active' : ''} onClick={() => setView(item.id)}><item.icon size={16} />{item.label}</button>)}</nav>

      <main className="leadops-module-content">
        {error && <div className="crm-inline-error"><span>{error}</span><button type="button" onClick={() => setError('')}><X size={15} /></button></div>}
        {view === 'overview' && <>
          <div className="leadops-overview-toolbar"><div><strong>Operational pulse</strong><span>Selected reporting window</span></div><select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option><option value={3650}>All data</option></select></div>
          {summaryLoading ? <div className="leadops-overview-skeleton">{Array.from({ length: 4 }).map((_, index) => <span key={index} />)}</div> : stats && <>
            <div className="leadops-kpis">
              <article><span><small>Open leads</small><strong>{stats.openLeads.toLocaleString('en-IN')}</strong></span><em><Activity size={14} />{stats.leads} extracted</em></article>
              <article><span><small>Available offerings</small><strong>{stats.offerings.toLocaleString('en-IN')}</strong></span><em><PackageSearch size={14} />market supply</em></article>
              <article className={stats.pendingPrices > 0 ? 'needs-attention' : ''}><span><small>Pending prices</small><strong>{stats.pendingPrices.toLocaleString('en-IN')}</strong></span><em><AlertCircle size={14} />requires review</em></article>
              <article className={stats.failedJobs > 0 ? 'has-failures' : ''}><span><small>Processing queue</small><strong>{stats.queuedJobs.toLocaleString('en-IN')}</strong></span><em><Gauge size={14} />{stats.failedJobs} failed</em></article>
            </div>
            <div className="leadops-dashboard-grid">
              <section className="leadops-activity-panel"><header><div><h2>Message classification</h2><p>Daily extraction volume for this reporting window.</p></div><span>{stats.analyzedContacts} contacts</span></header><div className="leadops-activity-chart">{dashboard?.trend.map((point) => <div key={point.date} title={`${point.date}: ${point.leads} leads · ${point.offerings} offerings · ${point.ignored} ignored`}><span className="is-lead" style={{ height: `${Math.max(2, point.leads / maxTrend * 100)}%` }} /><span className="is-offering" style={{ height: `${Math.max(2, point.offerings / maxTrend * 100)}%` }} /><span className="is-ignored" style={{ height: `${Math.max(2, point.ignored / maxTrend * 100)}%` }} /></div>)}</div><footer><span><i className="is-lead" />Leads</span><span><i className="is-offering" />Offerings</span><span><i className="is-ignored" />Ignored</span></footer></section>
              <section className="leadops-market-panel"><header><div><h2>Lowest current offerings</h2><p>Quick market price reference.</p></div><button type="button" onClick={() => { setQueue('offerings'); setView('search'); }}>Explore <ArrowRight size={14} /></button></header><div>{lowestOfferings.map((item, index) => <button type="button" key={item.id} onClick={() => selectItem(item)}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{productName(item)}</strong><small>{item.contactName}</small></span><em>{money(item.priceMin)}</em></button>)}{lowestOfferings.length === 0 && <p className="leadops-panel-empty">No priced offerings in this window.</p>}</div></section>
            </div>
            <section className="leadops-recent"><header><div><h2>Recent intelligence</h2><p>Latest classified messages across buying and selling activity.</p></div><button type="button" onClick={() => setView('inbox')}>View inbox <ArrowRight size={14} /></button></header><QueueTable items={recent} onSelect={selectItem} /></section>
          </>}
        </>}

        {view !== 'overview' && <>
          <div className="leadops-queue-header"><div className="leadops-queue-tabs">{(['leads', 'offerings', 'ignored'] as Queue[]).map((value) => <button key={value} type="button" className={queue === value ? 'is-active' : ''} onClick={() => { setQueue(value); setFilters({ brand: '', model: '', status: '', minPrice: '', maxPrice: '', minQuantity: '' }); }}>{value}<span>{value === 'leads' ? stats?.leads : value === 'offerings' ? stats?.offerings : stats?.ignored}</span></button>)}</div><select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value={3650}>All data</option></select></div>
          <div className="leadops-filterbar"><label className="crm-search-control"><Search size={16} /><input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder={view === 'search' ? 'Search product, model, contact, phone or message…' : 'Filter this queue…'} /></label>{queue !== 'ignored' && <><label><Filter size={14} /><select value={filters.brand} onChange={(event) => setFilters((current) => ({ ...current, brand: event.target.value }))}><option value="">All brands</option>{facets.brands.map((facet) => <option value={facet.value} key={facet.value}>{facet.value} · {facet.total}</option>)}</select></label><select value={filters.model} onChange={(event) => setFilters((current) => ({ ...current, model: event.target.value }))}><option value="">All models</option>{facets.models.map((facet) => <option value={facet.value} key={facet.value}>{facet.value}</option>)}</select><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="">All statuses</option>{(queue === 'leads' ? LEAD_STATUSES : OFFERING_STATUSES).map((status) => <option value={status} key={status}>{status.replace('_', ' ')}</option>)}</select></>}<span className="crm-result-count"><SlidersHorizontal size={14} />{page?.total || 0} results</span></div>
          {view === 'search' && queue !== 'ignored' && <div className="leadops-numeric-filters"><span>Commercial range</span><label>Min price<input type="number" min="0" inputMode="numeric" value={filters.minPrice} onChange={(event) => setFilters((current) => ({ ...current, minPrice: event.target.value }))} placeholder="₹0" /></label><label>Max price<input type="number" min="0" inputMode="numeric" value={filters.maxPrice} onChange={(event) => setFilters((current) => ({ ...current, maxPrice: event.target.value }))} placeholder="Any" /></label><label>Minimum quantity<input type="number" min="0" inputMode="numeric" value={filters.minQuantity} onChange={(event) => setFilters((current) => ({ ...current, minQuantity: event.target.value }))} placeholder="Any" /></label></div>}
          {itemsLoading ? <div className="leadops-table-loading"><Loader2 size={22} />Loading operational records…</div> : <QueueTable items={page?.items || []} selectedId={selected?.id} onSelect={selectItem} />}
          {page && page.totalPages > 1 && <div className="crm-pagination"><button type="button" disabled={page.page <= 1} onClick={() => void loadItems(page.page - 1)}><ChevronLeft size={15} />Previous</button><span>Page {page.page} of {page.totalPages}</span><button type="button" disabled={page.page >= page.totalPages} onClick={() => void loadItems(page.page + 1)}>Next<ChevronRight size={15} /></button></div>}
        </>}
      </main>

      <aside className={`leadops-detail ${selected ? 'is-open' : ''}`} aria-hidden={!selected}><div className="leadops-detail__backdrop" onClick={() => setSelected(null)} /><section>{selected && <><header><div><span className={`leadops-kind leadops-kind--${selected.type}`}>{selected.type}</span><h2>{productName(selected)}</h2><p>Received {new Date(selected.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p></div><button type="button" className="crm-icon-button" onClick={() => setSelected(null)}><X size={17} /></button></header><div className="leadops-detail__body">
        <section className="leadops-detail__identity"><span className="crm-avatar">{selected.contactName.slice(0, 1).toUpperCase()}</span><div><strong>{selected.contactName}</strong><small>{selected.phoneNumber}</small></div><button type="button" onClick={() => onOpenConversation(selected.conversationId)}><MessageCircleMore size={16} />Open chat</button></section>
        <section className="leadops-investigation"><header><span>Raw WhatsApp input</span><small>Source message #{selected.messageId}</small></header><blockquote>{selected.sourceText || 'No text body was retained for this message.'}</blockquote></section>
        {selected.type !== 'ignored' && <section className="leadops-investigation leadops-investigation--structured"><header><span><Sparkles size={14} />Structured intelligence</span><small>{confidenceLabel(selected.confidence)} confidence</small></header><dl><div><dt>Brand</dt><dd>{selected.brand || 'Not captured'}</dd></div><div><dt>Model</dt><dd>{selected.model || 'Not captured'}</dd></div><div><dt>Memory</dt><dd>{[selected.ramGb && `${selected.ramGb} GB RAM`, selected.storageGb && `${selected.storageGb} GB storage`].filter(Boolean).join(' · ') || 'Not captured'}</dd></div><div><dt>Quantity</dt><dd>{compactRange(selected.quantityMin, selected.quantityMax, (value) => String(value))}</dd></div><div><dt>{selected.type === 'lead' ? 'Target price' : 'Price'}</dt><dd>{compactRange(selected.priceMin, selected.priceMax, money)}</dd></div><div><dt>Dispatch</dt><dd>{selected.dispatchLocation || 'Not captured'}</dd></div><div><dt>GST</dt><dd>{selected.gstIncluded === null ? 'Not captured' : selected.gstIncluded ? 'Included' : 'Excluded'}</dd></div><div><dt>Condition</dt><dd>{selected.condition || 'Not captured'}</dd></div></dl></section>}
        {selected.type !== 'ignored' && <section className="leadops-status-control"><label>Operational status<select value={selected.status} onChange={(event) => void changeStatus(selected, event.target.value)}>{(selected.type === 'lead' ? LEAD_STATUSES : OFFERING_STATUSES).map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}</select></label><CheckCircle2 size={18} /></section>}
        {selected.type === 'lead' && <section className="leadops-matches"><header><div><h3>Compatible offerings</h3><p>Scored by product, specification, and target price.</p></div>{matchesLoading && <Loader2 className="is-spinning" size={17} />}</header><div>{matches.map((match) => <button type="button" key={match.id} onClick={() => setSelected(match)}><span><strong>{productName(match)}</strong><small>{match.contactName} · {money(match.priceMin)}</small></span><b>{match.matchScore}%</b></button>)}{!matchesLoading && matches.length === 0 && <p>No compatible offering found in the active inventory.</p>}</div></section>}
      </div></>}</section></aside>
    </section>
  );
}
