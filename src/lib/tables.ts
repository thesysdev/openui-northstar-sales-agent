// The retail tables the database view can browse, in display order. Only these names ever
// reach SQL (the /api/db route checks against this list).
export const TABLES = [
  "orders",
  "order_items",
  "customers",
  "products",
  "product_variants",
  "returns",
  "promotions",
  "order_promotions",
  "sales_targets",
] as const;

export type TableName = (typeof TABLES)[number];

/** The Data view's left rail groups the tables by what they describe. */
export const TABLE_GROUPS: { label: string; tables: TableName[] }[] = [
  { label: "Sales", tables: ["orders", "order_items", "returns"] },
  { label: "Catalog", tables: ["products", "product_variants"] },
  { label: "Customers", tables: ["customers"] },
  { label: "Marketing", tables: ["promotions", "order_promotions"] },
  { label: "Planning", tables: ["sales_targets"] },
];

export const TABLE_DESCRIPTIONS: Record<TableName, string> = {
  orders: "One row per order: status, region, channel, device",
  order_items: "Line items with prices, discounts and COGS",
  returns: "Processed returns with reasons and refunds",
  products: "Styles with category, brand and launch dates",
  product_variants: "SKUs with size, color and list price",
  customers: "Shoppers with signup and acquisition data",
  promotions: "Promo codes and their windows",
  order_promotions: "Discounts allocated to order items",
  sales_targets: "Approved monthly net sales targets",
};
