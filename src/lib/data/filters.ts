// What a dashboard can filter by: the four dimensions every data tool narrows to, with the values
// in the data, and the date presets. One list, read by the data tools (their argument schemas)
// and by create_dashboard (the filter bar it asks for), so a filter never offers a value the
// tools don't know.

export const FILTERS = {
  region: {
    label: "Region",
    all: "All regions",
    values: ["West", "South", "Midwest", "Northeast"],
  },
  category: {
    label: "Category",
    all: "All categories",
    values: ["apparel", "footwear", "accessories"],
  },
  brand: {
    label: "Brand",
    all: "All brands",
    values: [
      "Northstar",
      "Northstar Footwear",
      "Northstar Studio",
      "N. Active",
      "North & Co.",
      "Weekend Supply",
    ],
  },
  channel: {
    label: "Channel",
    all: "All channels",
    values: [
      "direct",
      "email",
      "organic_search",
      "paid_search",
      "paid_social",
      "referral",
      "affiliate",
    ],
  },
} as const;

export type FilterName = keyof typeof FILTERS;
export const FILTER_NAMES = Object.keys(FILTERS) as [FilterName, ...FilterName[]];

/** The date filter's presets: its value (what the tools read as `range`) and its label. */
export const RANGES = [
  { value: "1m", label: "Last month" },
  { value: "3m", label: "Last 3 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "lifetime", label: "Lifetime" },
] as const;

export type RangeValue = (typeof RANGES)[number]["value"];
export const RANGE_VALUES = RANGES.map((range) => range.value) as [RangeValue, ...RangeValue[]];

/** "organic_search" → "Organic search", for a filter option's label. */
export const optionLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
