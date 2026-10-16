/* 软件资料库 - 主逻辑（Supabase 云同步） */
'use strict';

/* ---------- 配置 ---------- */
const cfg = window.SOFTWARE_VAULT_CONFIG || {};
const CONFIGURED = !!(
  cfg.url && cfg.anonKey &&
  !/YOUR_|此处|替换/i.test(cfg.url + cfg.anonKey)
);

let sb = null;            // Supabase 客户端
let currentUser = null;   // 当前登录用户
let items = [];           // 软件记录
let editingId = null;     // 正在编辑的记录 id
let editingFilePath = null; // 正在编辑的记录已有的安装包路径
let signupMode = false;   // 登录页当前模式
let realtimeChannel = null;
const revealedLicenses = new Set(); // 卡片上已点开明文的序列号

const $ = (s) => document.querySelector(s);
const show = (s) => { $(s).hidden = false; };
const hide = (s) => { $(s).hidden = true; };

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindStaticEvents();
  if (!CONFIGURED) {
    show('#setup-notice');
    return;
  }
  sb = supabase.createClient(cfg.url, cfg.anonKey);
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) enterApp(session.user);
    else showAuth();
    sb.auth.onAuthStateChange((event, session2) => {
      if (event === 'SIGNED_IN' && session2 && session2.user && !currentUser) enterApp(session2.user);
      if (event === 'SIGNED_OUT') { currentUser = null; showAuth(); }
    });
  } catch (e) {
    showAuth();
    toast('Supabase 连接失败，请检查 config.js 里的地址是否正确', true, 6000);
  }
}

function showAuth() {
  hide('#app-view');
  show('#auth-view');
}

function enterApp(user) {
  currentUser = user;
  hide('#auth-view');
  hide('#setup-notice');
  show('#app-view');
  $('#user-email').textContent = user.email || '';
  loadItems();
  subscribeRealtime();
}

/* ---------- 登录 / 注册 ---------- */
function bindStaticEvents() {
  $('#auth-form').addEventListener('submit', handleAuth);
  // 事件委托：#auth-switch 常驻，内部链接重建后依然有效
  $('#auth-switch').addEventListener('click', (e) => {
    if (e.target.id !== 'auth-toggle') return;
    e.preventDefault();
    signupMode = !signupMode;
    $('#auth-submit').textContent = signupMode ? '注册' : '登录';
    $('#auth-switch').innerHTML = signupMode
      ? '已有账号？<a href="#" id="auth-toggle">去登录</a>'
      : '还没有账号？<a href="#" id="auth-toggle">注册一个</a>';
    $('#auth-password').setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  });
  $('#logout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    showAuth();
  });
  $('#search').addEventListener('input', render);
  $('#category-filter').addEventListener('change', render);
  $('#add-btn').addEventListener('click', () => openModal(null));
  $('#export-btn').addEventListener('click', exportCsv);
  $('#modal-close').addEventListener('click', closeModal);
  $('#cancel-btn').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) closeModal();
  });
  $('#item-form').addEventListener('submit', saveItem);
  $('#list').addEventListener('click', handleListClick);
}

function setAuthLoading(on) {
  const btn = $('#auth-submit');
  btn.disabled = on;
  btn.textContent = on ? '请稍候…' : (signupMode ? '注册' : '登录');
}

async function handleAuth(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!email || !password) return;
  setAuthLoading(true);
  try {
    if (signupMode) {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) {
        toast(authErrMsg(error), true, 6000);
      } else if (data.session) {
        toast('注册成功，已自动登录');
      } else {
        toast('注册成功。若无法登录，请到 Supabase 后台 Authentication → Sign In / Providers 关闭「Confirm email」', true, 8000);
        signupMode = false;
        $('#auth-submit').textContent = '登录';
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) toast(authErrMsg(error), true, 6000);
    }
  } catch (err) {
    toast('网络错误：' + err.message, true, 6000);
  } finally {
    setAuthLoading(false);
  }
}

function authErrMsg(error) {
  const m = (error.message || '').toLowerCase();
  if (m.includes('invalid login credentials')) return '邮箱或密码错误';
  if (m.includes('already registered')) return '该邮箱已注册过，请直接登录';
  if (m.includes('not confirmed')) return '邮箱未验证：可到 Supabase 后台关闭「Confirm email」，或去邮箱点确认链接';
  if (m.includes('at least 6')) return '密码至少 6 位';
  if (m.includes('rate limit')) return '操作太频繁，请一分钟后再试';
  if (m.includes('failed to fetch') || m.includes('network')) return '连不上 Supabase，请检查网络或 config.js 地址';
  return error.message || '未知错误';
}

/* ---------- 数据加载 ---------- */
async function loadItems() {
  const { data, error } = await sb.from('software').select('*').order('updated_at', { ascending: false });
  if (error) {
    if (/relation|does not exist|schema cache/i.test(error.message)) {
      $('#list').innerHTML =
        '<div class="empty"><div class="big">🛠️</div>数据表还没建好：<br>请到 Supabase 控制台 SQL Editor，运行项目里的 <b>supabase-setup.sql</b>，然后刷新本页。</div>';
    } else {
      toast('加载失败：' + error.message, true, 5000);
    }
    items = [];
    render();
    return;
  }
  items = data || [];
  render();
}

/* ---------- 实时同步 ---------- */
function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb
    .channel('software-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'software' }, () => {
      // 任何设备（手机 / 电脑）改动 → 自动刷新
      loadItems();
    })
    .subscribe((status) => {
      const dot = $('#live-dot');
      const text = $('#live-text');
      if (status === 'SUBSCRIBED') {
        dot.classList.add('on');
        text.textContent = '实时同步中';
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        dot.classList.remove('on');
        text.textContent = '同步重连中…';
      }
    });
}

/* 渲染前重连兜底：切回页面时拉一次最新数据 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser && sb) loadItems();
});

/* ---------- 渲染 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render() {
  const q = ($('#search').value || '').trim().toLowerCase();
  const cat = $('#category-filter').value;

  // 重建分类下拉
  const cats = [...new Set(items.map((x) => x.category).filter(Boolean))].sort();
  const sel = $('#category-filter');
  const keep = sel.value;
  sel.innerHTML = '<option value="">全部分类</option>' +
    cats.map((c) => `<option value="${esc(c)}"${c === keep ? ' selected' : ''}>${esc(c)}</option>`).join('');

  let list = items;
  if (cat) list = list.filter((x) => x.category === cat);
  if (q) {
    list = list.filter((x) =>
      [x.name, x.version, x.license_key, x.notes, x.category]
        .some((v) => (v || '').toLowerCase().includes(q))
    );
  }

  $('#count-line').textContent =
    `共 ${items.length} 条记录${cat ? ` · 分类「${cat}」${list.length} 条` : ''}${q ? ` · 搜索到 ${list.length} 条` : ''}`;

  const listEl = $('#list');
  if (!list.length) {
    listEl.innerHTML = items.length
      ? '<div class="empty"><div class="big">🔍</div>没有匹配的记录</div>'
      : '<div class="empty"><div class="big">📦</div>还没有记录<br>点右上「＋ 添加软件」开始建档</div>';
    return;
  }

  listEl.innerHTML = list.map((x) => cardHtml(x)).join('');
}

function cardHtml(x) {
  const name = esc(x.name);
  const initial = name.replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '📦';
  const rows = [];

  if (x.version) rows.push(`<div class="meta-row"><span>版本</span><b>${esc(x.version)}</b></div>`);

  if (x.license_key) {
    const id = x.id;
    const open = revealedLicenses.has(id);
    const masked = x.license_key.length > 10
      ? x.license_key.slice(0, 4) + '••••••' + x.license_key.slice(-2)
      : '••••••';
    rows.push(
      `<div class="meta-row"><span>序列号</span>` +
      `<b class="license-val">${esc(open ? x.license_key : masked)}</b>` +
      `<button class="mini-btn" data-act="toggle-license" data-id="${id}">${open ? '隐藏' : '显示'}</button>` +
      `<button class="mini-btn" data-act="copy" data-id="${id}">复制</button></div>`
    );
  }
  if (x.download_url) rows.push(`<div class="meta-row"><span>下载</span><a href="${esc(x.download_url)}" target="_blank" rel="noopener">${esc(x.download_url)}</a></div>`);
  if (x.homepage) rows.push(`<div class="meta-row"><span>官网</span><a href="${esc(x.homepage)}" target="_blank" rel="noopener">${esc(x.homepage)}</a></div>`);
  if (x.file_path) rows.push(`<div class="meta-row"><span>安装包</span><button class="mini-btn" data-act="download" data-id="${id}">⬇ 下载</button></div>`);

  const time = (x.updated_at || '').slice(0, 16).replace('T', ' ');
  return (
    `<div class="card" data-id="${x.id}">
      <div class="card-top">
        <div class="avatar">${esc(initial)}</div>
        <div class="card-name">${name}</div>
        ${x.category ? `<span class="badge">${esc(x.category)}</span>` : ''}
      </div>
      ${rows.length ? `<div class="card-meta">${rows.join('')}</div>` : ''}
      ${x.notes ? `<div class="card-notes">${esc(x.notes)}</div>` : ''}
      <div class="card-foot">
        <span class="time">更新于 ${esc(time)}</span>
        <button class="btn small ghost" data-act="edit">编辑</button>
        <button class="btn small ghost danger-ghost" data-act="del">删除</button>
      </div>
    </div>`
  );
}

/* 列表点击（事件委托：复制 / 显示序列号 / 编辑 / 删除） */
function handleListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  const id = card && card.dataset.id;
  const item = items.find((x) => x.id === id);
  if (!item) return;

  switch (btn.dataset.act) {
    case 'toggle-license':
      revealedLicenses.has(id) ? revealedLicenses.delete(id) : revealedLicenses.add(id);
      render();
      break;
    case 'copy':
      copyText(item.license_key || '');
      break;
    case 'download':
      downloadPackage(item);
      break;
    case 'edit':
      openModal(item);
      break;
    case 'del':
      deleteItem(id, item.name);
      break;
  }
}

/* ---------- 新增 / 编辑 ---------- */
function openModal(item) {
  editingId = item ? item.id : null;
  editingFilePath = item ? item.file_path || '' : '';
  $('#modal-title').textContent = item ? '编辑软件' : '添加软件';
  $('#f-name').value = item ? item.name : '';
  $('#f-category').value = item ? item.category || '' : '';
  $('#f-version').value = item ? item.version || '' : '';
  $('#f-license').value = item ? item.license_key || '' : '';
  $('#f-download').value = item ? item.download_url || '' : '';
  $('#f-homepage').value = item ? item.homepage || '' : '';
  $('#f-notes').value = item ? item.notes || '' : '';
  $('#f-file').value = '';
  show('#modal-backdrop');
  setTimeout(() => $('#f-name').focus(), 50);
}

function closeModal() {
  hide('#modal-backdrop');
  editingId = null;
}

async function saveItem(e) {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  if (!name) return;

  const payload = {
    name,
    category: $('#f-category').value.trim(),
    version: $('#f-version').value.trim(),
    license_key: $('#f-license').value.trim(),
    download_url: $('#f-download').value.trim(),
    homepage: $('#f-homepage').value.trim(),
    notes: $('#f-notes').value.trim(),
  };

  const btn = $('#save-btn');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    // 有选安装包文件 → 先传云端
    const fileInput = $('#f-file');
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      if (file.size > 500 * 1024 * 1024) {
        toast('文件超过 500MB 上限，请压缩后再传', true, 5000);
        return;
      }
      const safeName = file.name.replace(/[\\/:*?"<>|]+/g, '_');
      const path = currentUser.id + '/' + Date.now() + '_' + safeName;
      const { error: upErr } = await sb.storage.from('software-files').upload(path, file, {
        cacheControl: '3600',
        upsert: false,
      });
      if (upErr) {
        toast('安装包上传失败：' + upErr.message, true, 6000);
        return;
      }
      payload.file_path = path;
      // 编辑时换新包 → 顺手删旧包
      if (editingId && editingFilePath) {
        sb.storage.from('software-files').remove([editingFilePath]);
      }
    }

    const { error } = editingId
      ? await sb.from('software').update(payload).eq('id', editingId)
      : await sb.from('software').insert(payload);
    if (error) {
      toast('保存失败：' + error.message, true, 5000);
    } else {
      closeModal();
      await loadItems();
      toast('已保存 ✓');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function deleteItem(id, name) {
  if (!confirm(`确定删除「${name}」？删除后无法恢复。`)) return;
  const { error } = await sb.from('software').delete().eq('id', id);
  if (error) { toast('删除失败：' + error.message, true, 5000); return; }
  // 顺手清掉云端安装包（尽力而为，失败不影响）
  const item = items.find((x) => x.id === id);
  if (item && item.file_path) {
    sb.storage.from('software-files').remove([item.file_path]);
  }
  await loadItems();
  toast('已删除');
}

async function downloadPackage(item) {
  if (!item.file_path) return;
  toast('正在生成下载链接…');
  const { data, error } = await sb.storage
    .from('software-files')
    .createSignedUrl(item.file_path, 3600);
  if (error || !data || !data.signedUrl) {
    toast('获取下载链接失败：' + (error && error.message || '未知错误'), true, 5000);
    return;
  }
  window.open(data.signedUrl, '_blank');
}

/* ---------- 工具 ---------- */
async function copyText(t) {
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch { toast('复制失败，请手动选择复制', true); }
    ta.remove();
  }
}

function exportCsv() {
  if (!items.length) return toast('还没有数据可导出', true);
  const head = ['软件名称', '分类', '版本', '序列号', '下载链接', '官网', '备注', '更新时间'];
  const escCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [head.map(escCell).join(',')].concat(
    items.map((x) => [x.name, x.category, x.version, x.license_key, x.download_url, x.homepage, x.notes, x.updated_at]
      .map(escCell).join(','))
  );
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `软件资料库备份_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, isErr = false, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isErr);
  show('#toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide('#toast'), ms);
}
