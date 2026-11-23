import type {
  Customer,
  DocumentKind,
  InspectionItem,
  OrderDetail,
  OrderLine,
  Settings,
  Totals,
  Vehicle,
} from "../shared/types";

/** Immutable, JSON-serializable input saved alongside each generated PDF. */
export interface DocumentSnapshot {
  kind: DocumentKind;
  number: string;
  createdAt: string;
  templateVersion: string;
  settings: Pick<Settings, "name" | "address" | "phone" | "taxId" | "timezone">;
  order: Pick<
    OrderDetail,
    | "number"
    | "openedAt"
    | "mileage"
    | "complaint"
    | "recommendations"
    | "comment"
    | "status"
  >;
  customer: Pick<Customer, "name" | "phone">;
  vehicle: Pick<Vehicle, "make" | "model" | "year" | "vin" | "plate">;
  masterName: string;
  signerName?: string;
  includeRecommendations?: boolean;
  version?: number;
  printedContentHash?: string;
  inspectionItems: Omit<InspectionItem, "catalogItemId">[];
  lines: Pick<
    OrderLine,
    "kind" | "name" | "quantityMilli" | "unitPriceCents" | "variant" | "article" | "partSource" | "approval" | "completed"
  >[];
  totals: Totals;
}
