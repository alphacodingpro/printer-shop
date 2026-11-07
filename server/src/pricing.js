import { HttpError } from './errors.js';

export function pagesToPrint(order) {
  const total = order.total_pages;
  const from = order.page_from ?? 1;
  const to = order.page_to ?? total;
  return to - from + 1;
}

export async function priceOrder(db, shopId, o) {
  const r = await db.query(
    `SELECT price_per_page FROM pricing_rules
      WHERE shop_id = $1 AND color_mode = $2 AND paper_size = $3 AND sides = $4`,
    [shopId, o.color_mode, o.paper_size, o.sides]
  );
  if (!r.rows.length) throw new HttpError(400, 'This print option is not offered by this shop');
  const amount = r.rows[0].price_per_page * pagesToPrint(o) * o.copies;
  return Math.round(amount * 100) / 100;
}
