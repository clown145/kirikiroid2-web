-- 玩家账号。管理员后台认证仍由 Secret + 独立 cookie 负责，不进入这些表。
--
-- users.id 是云存档等用户数据的唯一归属键；Steam/GitHub 只是可替换、可绑定的
-- 登录来源，绝不能把平台用户名或邮箱直接当用户主键。

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_identities (
  provider         TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_login   TEXT,
  display_name     TEXT,
  avatar_url       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  PRIMARY KEY (provider, provider_subject),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user
  ON auth_identities (user_id);

-- 随机 session token 只下发给浏览器；D1 只存 SHA-256，数据库泄漏后不能直接冒用。
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry
  ON user_sessions (expires_at);
