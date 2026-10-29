-- Migration: billing_checkout
-- The account function creates Stripe Checkout Sessions as the signed-in user, so it needs to read the price for a
-- plan. Prices are public information (they are on the pricing page); nothing else about billing becomes readable.
grant select on public.price_plans to authenticated;
create policy read_active on public.price_plans for select to authenticated using (active);
