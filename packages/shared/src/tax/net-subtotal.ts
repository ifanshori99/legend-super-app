// legend-zmc2: an inclusive-price (harga nett) order stores the gross line sum
// in subtotal_idr, with the service charge and tax already inside it. Every
// consumer that adds service and tax again (payment links, the sales journal,
// refund splits) needs the subtotal without them. Exclusive orders keep their
// subtotal as is. Browser- and Node-safe.

export type OrderNetSubtotalInput = {
  readonly subtotalIdr: number;
  readonly serviceChargeIdr: number;
  readonly taxIdr: number;
  readonly pricesIncludeTax: boolean;
};

/** The order subtotal before service charge and tax (gross sales). */
export function orderNetSubtotalIdr(input: OrderNetSubtotalInput): number {
  return input.pricesIncludeTax
    ? input.subtotalIdr - input.serviceChargeIdr - input.taxIdr
    : input.subtotalIdr;
}
