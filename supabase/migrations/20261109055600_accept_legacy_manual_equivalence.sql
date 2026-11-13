-- Existing rivals were deliberately assigned by an operator before this
-- feature. Preserve that decision without requiring a second manual review.
alter table ml.ml_competitor_links
  add column review_source text check (
    review_source in ('manual_review', 'legacy_manual_assignment')
  );

update ml.ml_competitor_links as link
set equivalence = 'accepted',
    review_source = 'legacy_manual_assignment',
    reviewed_at = now(),
    reviewed_by = null,
    updated_at = now()
from ml.ml_competitor_items as rival
where rival.id = link.competitor_item_id
  and link.equivalence = 'pending'
  and link.removed_at is null
  and (
    (link.scope = 'publication' and link.our_product_id = nullif(rival.our_product_id, ''))
    or (link.scope = 'sku' and nullif(rival.our_product_id, '') is null
        and link.our_sku = ml.normalize_monitor_sku(rival.our_sku))
  );
