/* Mock data for the AI CEO Dashboard — shape mirrors the future API contracts. */

export const kpis = [
  { label: "Revenue", value: 4230000, delta: +8.2, good: "up" },
  { label: "Collected", value: 3810000, delta: +5.1, good: "up" },
  { label: "Pending", value: 420000, delta: +12.4, good: "down" },
  { label: "Expenses", value: 3100000, delta: -3.0, good: "down" },
  { label: "Net Profit", value: 1130000, delta: +15.3, good: "up" },
  { label: "New Orders", value: 18, delta: null, suffix: "today", good: "up" },
] as const;

export const cashFlow = [
  { m: "Apr", in: 36.2, out: 30.1 },
  { m: "May", in: 38.9, out: 31.4 },
  { m: "Jun", in: 35.1, out: 29.8 },
  { m: "Jul", in: 40.2, out: 33.0 },
  { m: "Aug", in: 39.5, out: 30.9 },
  { m: "Sep", in: 42.3, out: 31.0 },
  { m: "Oct", in: 45.0, out: 33.5, proj: true },
  { m: "Nov", in: 47.8, out: 34.2, proj: true },
];

export const plSummary = [
  { label: "Income", value: 4230000 },
  { label: "COGS", value: -2410000 },
  { label: "Expenses", value: -690000 },
];

export const salesTrend = [
  { d: "Apr", v: 8.4 }, { d: "May", v: 9.1 }, { d: "Jun", v: 8.7 },
  { d: "Jul", v: 10.2 }, { d: "Aug", v: 11.0 }, { d: "Sep", v: 12.4 },
];

export const monthlyTargets = [
  { label: "Revenue", pct: 82, of: "₹42.3L of ₹52L" },
  { label: "Orders", pct: 61, of: "134 of 220" },
  { label: "Collections", pct: 74, of: "₹38.1L of ₹51.5L" },
];

export const branches = [
  { name: "Delhi HQ", value: 2800000, pct: 100 },
  { name: "Jaipur", value: 1400000, pct: 50 },
  { name: "Lucknow", value: 930000, pct: 33 },
];

export const pendingPayments = [
  { name: "Sharma Traders", amount: 120000, days: 45 },
  { name: "Gupta & Sons", amount: 90000, days: 30 },
  { name: "Mehta Bros", amount: 60000, days: 22 },
];

export const pendingApprovals = [
  { id: 1, title: "PO-118 · ₹2.4L", sub: "Kavita · Raw materials" },
  { id: 2, title: "Leave request", sub: "R. Meena · 18–20 Sep" },
  { id: 3, title: "Discount 15% · INV-0235", sub: "Amit · exceeds limit" },
];

export const companyAlerts = [
  { sev: "danger", text: "GST filing due in 5 days", cta: "Prepare" },
  { sev: "warning", text: "8 items below reorder level", cta: "View stock" },
  { sev: "ai", text: "2 expense anomalies flagged by AI", cta: "Review" },
] as const;

export const topCustomers = [
  { name: "Sharma Traders", value: 820000 },
  { name: "Gupta & Sons", value: 640000 },
  { name: "Mehta Bros", value: 590000 },
  { name: "Verma Enterprises", value: 410000 },
  { name: "Kapoor Retail", value: 360000 },
];

export const topVendors = [
  { name: "ABC Supplies", value: 510000 },
  { name: "XYZ Metals", value: 380000 },
  { name: "RoadLines Logistics", value: 220000 },
  { name: "PackWell", value: 190000 },
  { name: "Om Sai Traders", value: 150000 },
];

export const topRisks = [
  { sev: "danger", text: "Cash gap projected in week 3 of Oct" },
  { sev: "warning", text: "1 customer = 22% of revenue" },
  { sev: "warning", text: "Attrition risk: sales team" },
] as const;

export const aiSuggestions = [
  {
    text: "Offer 2% early-pay discount to Sharma Traders — likely to recover ₹1.2L two weeks sooner.",
    confidence: 87,
  },
  {
    text: "Reorder SKU-102 now — demand rising before Diwali.",
    confidence: 78,
  },
];
