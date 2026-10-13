/* Mock data for module list pages — mirrors future API contracts. */

export const invoices = [
  { id: "INV-0234", date: "12 Sep 26", customer: "Sharma Traders", amount: 84500, due: "3d", status: "Sent", tone: "info" },
  { id: "INV-0233", date: "11 Sep 26", customer: "Gupta & Sons", amount: 120000, due: "OVER 30d", status: "Overdue", tone: "danger" },
  { id: "INV-0232", date: "10 Sep 26", customer: "Mehta Bros", amount: 62000, due: "12d", status: "Sent", tone: "info" },
  { id: "INV-0231", date: "09 Sep 26", customer: "Verma Enterprises", amount: 96400, due: "—", status: "Paid", tone: "success" },
  { id: "INV-0230", date: "08 Sep 26", customer: "Kapoor Retail", amount: 41200, due: "—", status: "Paid", tone: "success" },
  { id: "INV-0229", date: "07 Sep 26", customer: "Sharma Traders", amount: 35800, due: "OVER 45d", status: "Overdue", tone: "danger" },
  { id: "INV-0228", date: "05 Sep 26", customer: "Om Sai Traders", amount: 78900, due: "8d", status: "Sent", tone: "info" },
  { id: "INV-0227", date: "04 Sep 26", customer: "New customer", amount: 22000, due: "—", status: "Draft", tone: "neutral" },
] as const;

export const customers = [
  { id: "CUST-118", name: "Sharma Traders", grade: "A", city: "Delhi", lifetime: 4800000, outstanding: 120000, status: "Active", tone: "success" },
  { id: "CUST-092", name: "Gupta & Sons", grade: "A", city: "Jaipur", lifetime: 3900000, outstanding: 90000, status: "Active", tone: "success" },
  { id: "CUST-071", name: "Mehta Bros", grade: "B", city: "Delhi", lifetime: 2900000, outstanding: 60000, status: "Active", tone: "success" },
  { id: "CUST-055", name: "Verma Enterprises", grade: "B", city: "Lucknow", lifetime: 2100000, outstanding: 0, status: "Active", tone: "success" },
  { id: "CUST-140", name: "Kapoor Retail", grade: "C", city: "Delhi", lifetime: 840000, outstanding: 0, status: "Inactive", tone: "neutral" },
] as const;

export const salesOrders = [
  { id: "SO-0311", date: "15 Sep 26", customer: "Sharma Traders", items: 12, amount: 154000, status: "Confirmed", tone: "info" },
  { id: "SO-0310", date: "15 Sep 26", customer: "Kapoor Retail", items: 4, amount: 31200, status: "Packed", tone: "success" },
  { id: "SO-0309", date: "14 Sep 26", customer: "Mehta Bros", items: 8, amount: 88400, status: "Dispatched", tone: "success" },
  { id: "SO-0308", date: "14 Sep 26", customer: "Gupta & Sons", items: 20, amount: 214000, status: "Draft", tone: "neutral" },
  { id: "SO-0307", date: "13 Sep 26", customer: "Verma Enterprises", items: 6, amount: 56000, status: "Delivered", tone: "success" },
] as const;

export const quotations = [
  { id: "QT-0140", date: "14 Sep 26", customer: "Jain Electricals", amount: 186000, status: "Sent", tone: "info" },
  { id: "QT-0139", date: "12 Sep 26", customer: "Kapoor Retail", amount: 44500, status: "Accepted", tone: "success" },
  { id: "QT-0138", date: "10 Sep 26", customer: "Sharma Traders", amount: 320000, status: "Negotiation", tone: "warning" },
  { id: "QT-0136", date: "08 Sep 26", customer: "Mehta Bros", amount: 91200, status: "Expired", tone: "neutral" },
] as const;

export const followUps = [
  { id: "INV-0233", customer: "Gupta & Sons", amount: 120000, days: 30, last: "Call · 2d ago", next: "WhatsApp · Tue AM" },
  { id: "INV-0229", customer: "Sharma Traders", amount: 120000, days: 45, last: "Email · 5d ago", next: "AI draft ready" },
  { id: "INV-0215", customer: "Mehta Bros", amount: 60000, days: 22, last: "WhatsApp · 1d ago", next: "Call · today" },
] as const;

export const purchaseOrders = [
  { id: "PO-118", date: "13 Sep 26", vendor: "ABC Supplies", items: 40, amount: 240000, status: "Pending approval", tone: "warning" },
  { id: "PO-117", date: "12 Sep 26", vendor: "XYZ Metals", items: 18, amount: 186500, status: "Sent", tone: "info" },
  { id: "PO-116", date: "10 Sep 26", vendor: "RoadLines Logistics", items: 1, amount: 48000, status: "Received", tone: "success" },
  { id: "PO-115", date: "08 Sep 26", vendor: "PackWell", items: 200, amount: 64200, status: "Received", tone: "success" },
  { id: "PO-114", date: "05 Sep 26", vendor: "Om Sai Traders", items: 35, amount: 97800, status: "Draft", tone: "neutral" },
] as const;

export const vendors = [
  { id: "VEN-041", name: "ABC Supplies", city: "Delhi", rating: "A", spend: 5100000, outstanding: 240000, status: "Active", tone: "success" },
  { id: "VEN-036", name: "XYZ Metals", city: "Jaipur", rating: "A", spend: 3800000, outstanding: 0, status: "Active", tone: "success" },
  { id: "VEN-052", name: "RoadLines Logistics", city: "Delhi", rating: "B", spend: 2200000, outstanding: 18000, status: "Active", tone: "success" },
  { id: "VEN-019", name: "PackWell", city: "Lucknow", rating: "B", spend: 1900000, outstanding: 0, status: "Active", tone: "success" },
  { id: "VEN-060", name: "Om Sai Traders", city: "Delhi", rating: "C", spend: 1500000, outstanding: 45000, status: "On hold", tone: "warning" },
] as const;

export const purchaseRequests = [
  { id: "PR-0212", item: "Copper wire 1.5mm ×200", by: "Inventory · auto (low stock)", amount: 240000, status: "Awaiting PO", tone: "warning" },
  { id: "PR-0211", item: "LED driver 40W ×50", by: "AI demand forecast", amount: 41500, status: "Approved", tone: "success" },
  { id: "PR-0210", item: "MCB 32A ×100", by: "Mohan (warehouse)", amount: 24000, status: "Converted", tone: "info" },
] as const;

export const goodsReceipts = [
  { id: "GRN-0089", po: "PO-116", vendor: "RoadLines Logistics", date: "14 Sep 26", items: "1 of 1", status: "QC passed", tone: "success" },
  { id: "GRN-0088", po: "PO-115", vendor: "PackWell", date: "11 Sep 26", items: "200 of 200", status: "QC passed", tone: "success" },
  { id: "GRN-0087", po: "PO-112", vendor: "ABC Supplies", date: "09 Sep 26", items: "36 of 40", status: "Partial", tone: "warning" },
] as const;

export const stock = [
  { sku: "SKU-102", item: "Copper wire 1.5mm", whs: "DEL", inHand: 240, reserved: 60, avail: 180, reorder: 200, status: "Low", tone: "warning", val: 210000 },
  { sku: "SKU-077", item: "MCB 32A", whs: "DEL", inHand: 890, reserved: 0, avail: 890, reorder: 100, status: "OK", tone: "success", val: 170000 },
  { sku: "SKU-211", item: "LED driver 40W", whs: "JAI", inHand: 0, reserved: 0, avail: 0, reorder: 50, status: "Out", tone: "danger", val: 0 },
  { sku: "SKU-145", item: "Cable joint kit", whs: "DEL", inHand: 120, reserved: 10, avail: 110, reorder: 80, status: "OK", tone: "success", val: 60000 },
  { sku: "SKU-090", item: "Distribution box 8-way", whs: "LKO", inHand: 45, reserved: 5, avail: 40, reorder: 40, status: "OK", tone: "success", val: 96000 },
  { sku: "SKU-033", item: "PVC conduit 25mm", whs: "DEL", inHand: 310, reserved: 40, avail: 270, reorder: 150, status: "OK", tone: "success", val: 88000 },
] as const;

export const stockAlerts = [
  { sku: "SKU-211", item: "LED driver 40W", issue: "Out of stock — reorder 50", sev: "danger" },
  { sku: "SKU-102", item: "Copper wire 1.5mm", issue: "Below reorder level (180 < 200)", sev: "warning" },
  { sku: "SKU-145", item: "Batch B-2291", issue: "40 units expire 05 Oct", sev: "warning" },
] as const;

export const warehouses = [
  { id: "WH-DEL", name: "Delhi HQ Godown", items: 1240, util: 72, manager: "Mohan L." },
  { id: "WH-JAI", name: "Jaipur Branch Store", items: 480, util: 41, manager: "Suresh K." },
  { id: "WH-LKO", name: "Lucknow Branch Store", items: 310, util: 28, manager: "Rekha V." },
] as const;

export const transfers = [
  { id: "TR-0141", from: "Delhi HQ", to: "Jaipur", items: "SKU-090 ×20", date: "14 Sep 26", status: "In transit", tone: "info" },
  { id: "TR-0140", from: "Delhi HQ", to: "Lucknow", items: "SKU-033 ×60", date: "12 Sep 26", status: "Received", tone: "success" },
  { id: "TR-0139", from: "Jaipur", to: "Delhi HQ", items: "SKU-211 ×15", date: "10 Sep 26", status: "Received", tone: "success" },
] as const;

export const expenses = [
  { id: "EXP-0911", date: "14 Sep 26", category: "Logistics", vendor: "RoadLines", amount: 18400, status: "Approved", tone: "success" },
  { id: "EXP-0910", date: "14 Sep 26", category: "Utilities", vendor: "BSES", amount: 22100, status: "Approved", tone: "success" },
  { id: "EXP-0909", date: "13 Sep 26", category: "Travel", vendor: "—", amount: 6400, status: "Pending", tone: "warning" },
  { id: "EXP-0908", date: "12 Sep 26", category: "Office supplies", vendor: "PackWell", amount: 9800, status: "Flagged by AI", tone: "danger" },
  { id: "EXP-0907", date: "11 Sep 26", category: "Marketing", vendor: "—", amount: 45000, status: "Approved", tone: "success" },
  { id: "EXP-0906", date: "10 Sep 26", category: "Repairs", vendor: "Om Sai Traders", amount: 12500, status: "Approved", tone: "success" },
] as const;

export const income = [
  { id: "PAY-1042", date: "15 Sep 26", from: "Gupta & Sons", method: "NEFT", amount: 120000, status: "Settled", tone: "success" },
  { id: "PAY-1041", date: "14 Sep 26", from: "Kapoor Retail", method: "UPI", amount: 41200, status: "Settled", tone: "success" },
  { id: "PAY-1040", date: "14 Sep 26", from: "Verma Enterprises", method: "Cheque", amount: 96400, status: "Clearing", tone: "warning" },
  { id: "PAY-1039", date: "13 Sep 26", from: "Mehta Bros", method: "NEFT", amount: 56000, status: "Settled", tone: "success" },
] as const;

export const budgets = [
  { name: "Operations", used: 68, of: "₹8.4L of ₹12.4L" },
  { name: "Marketing", used: 91, of: "₹4.6L of ₹5.0L" },
  { name: "Logistics", used: 54, of: "₹2.9L of ₹5.4L" },
  { name: "Payroll buffer", used: 77, of: "₹14.8L of ₹19.2L" },
] as const;

export const employees = [
  { id: "EMP-042", name: "Ramesh Meena", role: "Sales Executive", branch: "Delhi", salary: 42000, leave: "CL 8 · SL 5 · EL 12", status: "Active", tone: "success" },
  { id: "EMP-038", name: "Priya Sharma", role: "Finance Manager", branch: "All", salary: 78000, leave: "CL 6 · SL 7 · EL 15", status: "Active", tone: "success" },
  { id: "EMP-051", name: "Amit Verma", role: "Sales Executive", branch: "Delhi", salary: 45000, leave: "CL 4 · SL 5 · EL 10", status: "Active", tone: "success" },
  { id: "EMP-029", name: "Mohan Lal", role: "Warehouse Keeper", branch: "Delhi", salary: 32000, leave: "CL 9 · SL 6 · EL 14", status: "Active", tone: "success" },
  { id: "EMP-044", name: "Kavita Rao", role: "Purchase Officer", branch: "Jaipur", salary: 52000, leave: "CL 7 · SL 8 · EL 11", status: "On leave", tone: "warning" },
  { id: "EMP-057", name: "Dev Anand", role: "Admin / IT", branch: "Delhi", salary: 64000, leave: "CL 10 · SL 9 · EL 18", status: "Active", tone: "success" },
] as const;

export const attendance = [
  { name: "Ramesh Meena", present: "22/24", late: "3d", ot: "4h", status: "Present", tone: "success" },
  { name: "Priya Sharma", present: "24/24", late: "0d", ot: "12h", status: "Present", tone: "success" },
  { name: "Amit Verma", present: "21/24", late: "6d", ot: "2h", status: "Late today", tone: "warning" },
  { name: "Mohan Lal", present: "24/24", late: "1d", ot: "18h", status: "Present", tone: "success" },
  { name: "Kavita Rao", present: "18/24", late: "2d", ot: "0h", status: "On leave", tone: "warning" },
] as const;

export const leaveRequests = [
  { id: "LV-0098", name: "Ramesh Meena", type: "CL", dates: "18–20 Sep", days: 3, reason: "Family function", status: "Pending", tone: "warning" },
  { id: "LV-0097", name: "Kavita Rao", type: "SL", dates: "15–16 Sep", days: 2, reason: "Medical", status: "Approved", tone: "success" },
  { id: "LV-0096", name: "Amit Verma", type: "EL", dates: "01–05 Oct", days: 5, reason: "Diwali travel", status: "Pending", tone: "warning" },
] as const;

export const payroll = [
  { name: "Ramesh Meena", gross: 42000, pf: 5040, tds: 0, net: 36960, status: "Ready", tone: "success" },
  { name: "Priya Sharma", gross: 78000, pf: 9360, tds: 3900, net: 64740, status: "Ready", tone: "success" },
  { name: "Amit Verma", gross: 45000, pf: 5400, tds: 0, net: 39600, status: "Ready", tone: "success" },
  { name: "Mohan Lal", gross: 32000, pf: 3840, tds: 0, net: 28160, status: "Hold — bank a/c", tone: "warning" },
] as const;

export const recruitment = [
  { id: "JOB-012", role: "Sales Executive — Jaipur", applicants: 34, stage: "AI screening · 12 shortlisted", status: "Open", tone: "info" },
  { id: "JOB-011", role: "Accounts Assistant", applicants: 58, stage: "Interviews · 4 remaining", status: "Open", tone: "info" },
  { id: "JOB-009", role: "Delivery Driver", applicants: 21, stage: "Offer sent", status: "Closing", tone: "success" },
] as const;

export const approvalsQueue = [
  { id: "PO-118", kind: "Purchase Order", who: "Kavita", age: "2d", ageTone: "warning", amount: "₹2.4L", meta: "ABC Supplies · 40×SKU-102 @ ₹6,000" },
  { id: "LV-0098", kind: "Leave", who: "R. Meena", age: "1d", ageTone: "warning", amount: null, meta: "CL · 18–20 Sep · family function" },
  { id: "INV-0235", kind: "Discount 15%", who: "Amit", age: "4h", ageTone: "neutral", amount: "₹12.6K", meta: "INV-0235 · exceeds limit (10%)" },
  { id: "EXP-0908", kind: "Expense", who: "Rekha", age: "1d", ageTone: "warning", amount: "₹9.8K", meta: "Office supplies · flagged by AI" },
  { id: "PO-119", kind: "Purchase Order", who: "Kavita", age: "3h", ageTone: "neutral", amount: "₹86.4K", meta: "PackWell · packaging batch" },
] as const;

export const projects = [
  { id: "PRJ-014", name: "Jaipur warehouse fit-out", owner: "Kavita", progress: 62, due: "30 Sep", status: "On track", tone: "success" },
  { id: "PRJ-013", name: "Diwali stock-up plan", owner: "Mohan", progress: 78, due: "05 Oct", status: "On track", tone: "success" },
  { id: "PRJ-012", name: "New GST invoicing rollout", owner: "Priya", progress: 35, due: "20 Oct", status: "At risk", tone: "warning" },
] as const;

export const opsTasks = [
  { id: "TSK-0912", title: "Verify GRN-0089 QC photos", who: "Mohan", due: "Today", status: "Open", tone: "warning" },
  { id: "TSK-0911", title: "Share Sept P&L with CA", who: "Priya", due: "Tomorrow", status: "Open", tone: "warning" },
  { id: "TSK-0909", title: "Update reorder rules for SKU-102", who: "Kavita", due: "16 Sep", status: "Done", tone: "success" },
  { id: "TSK-0908", title: "Draft Diwali offer for top customers", who: "Amit", due: "18 Sep", status: "Open", tone: "warning" },
] as const;

export const folders = [
  { name: "All documents", count: 1240 },
  { name: "Invoices", count: 486 },
  { name: "Contracts", count: 37 },
  { name: "HR", count: 128 },
  { name: "Vendor docs", count: 94 },
  { name: "Signed", count: 62 },
  { name: "Archive", count: 433 },
] as const;

export const smartFolders = [
  { name: "Expiring <90d", count: 3 },
  { name: "Unsigned", count: 5 },
] as const;

export const documents = [
  { id: "DOC-441", name: "PO-118-ABC.pdf", meta: "scanned · OCR ✓ · v2", date: "12 Sep · Kavita", status: "Signed", tone: "success" },
  { id: "DOC-440", name: "GST-cert-2026.jpg", meta: "OCR ✓ · tags: gst, cert", date: "11 Sep · Priya", status: "Verified", tone: "success" },
  { id: "DOC-439", name: "lease-agreement.pdf", meta: "OCR processing… 60%", date: "11 Sep · Dev", status: "Processing", tone: "warning" },
  { id: "DOC-438", name: "invoice-scan-hindi.pdf", meta: "OCR ✓ · Devanagari found", date: "10 Sep · Mohan", status: "Verified", tone: "success" },
  { id: "DOC-437", name: "vendor-kyc-xyz.pdf", meta: "OCR ✓", date: "09 Sep · Kavita", status: "Unsigned", tone: "warning" },
] as const;

export const users = [
  { name: "Rajesh Kumar", role: "Owner", branch: "All", tfa: "On", last: "now", status: "Active", tone: "success" },
  { name: "Priya Sharma", role: "Finance Manager", branch: "All", tfa: "On", last: "2h ago", status: "Active", tone: "success" },
  { name: "Amit Verma", role: "Sales Executive", branch: "Delhi", tfa: "Off", last: "5m ago", status: "Active", tone: "success" },
  { name: "Mohan Lal", role: "Warehouse Keeper", branch: "Delhi", tfa: "—", last: "1d ago", status: "Active", tone: "success" },
  { name: "Dev Anand", role: "Admin / IT", branch: "All", tfa: "On", last: "30m ago", status: "Active", tone: "success" },
] as const;

export const roles = [
  { name: "Owner", users: 1, scope: "Everything", editable: false },
  { name: "Finance Manager", users: 1, scope: "Finance, Sales view, Reports", editable: true },
  { name: "Sales Executive", users: 3, scope: "Own invoices & customers", editable: true },
  { name: "Warehouse Keeper", users: 2, scope: "Stock, GRN, transfers", editable: true },
  { name: "Read-only (CA)", users: 1, scope: "Reports & ledgers only", editable: true },
] as const;

export const auditLogs = [
  { when: "10:41", who: "Amit V.", what: "Created INV-0235 with 15% discount", where: "Sales · Delhi" },
  { when: "10:12", who: "Kavita R.", what: "Submitted PO-118 for approval", where: "Purchase · Jaipur" },
  { when: "09:58", who: "Priya S.", what: "Exported GSTR-1 report", where: "Finance" },
  { when: "09:31", who: "Dev A.", what: "Enabled 2FA policy for all users", where: "Admin" },
  { when: "09:05", who: "AI Engine", what: "Flagged EXP-0908 as anomaly", where: "Finance" },
] as const;

export const integrations = [
  { name: "WhatsApp Business", detail: "BSP: Interakt · reminders & invoices", status: "Connected", tone: "success" },
  { name: "Email (SMTP)", detail: "ses.ap-south-1 · sending verified", status: "Connected", tone: "success" },
  { name: "Bank feeds", detail: "HDFC current a/c · daily sync", status: "Connected", tone: "success" },
  { name: "Tally bridge", detail: "Import masters + vouchers", status: "Paused", tone: "warning" },
  { name: "GST / e-invoice", detail: "IRP credentials · NIC", status: "Action needed", tone: "danger" },
] as const;

export const branchesAdmin = [
  { name: "Delhi HQ", gstin: "07AABCE1234F1Z5", users: 9, since: "2019", status: "Active", tone: "success" },
  { name: "Jaipur", gstin: "08AABCE1234F1Z3", users: 4, since: "2022", status: "Active", tone: "success" },
  { name: "Lucknow", gstin: "09AABCE1234F1Z1", users: 3, since: "2024", status: "Setup", tone: "warning" },
] as const;

export const aiPrompts = [
  "How were sales this week?",
  "Who owes me money?",
  "Any risks today?",
  "Draft Diwali offer for top customers",
  "Summarize September P&L",
];
