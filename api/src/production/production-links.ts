import { z } from 'zod';

type Row = Record<string, unknown>;

/**
 * The production order, lot and serial number a record (an inspection or a non-conformance) is linked to. Joined with `linkJoins(alias)` and read with `toLinks`.
 * A person without production.read sees the record but not the links (row-level security hides the rows), so all three come back null.
 */
export const ProductionLinks = z.object({
  productionOrder: z.object({ id: z.string().uuid(), orderNumber: z.string(), status: z.string() }).nullable(),
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string(), status: z.string(), statusReason: z.string().nullable() }).nullable(),
  serial: z.object({ id: z.string().uuid(), serialNumber: z.string(), status: z.string() }).nullable(),
});
export type ProductionLinks = z.infer<typeof ProductionLinks>;

export const LINK_COLUMNS = `lk_o.id as lk_order_id, lk_o.order_number as lk_order_number, lk_o.status as lk_order_status,
  lk_l.id as lk_lot_id, lk_l.lot_number as lk_lot_number, lk_l.status as lk_lot_status, lk_l.status_reason as lk_lot_reason,
  lk_s.id as lk_serial_id, lk_s.serial_number as lk_serial_number, lk_s.status as lk_serial_status`;

export const linkJoins = (alias: string) => `
  left join public.production_orders lk_o on lk_o.id = ${alias}.production_order_id
  left join public.lots lk_l on lk_l.id = ${alias}.lot_id
  left join public.serial_numbers lk_s on lk_s.id = ${alias}.serial_id`;

export const toLinks = (r: Row): ProductionLinks => ({
  productionOrder: r.lk_order_id ? { id: r.lk_order_id as string, orderNumber: r.lk_order_number as string, status: r.lk_order_status as string } : null,
  lot: r.lk_lot_id ? { id: r.lk_lot_id as string, lotNumber: r.lk_lot_number as string, status: r.lk_lot_status as string, statusReason: (r.lk_lot_reason as string) ?? null } : null,
  serial: r.lk_serial_id ? { id: r.lk_serial_id as string, serialNumber: r.lk_serial_number as string, status: r.lk_serial_status as string } : null,
});
