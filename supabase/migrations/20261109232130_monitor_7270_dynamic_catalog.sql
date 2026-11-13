-- User decision: SKU 7270 follows the catalog minimum, without pinning a seller.
-- Do not create a fixed rival or alter historical seller/price snapshots.
update ml.ml_monitor_repairs
set status='resolved',last_error=null,updated_at=now(),
 evidence=evidence||jsonb_build_object(
   'resolutionStrategy','dynamic_catalog_only',
   'decision','User requested the cheapest current catalog offer instead of a fixed seller publication',
   'catalogId','MLU2081534097','fixedItemCreated',false)
where key='legacy-fixed:7270:255754420' and status='pending';
