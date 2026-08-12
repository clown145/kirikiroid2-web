-- 玩家云存档。R2 保存不可变 ZIP，D1 只保存版本关系与对象定位。
-- game_id 不外键到 games：作品下架或后台误删时，玩家历史不能被级联清空。

CREATE TABLE IF NOT EXISTS save_revisions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id           TEXT NOT NULL,
  parent_revision_id TEXT,
  object_key        TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  archive_sha256    TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  file_count        INTEGER NOT NULL,
  device_id         TEXT NOT NULL,
  device_name       TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_save_revisions_user_game_time
  ON save_revisions (user_id, game_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_save_revisions_object
  ON save_revisions (object_key);

CREATE TABLE IF NOT EXISTS save_heads (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES save_revisions(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS save_devices (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,

  PRIMARY KEY (user_id, device_id)
);
