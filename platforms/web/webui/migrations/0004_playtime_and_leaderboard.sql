-- 玩家游玩时长与排行榜。
--
-- user_game_playtimes 保存用户在各款游戏上的累计时长、启动频次与起止时间。
-- game_id 不外键约束到 games 表，防止作品下架或调整时误删玩家历史数据。

CREATE TABLE IF NOT EXISTS user_game_playtimes (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id           TEXT NOT NULL,
  total_seconds     INTEGER NOT NULL DEFAULT 0,
  session_count     INTEGER NOT NULL DEFAULT 1,
  first_played_at   INTEGER NOT NULL,
  last_played_at    INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_playtime_game_rank
  ON user_game_playtimes (game_id, total_seconds DESC);

CREATE INDEX IF NOT EXISTS idx_playtime_user
  ON user_game_playtimes (user_id, total_seconds DESC);

-- 玩家隐私配置：hide_playtime=1 时在公开排行榜中匿名或隐藏
ALTER TABLE users ADD COLUMN hide_playtime INTEGER NOT NULL DEFAULT 0;
