-- ============================================================
-- 软件资料库 · 安装包上传功能初始化 SQL（第二次运行）
--
-- 用法：Supabase 控制台 → SQL Editor → New query
--       → 粘贴本文件全部内容 → Run
-- 作用：①给软件表加"安装包"字段  ②创建私有存储桶  ③配好安全规则
-- ============================================================

-- 1. 软件表加 file_path 字段 -----------------------------------
alter table public.software
  add column if not exists file_path text not null default '';

-- 2. 创建私有存储桶（单文件上限 500MB）------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('software-files', 'software-files', false, 524288000)
on conflict (id) do update set file_size_limit = 524288000;

-- 3. 存储桶安全规则：每个账号只能动自己名下文件夹内的文件 -----
drop policy if exists "sf_owner_read" on storage.objects;
create policy "sf_owner_read"
  on storage.objects for select
  using (bucket_id = 'software-files'
         and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "sf_owner_insert" on storage.objects;
create policy "sf_owner_insert"
  on storage.objects for insert
  with check (bucket_id = 'software-files'
              and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "sf_owner_update" on storage.objects;
create policy "sf_owner_update"
  on storage.objects for update
  using (bucket_id = 'software-files'
         and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "sf_owner_delete" on storage.objects;
create policy "sf_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'software-files'
         and auth.uid()::text = (storage.foldername(name))[1]);
