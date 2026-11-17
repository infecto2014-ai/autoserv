# Контракт API для параллельной разработки

Все даты ISO UTC. Успех — JSON непосредственно (без data). Ошибка `{error:string}`; 401 нет сессии, 403 права, 409 версия/уникальность, 422 валидация. Все mutation требуют same-origin `Origin`. Browser fetch добавляет его автоматически. Cookie httpOnly. `fetch` с `credentials:'same-origin'`. Пагинация GET ?q=&page=1&pageSize=25 (max100), ответ `{items:[],total,page,pageSize}`. Денежные поля — целые копейки; quantityMilli — количество ×1000. UI принимает рубли строкой и конвертирует через src/lib/money.ts.

## Доступ
- GET /api/auth/session → `{user:{id,name,email,role}|null}`
- POST /api/auth/login `{email,password}` → `{user}`
- POST /api/auth/logout `{}` → `{ok:true}`

## Справочные данные
- GET/POST /api/customers. POST `{kind:'PERSON'|'COMPANY',name,phone,email?,comment?}` → Customer.
- PATCH /api/customers/:id `{name?,phone?,email?,comment?,archived?:boolean}`.
- GET/POST /api/vehicles. POST `{customerId,make,model,year?,vin?,plate?,mileage,engine?,comment?}`.
- PATCH /api/vehicles/:id частичные поля (включая customerId, archived).
- GET /api/vehicles/:id → Vehicle + customer + orders (только доступные роли), ownerships.
- GET /api/staff → `{items:[{id,name,email,role,active}]}`; POST admin `{name,email,password,role}`; PATCH /api/staff/:id `{name?,role?,active?,password?}`.
- GET /api/catalog → `{items:CatalogItem[]}`; POST admin `{category,name,unit?,laborPriceCents?,sortOrder?}`; PATCH /api/catalog/:id частичные поля + active.
- GET /api/settings → `{id,name,address,phone,taxId,timezone}`; PATCH admin те же поля без id.
MASTER видит только клиентов/авто назначенных заказов, не создаёт/не меняет их, GET staff отдаёт только active MASTER (для других ролей все staff без паролей). Справочник GET доступен всем.

## Заказы
- GET /api/orders ?q=&status=&page= → page of WorkOrder с customer, vehicle, master, totals.
- POST /api/orders `{vehicleId,masterId?:string|null,mileage,complaint}` → OrderDetail.
- GET /api/orders/:id → OrderDetail.
- PATCH /api/orders/:id `{version:number,status?,masterId?,complaint?,comment?,recommendations?,discountCents?,paidCents?}` → OrderDetail.
- PUT /api/orders/:id/inspection `{version:number,recommendations?:string,items:[{id,catalogItemId?,category,name,left,right,condition,quantityMilli,laborPriceCents,originalPriceCents,analogPriceCents,customPriceCents,selectedPart,note}]}` → OrderDetail. Все поля позиции можно присылать из GET; лишние authorId/orderId/updatedAt автоматически отбрасываются. MASTER может править только состояние/L/R/заметку/рекомендации, запрет денег и наименований/количества на сервере. При открытии заказа осмотр заполняется копиями всех active catalog.
- POST /api/orders/:id/transfer `{version,inspectionItemIds:string[]}` → OrderDetail; идемпотентный upsert LABOR и PART (только выбранный вариант).
- PUT /api/orders/:id/lines `{version,lines:[{id?:string,kind:'LABOR'|'PART',name,quantityMilli,unitPriceCents,variant?:'NONE'|'ORIGINAL'|'ANALOG'|'CUSTOM',article?:string}]}` → OrderDetail; полная замена вручную редактируемых строк, сохранение привязок переноса по id.
- GET /api/orders/export → CSV, только ADMIN/RECEPTION.

OrderDetail = WorkOrder поля + `customer:Customer, vehicle:Vehicle, master:{id,name}|null, inspectionItems:InspectionItem[], lines:OrderLine[], documents:[{id,number,kind,version,createdAt,sha256}], totals:{laborCents,partsCents,subtotalCents,discountCents,totalCents,paidCents,balanceCents}`.
Переходы NEW→DIAGNOSTICS→APPROVAL→IN_PROGRESS→READY→DELIVERED; CANCELLED из любого кроме DELIVERED/CANCELLED. MASTER только назначенные заказы; может DIAGNOSTICS/APPROVAL/IN_PROGRESS/READY, остальные переходы ADMIN/RECEPTION. Выданные и отменённые неизменяемы.

## Документы
- POST /api/orders/:id/documents `{kind:'INSPECTION'|'WORK_ORDER',version:number}` → `{id,number,kind,version,createdAt,sha256}`; ADMIN/RECEPTION.
- GET /api/documents/:id → сохранённый PDF (inline, `?download=1` attachment); доступ по заказу.

Функции shared server: src/server/db.ts `db`; src/server/http.ts `withApi(handler), json(value,status?), fail(status,message), requireRole(actor,...roles)`, `Actor={id,name,email,role}`; handler `(request,context,actor)`, context.params promise Record. src/server/access.ts `orderScope(actor), customerScope(actor), vehicleScope(actor)`.
