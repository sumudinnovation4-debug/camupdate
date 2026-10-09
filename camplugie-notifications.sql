-- =====================================================================
-- Camplugie — notifications + device push  (run ONCE in Supabase SQL editor)
-- Safe to re-run. Before running, change the two values in section 6.
-- Every trigger swallows its own errors, so a notification problem can
-- NEVER block a like, comment, order, etc. from saving.
-- =====================================================================

-- 1. TABLES ------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type text not null default 'system',
  title text, body text,
  is_read boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_created on public.notifications (user_id, created_at desc);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null, auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subscriptions (user_id);

alter table public.profiles
  add column if not exists push_enabled boolean,
  add column if not exists notify_messages boolean,
  add column if not exists notify_orders boolean,
  add column if not exists notify_yard boolean;

-- 2. RLS ---------------------------------------------------------------
alter table public.notifications enable row level security;
drop policy if exists notif_select_own on public.notifications;
create policy notif_select_own on public.notifications for select using (auth.uid() = user_id);
drop policy if exists notif_update_own on public.notifications;
create policy notif_update_own on public.notifications for update using (auth.uid() = user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists pushsub_all_own on public.push_subscriptions;
create policy pushsub_all_own on public.push_subscriptions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- live updates for the Activity tab
do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when others then null; end $$;

-- 3. HELPERS -----------------------------------------------------------
create or replace function public.cp_name(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name,''), nullif(username,''), 'Someone') from public.profiles where id = uid
$$;

-- skip = same actor+type+target already notified in the last N minutes (stops like/unlike spam)
create or replace function public.cp_notify(
  p_user uuid, p_type text, p_title text, p_body text, p_data jsonb,
  p_actor uuid default null, p_dedupe_minutes int default 0
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = p_actor then return; end if;
  if p_actor is not null and exists (select 1 from public.user_blocks where blocker_id = p_user and blocked_id = p_actor) then return; end if;
  if p_dedupe_minutes > 0 and exists (
    select 1 from public.notifications
    where user_id = p_user and type = p_type
      and data = coalesce(p_data,'{}'::jsonb)
      and created_at > now() - make_interval(mins => p_dedupe_minutes)
  ) then return; end if;
  insert into public.notifications(user_id, type, title, body, data)
  values (p_user, p_type, p_title, p_body, coalesce(p_data,'{}'::jsonb));
exception when others then
  raise warning 'cp_notify failed: %', sqlerrm;
end $$;

-- 4. TRIGGERS ----------------------------------------------------------
-- 4a. post likes
create or replace function public.tg_post_like() returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  select author_id into owner from public.posts where id = new.post_id;
  perform public.cp_notify(owner, 'like', public.cp_name(new.user_id), 'liked your post ❤️',
    jsonb_build_object('post_id', new.post_id, 'actor_id', new.user_id), new.user_id, 60);
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_post_like on public.post_likes;
create trigger cp_post_like after insert on public.post_likes for each row execute function public.tg_post_like();

-- 4b. post comments
create or replace function public.tg_post_comment() returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  select author_id into owner from public.posts where id = new.post_id;
  perform public.cp_notify(owner, 'comment', public.cp_name(new.author_id),
    'commented: ' || left(coalesce(new.content,''), 120),
    jsonb_build_object('post_id', new.post_id, 'comment_id', new.id, 'actor_id', new.author_id), new.author_id, 0);
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_post_comment on public.post_comments;
create trigger cp_post_comment after insert on public.post_comments for each row execute function public.tg_post_comment();

-- 4c. someone plugged (followed) you
create or replace function public.tg_plug() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.cp_notify(new.plug_id, 'plug', public.cp_name(new.user_id), 'plugged you 🤝',
    jsonb_build_object('profile_id', new.user_id, 'actor_id', new.user_id), new.user_id, 1440);
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_plug on public.plugs;
create trigger cp_plug after insert on public.plugs for each row execute function public.tg_plug();

-- 4d. listing likes + reviews -> seller
create or replace function public.tg_listing_like() returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid; ttl text;
begin
  select seller_id, title into owner, ttl from public.listings where id = new.listing_id;
  perform public.cp_notify(owner, 'like', public.cp_name(new.user_id), 'liked your listing "' || coalesce(ttl,'') || '"',
    jsonb_build_object('listing_id', new.listing_id, 'actor_id', new.user_id), new.user_id, 60);
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_listing_like on public.listing_likes;
create trigger cp_listing_like after insert on public.listing_likes for each row execute function public.tg_listing_like();

create or replace function public.tg_listing_review() returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  select seller_id into owner from public.listings where id = new.listing_id;
  perform public.cp_notify(owner, 'comment', public.cp_name(new.user_id),
    'reviewed your listing ' || repeat('⭐', greatest(coalesce(new.rating,0),0)::int),
    jsonb_build_object('listing_id', new.listing_id, 'actor_id', new.user_id), new.user_id, 60);
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_listing_review on public.listing_reviews;
create trigger cp_listing_review after insert on public.listing_reviews for each row execute function public.tg_listing_review();

-- 4e. added to a group by someone else
create or replace function public.tg_group_member() returns trigger language plpgsql security definer set search_path = public as $$
declare gname text;
begin
  if auth.uid() is not null and auth.uid() <> new.user_id then
    select name into gname from public.groups where id = new.group_id;
    perform public.cp_notify(new.user_id, 'group', 'Added to a group', public.cp_name(auth.uid()) || ' added you to "' || coalesce(gname,'a group') || '"',
      jsonb_build_object('group_id', new.group_id, 'url', '/group-thread.html?id=' || new.group_id), auth.uid(), 0);
  end if;
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_group_member on public.group_members;
create trigger cp_group_member after insert on public.group_members for each row execute function public.tg_group_member();

-- 4f. group call started -> every other member
create or replace function public.tg_group_call() returns trigger language plpgsql security definer set search_path = public as $$
declare gname text; m record; host uuid := nullif(to_jsonb(new)->>'host_id','')::uuid;
begin
  select name into gname from public.groups where id = new.group_id;
  for m in select user_id from public.group_members where group_id = new.group_id and user_id <> host loop
    perform public.cp_notify(m.user_id, 'call', '📞 ' || coalesce(gname,'Group') || ' call',
      public.cp_name(host) || ' started a call — tap to join',
      jsonb_build_object('group_id', new.group_id, 'url', '/group-thread.html?id=' || new.group_id), host, 0);
  end loop;
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_group_call on public.group_calls;
create trigger cp_group_call after insert on public.group_calls for each row execute function public.tg_group_call();

-- 4g. missed call
create or replace function public.tg_call_missed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'missed' then
    perform public.cp_notify(new.callee_id, 'call', 'Missed ' || coalesce(new.type,'voice') || ' call',
      'from ' || public.cp_name(new.caller_id),
      jsonb_build_object('profile_id', new.caller_id, 'actor_id', new.caller_id), new.caller_id, 2); -- 2 min dedupe: both sides log the call
  end if;
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_call_missed on public.call_logs;
create trigger cp_call_missed after insert on public.call_logs for each row execute function public.tg_call_missed();

-- 4h. Swift delivery: new request -> online runners at that campus; status changes -> buyer / runner
create or replace function public.tg_swift_insert() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.runner_id is null then
    for r in select user_id from public.swift_runners
             where coalesce(is_online,false) and user_id <> new.buyer_id
               and (to_jsonb(swift_runners)->>'university_id' is null or (to_jsonb(swift_runners)->>'university_id') = new.university_id::text) loop
      perform public.cp_notify(r.user_id, 'delivery', 'New delivery request 🛵',
        coalesce(new.pickup_place,'Pickup on campus') || ' — open Swift to accept',
        jsonb_build_object('order_id', new.id, 'url', '/swift.html'), new.buyer_id, 0);
    end loop;
  end if;
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_swift_insert on public.swift_orders;
create trigger cp_swift_insert after insert on public.swift_orders for each row execute function public.tg_swift_insert();

create or replace function public.tg_swift_status() returns trigger language plpgsql security definer set search_path = public as $$
declare runner_user uuid; msg text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select coalesce((select user_id from public.swift_runners where id = new.runner_id), new.runner_id) into runner_user;
  msg := case new.status
    when 'accepted'  then 'A runner accepted your delivery 🛵'
    when 'picked_up' then 'Your runner has picked up your order 📦'
    when 'delivered' then 'Your order has been delivered — confirm receipt ✅'
    when 'completed' then 'Delivery completed 🎉'
    else null end;
  if msg is not null then
    perform public.cp_notify(new.buyer_id, 'delivery', 'Swift update', msg,
      jsonb_build_object('order_id', new.id, 'url', '/swift.html'), null, 0);
  end if;
  if new.status = 'completed' and runner_user is not null then
    perform public.cp_notify(runner_user, 'delivery', 'Delivery completed', 'Nice work — your payout is on its way 💰',
      jsonb_build_object('order_id', new.id, 'url', '/swift.html'), null, 0);
  end if;
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_swift_status on public.swift_orders;
create trigger cp_swift_status after update on public.swift_orders for each row execute function public.tg_swift_status();

-- 4i. wallet money in / out
create or replace function public.tg_wallet_tx() returns trigger language plpgsql security definer set search_path = public as $$
declare amt text := to_char((coalesce(new.amount_kobo,0)/100.0), 'FM999,999,990');
begin
  perform public.cp_notify(new.user_id, 'wallet',
    case when new.type in ('withdrawal','withdraw','p2p_send','payment') then 'Wallet debited' else 'Wallet credited' end,
    '₦' || amt || coalesce(' — ' || new.note, ''),
    jsonb_build_object('wallet_tx', new.id, 'url', '/wallet.html'), null, 0);
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_wallet_tx on public.wallet_transactions;
create trigger cp_wallet_tx after insert on public.wallet_transactions for each row execute function public.tg_wallet_tx();

-- 4j. escrow / food order status changes -> the other party
create or replace function public.tg_order_status() returns trigger language plpgsql security definer set search_path = public as $$
declare label text := case tg_table_name when 'food_orders' then 'Food order' else 'Order' end;
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.buyer_id is not null and new.buyer_id is distinct from auth.uid() then
    perform public.cp_notify(new.buyer_id, 'order', label || ' update', label || ' is now ' || replace(new.status,'_',' '),
      jsonb_build_object('order_id', new.id, 'url', '/orders.html'), null, 0);
  end if;
  if new.seller_id is not null and new.seller_id is distinct from auth.uid() then
    perform public.cp_notify(new.seller_id, 'order', label || ' update', label || ' is now ' || replace(new.status,'_',' '),
      jsonb_build_object('order_id', new.id, 'url', '/orders.html'), null, 0);
  end if;
  return new;
exception when others then return new; end $$;
drop trigger if exists cp_escrow_status on public.escrow_orders;
create trigger cp_escrow_status after update on public.escrow_orders for each row execute function public.tg_order_status();
drop trigger if exists cp_food_status on public.food_orders;
create trigger cp_food_status after update on public.food_orders for each row execute function public.tg_order_status();

-- 5. (1:1 chat messages are handled by /api/notify-message, group messages by
--     /api/notify-group-message — both push without spamming the Activity feed.)

-- 6. PUSH WEBHOOK: every new notifications row -> POST /api/send-push -------
--    >>> EDIT THESE TWO VALUES <<<
--    URL    = your live site, e.g. https://camplugie.com/api/send-push
--    SECRET = same string you set as the PUSH_WEBHOOK_SECRET env var in Vercel
do $$ begin
  drop trigger if exists cp_push_webhook on public.notifications;
  create trigger cp_push_webhook after insert on public.notifications
    for each row execute function supabase_functions.http_request(
      'https://camplugie.com/api/send-push', 'POST',
      '{"Content-Type":"application/json","x-webhook-secret":"CHANGE_ME_SAME_AS_PUSH_WEBHOOK_SECRET"}',
      '{}', '5000');
exception when others then
  raise notice 'Could not create webhook trigger (%). Create it in Dashboard -> Database -> Webhooks instead (table notifications, Insert, POST /api/send-push, header x-webhook-secret).', sqlerrm;
end $$;
