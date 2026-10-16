-- ============================================================
-- 软件资料库 · Supabase 初始化 SQL
--
-- 用法：Supabase 控制台 → 左侧 SQL Editor → New query
--       → 粘贴本文件全部内容 → Run
-- 只需运行一次。
-- ============================================================

-- 1. 数据表 ---------------------------------------------------
create table if not exists public.software (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid()
               references auth.users (id) on delete cascade,
  name         text not null,
  category     text not null default '',
  version      text not null default '',
  license_key  text not null default '',
  download_url text not null default '',
  homepage     text not null default '',
  notes        text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2. 行级安全：每个账号只能读写自己的数据 ---------------------
alter table public.software enable row level security;

drop policy if exists "software_owner_all" on public.software;
create policy "software_owner_all"
  on public.software
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. updated_at 自动刷新 --------------------------------------
create or replace function public.touch_updated_at ()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists software_touch_updated_at on public.software;
create trigger software_touch_updated_at
  before update on public.software
  for each row
  execute function public.touch_updated_at ();

-- 4. 打开实时同步（手机 / 电脑改动即时互推）-------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'software'
  ) then
    alter publication supabase_realtime add table public.software;
  end if;
end $$;
