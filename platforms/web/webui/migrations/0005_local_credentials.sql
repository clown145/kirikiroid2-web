-- 可选的本站登录名与密码。
--
-- 本地凭据只能绑定已经由 Steam/GitHub 创建的 users；没有任何 SQL/API 路径会
-- 仅凭登录名创建 users。password_hash 使用与管理员认证相同的 PBKDF2 格式。

ALTER TABLE users ADD COLUMN local_login_prompted_at INTEGER;

CREATE TABLE IF NOT EXISTS local_credentials (
  user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username             TEXT NOT NULL,
  username_normalized  TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- OAuth 重验证只把随机 token 发给浏览器；D1 和 user_sessions 一样只存 SHA-256。
-- setup/reauth 还绑定发起它的 session；只有 reset 能在未登录状态下消费。
-- grant 本身一次消费、10 分钟过期。
CREATE TABLE IF NOT EXISTS local_auth_grants (
  token_hash         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose            TEXT NOT NULL CHECK (purpose IN ('setup', 'reauth', 'reset')),
  provider           TEXT NOT NULL CHECK (provider IN ('github', 'steam')),
  session_token_hash TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,

  CHECK (
    (purpose = 'reset' AND session_token_hash IS NULL) OR
    (purpose IN ('setup', 'reauth') AND session_token_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_local_auth_grants_expiry
  ON local_auth_grants (expires_at);

CREATE INDEX IF NOT EXISTS idx_local_auth_grants_user
  ON local_auth_grants (user_id);

-- 本地密码校验的 fixed-window 限速。D1 的 UPSERT 在事务中原子递增；不能用
-- Workers KV 做 get/+1/put，因为 KV 最终一致且同 key 写入有频率限制。
CREATE TABLE IF NOT EXISTS local_auth_rate_limits (
  bucket_key        TEXT PRIMARY KEY,
  attempts          INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_auth_rate_expiry
  ON local_auth_rate_limits (expires_at);
