/* ============================================================
 *  软件资料库 · Supabase 连接配置
 *
 *  把下面两个值换成你在 Supabase 控制台拿到的：
 *    Settings → API → Project URL        填到 url
 *    Settings → API → anon public key    填到 anonKey
 *
 *  anon key 是公开密钥（数据安全靠数据库 RLS 策略），
 *  放在网页代码里是 Supabase 的标准做法，不用担心。
 *  但 service_role key 绝对不能放进来！
 * ============================================================ */
window.SOFTWARE_VAULT_CONFIG = {
  url: "YOUR_SUPABASE_URL",
  anonKey: "YOUR_SUPABASE_ANON_KEY",
};
