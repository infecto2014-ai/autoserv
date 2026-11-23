import type {OrderDetail, Settings} from '../shared/types';
import type {DocumentSnapshot} from './document-types';

export const completionTemplate = 'completion-act-1.0';

export function customerAndVehicle(order: OrderDetail) {
  const {name, phone} = order.customer;
  const {make, model, year, vin, plate} = order.vehicle;
  return {customer:{name, phone}, vehicle:{make, model, year, vin, plate}, masterName:order.master?.name ?? ''};
}

export function serviceDetails({name,address,phone,taxId,timezone}: Settings) {
  return {name,address,phone,taxId,timezone};
}

export function completionContent(order: OrderDetail, settings: Settings, includeRecommendations: boolean) {
  const {number,openedAt,complaint,mileage,comment,status} = order;
  const deferred = order.lines.filter(line => line.approval === 'DEFERRED').map(line => line.name);
  const recommendations = includeRecommendations
    ? [order.recommendations, ...new Set(deferred)].filter(Boolean).join('\n') : '';
  const lines = order.lines.filter(line => line.approval === 'APPROVED' && line.completed)
    .map(({kind,name,quantityMilli,unitPriceCents,variant,article,partSource,approval,completed}) =>
      ({kind,name,quantityMilli,unitPriceCents,variant,article,partSource,approval,completed}));
  return {settings:serviceDetails(settings), ...customerAndVehicle(order), includeRecommendations,
    order:{number,openedAt,complaint,mileage,comment,status,recommendations}, lines};
}

// Payments and signer concern a particular printing. Neither requires a replacement act.
type ActContent = Pick<DocumentSnapshot,
  'settings' | 'customer' | 'vehicle' | 'masterName' | 'includeRecommendations' | 'order' | 'lines'>;

export async function completionContentHash(content: ActContent, discountCents: number) {
  const {settings,customer,vehicle,masterName,includeRecommendations,order,lines} = content;
  const labor = lines.filter(line => line.kind === 'LABOR').map(({name,quantityMilli,unitPriceCents}) =>
    [name,quantityMilli,unitPriceCents]);
  const parts = lines.filter(line => line.kind === 'PART').map(({name,quantityMilli,partSource,unitPriceCents,variant,article}) =>
    [name,quantityMilli,partSource === 'CUSTOMER' ? null : unitPriceCents,variant,article]);
  const bytes = new TextEncoder().encode(JSON.stringify([settings,customer,vehicle,masterName,includeRecommendations,order,labor,parts,discountCents]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
}

export function unresolvedLine(order: OrderDetail) {
  return order.lines.find(line => line.approval === 'PENDING' || (line.approval === 'APPROVED' && !line.completed));
}
