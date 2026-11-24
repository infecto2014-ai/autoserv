export type Role = "ADMIN" | "RECEPTION" | "MASTER";
export type OrderStatus =
  | "NEW"
  | "DIAGNOSTICS"
  | "APPROVAL"
  | "IN_PROGRESS"
  | "READY"
  | "DELIVERED"
  | "CANCELLED";
export type Condition =
  | "UNCHECKED"
  | "CHECKED"
  | "REPAIR"
  | "RECOMMENDED"
  | "DONE";
export type PartVariant = "NONE" | "ORIGINAL" | "ANALOG" | "CUSTOM";
export type DocumentKind = "INSPECTION" | "WORK_ORDER";
export interface Actor {
  id: string;
  name: string;
  email: string;
  role: Role;
}
export interface Customer {
  id: string;
  kind: string;
  name: string;
  phone: string;
  email: string | null;
  comment: string;
  archivedAt: string | null;
}
export interface Vehicle {
  id: string;
  customerId: string;
  make: string;
  model: string;
  year: number | null;
  vin: string | null;
  plate: string | null;
  mileage: number;
  engine: string;
  comment: string;
  archivedAt: string | null;
  customer?: Customer;
  orders?: OrderDetail[];
}
export interface Staff extends Actor {
  active: boolean;
}
export interface CatalogItem {
  id: string;
  category: string;
  name: string;
  unit: string;
  laborPriceCents: number;
  active: boolean;
  sortOrder: number;
}
export interface InspectionItem {
  id: string;
  catalogItemId: string | null;
  category: string;
  name: string;
  left: boolean;
  right: boolean;
  condition: Condition;
  quantityMilli: number;
  laborPriceCents: number;
  originalPriceCents: number;
  analogPriceCents: number;
  customPriceCents: number;
  selectedPart: PartVariant;
  note: string;
}
export interface OrderLine {
  id?: string;
  kind: "LABOR" | "PART";
  name: string;
  quantityMilli: number;
  unitPriceCents: number;
  variant: PartVariant;
  article: string;
  inspectionItemId?: string | null;
  approval: "PENDING" | "APPROVED" | "DEFERRED";
  completed: boolean;
  partSource: "SERVICE" | "CUSTOMER";
}
export interface Totals {
  laborCents: number;
  partsCents: number;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  overpaidCents: number;
}
export interface DocumentMeta {
  id: string;
  number: string;
  kind: DocumentKind;
  version: number;
  createdAt: string;
  sha256: string;
  templateVersion: string;
}
export interface OrderDetail {
  id: string;
  number: string;
  customerId: string;
  vehicleId: string;
  masterId: string | null;
  status: OrderStatus;
  mileage: number;
  complaint: string;
  comment: string;
  recommendations: string;
  discountCents: number;
  paidCents: number;
  version: number;
  openedAt: string;
  closedAt: string | null;
  customer: Customer;
  vehicle: Vehicle;
  master: { id: string; name: string } | null;
  inspectionItems: InspectionItem[];
  lines: OrderLine[];
  documents: DocumentMeta[];
  financialMode: "LEGACY" | "WORKFLOW";
  legacySnapshot: (Totals & { orderId: string }) | null;
  payments: Payment[];
  completionActNeedsUpdate: boolean;
  totals: Totals;
}
export interface Settings {
  id: string;
  name: string;
  address: string;
  phone: string;
  taxId: string;
  timezone: string;
}
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Payment {
  id: string;
  kind: "OPENING" | "PAYMENT" | "REFUND";
  amountCents: number;
  laborCents: number;
  partsCents: number;
  unallocatedCents: number;
  occurredAt: string | null;
  relatedPaymentId: string | null;
  reason: string | null;
}
