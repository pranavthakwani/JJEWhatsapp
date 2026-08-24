import assert from 'node:assert/strict';
import test from 'node:test';
import { closePool } from '../src/config/db.js';
import { getLeadOpsDashboard, getLeadOpsFacets, listLeadOpsItems } from '../src/repositories/leadOpsRepository.js';

test('LeadOps read models return bounded, stable DTOs', async () => {
  const [dashboard, facets, leads, offerings, ignored, filteredOfferings] = await Promise.all([
    getLeadOpsDashboard(30),
    getLeadOpsFacets(30),
    listLeadOpsItems({ type: 'leads', days: 30, page: 1, limit: 5 }),
    listLeadOpsItems({ type: 'offerings', days: 30, page: 1, limit: 5 }),
    listLeadOpsItems({ type: 'ignored', days: 30, page: 1, limit: 5 }),
    listLeadOpsItems({ type: 'offerings', days: 3650, minPrice: 1, maxPrice: 1000000, minQuantity: 1, page: 1, limit: 5 }),
  ]);

  assert.equal(dashboard.days, 30);
  assert.ok(Number.isInteger(dashboard.totals.leads));
  assert.ok(Array.isArray(dashboard.trend));
  assert.ok(Array.isArray(facets.brands));
  assert.ok(Array.isArray(facets.models));
  assert.ok(leads.items.every((item) => item.type === 'lead'));
  assert.ok(offerings.items.every((item) => item.type === 'offering'));
  assert.ok(ignored.items.every((item) => item.type === 'ignored'));
  assert.ok(filteredOfferings.items.every((item) => item.type === 'offering'));
  assert.ok([leads, offerings, ignored].every((page) => page.limit === 5 && page.page === 1));
});

test.after(async () => {
  await closePool();
});
