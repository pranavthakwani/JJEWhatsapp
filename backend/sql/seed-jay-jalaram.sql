-- Run this after schema.sql
-- This uses the same access token pattern you already have in the existing app.
-- Replace the access token only if you want to use a different one.

insert into public.wa_business_accounts (
  waba_id,
  name,
  status
)
values (
  '720243854208169',
  'Jay Jalaram Enterprise',
  'active'
)
on conflict (waba_id) do update
set
  name = excluded.name,
  status = excluded.status,
  updated_at = now();

insert into public.wa_phone_numbers (
  business_account_id,
  display_name,
  phone_number,
  phone_number_id,
  access_token,
  verify_token,
  api_version,
  is_default,
  status
)
select
  ba.id,
  'Jay Jalaram Enterprise',
  '917946007361',
  '1141878885655969',
  'EAAOcsZChcnxwBO2eXsjNPCYr1TtmuqijYWXwaOXo2jg12mocVO5jGtZBGWyoGmG9Hm16u2jNDvZBzjYPLeL2wNU2Y9RuYg5knsGZCqiZARXMlMmZAMn4FqYSzWqcMQHQE2sJL58TUF8YZCD35HVAoVAb2nPG8RFwzFOtMLb7LXRMw5XeBQlZBZBWeoyZC0xIVZAWXtBTwZDZD',
  'jjewa_verify_2026',
  'v22.0',
  true,
  'active'
from public.wa_business_accounts ba
where ba.waba_id = '720243854208169'
on conflict (phone_number_id) do update
set
  business_account_id = excluded.business_account_id,
  display_name = excluded.display_name,
  phone_number = excluded.phone_number,
  access_token = excluded.access_token,
  verify_token = excluded.verify_token,
  api_version = excluded.api_version,
  is_default = excluded.is_default,
  status = excluded.status,
  updated_at = now();
