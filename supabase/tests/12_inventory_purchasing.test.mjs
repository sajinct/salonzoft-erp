// Phase 4 · inventory ledger, weighted average cost, purchasing, retail
// sales and returns through POS, consumption per service, transfers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, seeb, cashier, manager, stylist, shampoo, dye, colourSvc, supplier, year;

const num = (v) => Number(v);
const balance = async (branch, product) => {
  const rows = await q(db, A.ownerId, `select quantity::float8 q, avg_cost::float8 c from public.inventory_balances where branch_id = $1 and product_id = $2`, [branch, product]);
  return rows[0] ?? { q: 0, c: 0 };
};
const sale = async (uid, items, branch = A.branchId) => {
  const id = (await q(db, uid, `select public.create_invoice_draft($1, $2) r`, [A.tenantId, branch]))[0].r.invoice_id;
  await q(db, uid, `select public.save_invoice_draft($1, null, $2)`, [id, JSON.stringify(items)]);
  return id;
};
const finalize = async (uid, id) => (await q(db, uid, `select public.finalize_invoice($1) r`, [id]))[0].r;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'inv-owner-a@example.com', slug: 'inv-salon-a' });
  B = await createTenantWithOwner(db, { email: 'inv-owner-b@example.com', slug: 'inv-salon-b' });
  [seeb] = await q(db, A.ownerId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'SEEB', 'Seeb') returning id`, [A.tenantId]);
  seeb = seeb.id;
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'inv-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'inv-mgr@example.com', roleCodes: ['manager'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'inv-sty@example.com', roleCodes: ['stylist'], allBranches: true });
  [{ id: colourSvc }] = await q(db, A.ownerId, `insert into public.services (tenant_id, name_en, price) values ($1, 'Root colour', 20) returning id`, [A.tenantId]);
  year = new Date().toLocaleString('en-US', { timeZone: 'Asia/Muscat', year: 'numeric' });
});

test('products are managed with inventory.manage; sellers can read them', async () => {
  [{ id: shampoo }] = await q(db, manager.userId,
    `insert into public.products (tenant_id, sku, name_en, kind, sale_price, cost_price, reorder_level) values ($1, 'KER-SH-250', 'Kerastase Shampoo', 'retail', 8, 3, 5) returning id`, [A.tenantId]);
  [{ id: dye }] = await q(db, manager.userId,
    `insert into public.products (tenant_id, name_en, kind, unit, cost_price) values ($1, 'Colour tube', 'consumable', 'ml', 0.05) returning id`, [A.tenantId]);
  await expectPgError(q(db, cashier.userId, `insert into public.products (tenant_id, name_en) values ($1, 'Hack')`, [A.tenantId]), /row-level security/);
  await expectPgError(q(db, manager.userId, `insert into public.products (tenant_id, sku, name_en) values ($1, 'ker-sh-250', 'Duplicate SKU')`, [A.tenantId]), /duplicate key/);
  assert.equal((await q(db, cashier.userId, `select id from public.products`)).length, 2);
  assert.equal((await q(db, stylist.userId, `select id from public.products`)).length, 0);
});

test('opening stock and counts post adjustment movements', async () => {
  assert.equal((await q(db, manager.userId, `select public.adjust_stock($1, $2, 'Opening count') n`, [A.branchId,
    JSON.stringify([{ product_id: shampoo, counted: 10, unit_cost: 3 }, { product_id: dye, counted: 100, unit_cost: 0.05 }])]))[0].n, 2);
  assert.deepEqual(await balance(A.branchId, shampoo), { q: 10, c: 3 });
  const [m] = await q(db, manager.userId, `select reason, quantity::float8 q from public.inventory_movements where product_id = $1`, [shampoo]);
  assert.deepEqual(m, { reason: 'opening', q: 10 });
  await expectPgError(q(db, cashier.userId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, delta: 1 }])]), 'FORBIDDEN');
  await expectPgError(q(db, manager.userId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, delta: -50 }])]), 'INSUFFICIENT_STOCK');
  await expectPgError(q(db, manager.userId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, counted: -1 }])]), 'INVALID_QUANTITY');
});

test('purchase orders: number on submit, partial receipts, weighted average cost', async () => {
  [{ id: supplier }] = await q(db, manager.userId, `insert into public.suppliers (tenant_id, name, phone) values ($1, 'Gulf Beauty Trading', '+96824000000') returning id`, [A.tenantId]);
  const [{ po }] = await q(db, manager.userId, `select public.save_purchase_order($1, $2, null, $3, $4) po`,
    [A.tenantId, A.branchId, supplier, JSON.stringify([{ product_id: shampoo, quantity: 10, unit_cost: 4 }, { product_id: dye, quantity: 500, unit_cost: 0.04 }])]);
  const [{ n }] = await q(db, manager.userId, `select public.submit_purchase_order($1) n`, [po]);
  assert.equal(n, `PO-MAIN-${year}-000001`);
  await expectPgError(q(db, manager.userId, `select public.save_purchase_order($1, $2, $3, $4, $5)`,
    [A.tenantId, A.branchId, po, supplier, JSON.stringify([{ product_id: shampoo, quantity: 1, unit_cost: 1 }])]), 'PURCHASE_ORDER_LOCKED');

  const items = await q(db, manager.userId, `select id, product_id from public.purchase_order_items where purchase_order_id = $1 order by sort_order`, [po]);
  const shampooLine = items.find((i) => i.product_id === shampoo).id;
  const dyeLine = items.find((i) => i.product_id === dye).id;
  const [{ r }] = await q(db, manager.userId, `select public.receive_purchase_order($1, $2, 'INV-778') r`, [po, JSON.stringify([{ item_id: shampooLine, quantity: 5 }])]);
  assert.deepEqual([r.status, r.total_cost], ['partially_received', 20]);
  // (10 × 3 + 5 × 4) / 15 = 3.3333
  assert.deepEqual(await balance(A.branchId, shampoo), { q: 15, c: 3.3333 });
  await expectPgError(q(db, manager.userId, `select public.receive_purchase_order($1, $2)`, [po, JSON.stringify([{ item_id: shampooLine, quantity: 6 }])]), 'OVER_RECEIPT');
  const [{ r: done }] = await q(db, manager.userId, `select public.receive_purchase_order($1, $2) r`,
    [po, JSON.stringify([{ item_id: shampooLine, quantity: 5, unit_cost: 4.5 }, { item_id: dyeLine, quantity: 500 }])]);
  assert.equal(done.status, 'received');
  const [p] = await q(db, manager.userId, `select cost_price::float8 c from public.products where id = $1`, [shampoo]);
  assert.equal(p.c, 4.5, 'last purchase cost is remembered');
  await expectPgError(q(db, manager.userId, `select public.cancel_purchase_order($1)`, [po]), 'PURCHASE_ORDER_LOCKED');
  await expectPgError(q(db, cashier.userId, `select public.submit_purchase_order($1)`, [po]), /NOT_FOUND|FORBIDDEN/);
});

test('retail sales leave stock at average cost; not enough stock blocks the sale', async () => {
  const before = await balance(A.branchId, shampoo); // 20 units
  const id = await sale(cashier.userId, [{ product_id: shampoo, quantity: 2 }]);
  const inv = await finalize(cashier.userId, id);
  assert.equal(inv.total, 16);
  const after = await balance(A.branchId, shampoo);
  assert.equal(after.q, before.q - 2);
  const [m] = await q(db, manager.userId, `select reason, quantity::float8 q, unit_cost::float8 c from public.inventory_movements where source_id = $1`, [inv.id]);
  assert.deepEqual(m, { reason: 'sale', q: -2, c: before.c });

  await expectPgError(sale(cashier.userId, [{ product_id: shampoo, quantity: 50 }]), 'INSUFFICIENT_STOCK');
  // Price changes need pos.discount; consumables are not for sale.
  await expectPgError(sale(cashier.userId, [{ product_id: shampoo, unit_price: 5 }]), 'PRICE_OVERRIDE_FORBIDDEN');
  await expectPgError(sale(cashier.userId, [{ product_id: dye }]), 'INVALID_PRODUCT');
});

test('two tills selling the last units: the second checkout fails and uses no number', async () => {
  const { q: left } = await balance(A.branchId, shampoo);
  const t1 = await sale(cashier.userId, [{ product_id: shampoo, quantity: left - 1 }]);
  const t2 = await sale(manager.userId, [{ product_id: shampoo, quantity: left - 1 }]); // valid when saved
  const first = await finalize(cashier.userId, t1);
  await expectPgError(finalize(manager.userId, t2), 'INSUFFICIENT_STOCK');
  const [still] = await q(db, A.ownerId, `select status, number from public.invoices where id = $1`, [t2]);
  assert.deepEqual(still, { status: 'draft', number: null });
  assert.equal((await balance(A.branchId, shampoo)).q, 1);
  const third = await finalize(cashier.userId, await sale(cashier.userId, [{ product_id: shampoo, quantity: 1 }]));
  assert.equal(third.sequence_no, first.sequence_no + 1, 'no gap');
  await q(db, manager.userId, `select public.void_invoice_draft($1)`, [t2]);

  // A credit note brings the units back at the cost they left with.
  const [{ r: cn }] = await q(db, manager.userId, `select public.create_credit_note($1, null, 'Returned unopened', null) r`, [third.id]);
  const [ret] = await q(db, manager.userId, `select reason, quantity::float8 q from public.inventory_movements where source_id = $1`, [cn.credit_note_id]);
  assert.deepEqual(ret, { reason: 'sale_return', q: 1 });
  assert.equal((await balance(A.branchId, shampoo)).q, 1);
});

test('services consume their products automatically, never blocking checkout', async () => {
  await expectPgError(q(db, manager.userId, `select public.set_service_product_usage($1, $2)`, [colourSvc, JSON.stringify([{ product_id: shampoo, quantity: 1 }])]), 'INVALID_ITEMS');
  await q(db, manager.userId, `select public.set_service_product_usage($1, $2)`, [colourSvc, JSON.stringify([{ product_id: dye, quantity: 30 }])]);
  const start = (await balance(A.branchId, dye)).q; // 600 ml
  await finalize(cashier.userId, await sale(cashier.userId, [{ service_id: colourSvc, quantity: 2 }]));
  assert.equal((await balance(A.branchId, dye)).q, start - 60);
  // Not enough dye left: the visit is still billed, stock goes negative for correction.
  await q(db, manager.userId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: dye, counted: 10 }])]);
  await finalize(cashier.userId, await sale(cashier.userId, [{ service_id: colourSvc }]));
  assert.equal((await balance(A.branchId, dye)).q, -20);
  const [{ low }] = (await q(db, manager.userId, `select low from public.get_stock($1) where product_id = $2`, [A.branchId, dye]));
  assert.equal(low, true);
});

test('transfers move stock between branches at the source average cost', async () => {
  await q(db, manager.userId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, delta: 9, unit_cost: 4 }])]);
  const src = await balance(A.branchId, shampoo);
  await q(db, manager.userId, `select public.transfer_stock($1, $2, $3, 'Restock Seeb')`, [A.branchId, seeb, JSON.stringify([{ product_id: shampoo, quantity: 4 }])]);
  assert.equal((await balance(A.branchId, shampoo)).q, src.q - 4);
  assert.deepEqual(await balance(seeb, shampoo), { q: 4, c: src.c });
  await expectPgError(q(db, manager.userId, `select public.transfer_stock($1, $1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, quantity: 1 }])]), 'INVALID_BRANCH');
  await expectPgError(q(db, manager.userId, `select public.transfer_stock($1, $2, $3)`, [A.branchId, seeb, JSON.stringify([{ product_id: shampoo, quantity: 999 }])]), 'INSUFFICIENT_STOCK');
  await expectPgError(q(db, cashier.userId, `select public.transfer_stock($1, $2, $3)`, [A.branchId, seeb, JSON.stringify([{ product_id: shampoo, quantity: 1 }])]), 'FORBIDDEN');
});

test('the ledger is append-only and balances can only change through it', async () => {
  await expectPgError(q(db, A.ownerId, `update public.inventory_movements set quantity = 1`), /permission denied/);
  await expectPgError(db.query(`update public.inventory_movements set quantity = 1`), 'MOVEMENT_IMMUTABLE');
  await expectPgError(q(db, A.ownerId, `update public.inventory_balances set quantity = 999`), /permission denied/);
  // Every balance equals the sum of its movements.
  const rows = await db.query(`
    select b.branch_id, b.product_id, b.quantity::float8 q, coalesce(sum(m.quantity), 0)::float8 s
    from public.inventory_balances b left join public.inventory_movements m on m.branch_id = b.branch_id and m.product_id = b.product_id
    where b.tenant_id = $1 group by b.branch_id, b.product_id, b.quantity`, [A.tenantId]);
  for (const r of rows.rows) assert.equal(r.q, r.s, `balance drift for ${r.product_id}`);
});

test('isolation and permissions', async () => {
  for (const table of ['products', 'suppliers', 'inventory_balances', 'inventory_movements', 'purchase_orders', 'purchase_order_items', 'purchase_receipts', 'service_product_usage']) {
    const rows = await q(db, B.ownerId, `select tenant_id from public.${table}`);
    for (const r of rows) assert.equal(r.tenant_id, B.tenantId, `${table} leaked`);
  }
  await expectPgError(q(db, B.ownerId, `select * from public.get_stock($1)`, [A.branchId]), 'FORBIDDEN');
  await expectPgError(q(db, B.ownerId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, delta: 1 }])]), 'FORBIDDEN');
  const [bProduct] = await q(db, B.ownerId, `insert into public.products (tenant_id, name_en) values ($1, 'B product') returning id`, [B.tenantId]);
  await expectPgError(q(db, manager.userId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: bProduct.id, delta: 1 }])]), 'INVALID_PRODUCT');
  await expectPgError(q(db, manager.userId, `select public.save_purchase_order($1, $2, null, $3, $4)`,
    [A.tenantId, A.branchId, supplier, JSON.stringify([{ product_id: bProduct.id, quantity: 1, unit_cost: 1 }])]), 'INVALID_ITEMS');
  assert.ok(num((await q(db, stylist.userId, `select count(*) n from public.inventory_balances`))[0].n) === 0);
});
