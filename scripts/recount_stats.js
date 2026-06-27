#!/usr/bin/env node
/**
 * 瞳瞳音乐 - 播放量/收藏量计数补数脚本（一次性）
 *
 * 用途：根据 play_history 与 favorites 表的真实记录，
 *      重新统计每首歌曲的 play_count / favorite_count，并回写到 songs 表。
 *
 * 场景：上线计数字段前的历史数据补齐，或计数发生漂移后的人工校准。
 *
 * 用法:
 *   node backend/scripts/recount_stats.js
 *
 * 说明：
 *   - 整体在一个事务中提交，中途异常自动回滚，保证数据一致性。
 *   - 输出统计前后的差异明细，便于核对。
 */

const { db } = require('../db');

// 1. 读取统计前的快照（id => { play_count, favorite_count }）
const beforeMap = new Map();
for (const row of db.prepare('SELECT id, play_count, favorite_count FROM songs').all()) {
  beforeMap.set(row.id, { play_count: row.play_count, favorite_count: row.favorite_count });
}

// 2. 按 song_id 分组统计播放历史与收藏
const playStats = db.prepare(
  `SELECT song_id, COUNT(*) AS c FROM play_history GROUP BY song_id`
).all();
const favStats = db.prepare(
  `SELECT song_id, COUNT(*) AS c FROM favorites GROUP BY song_id`
).all();
const playMap = new Map(playStats.map((r) => [r.song_id, r.c]));
const favMap = new Map(favStats.map((r) => [r.song_id, r.c]));

// 3. 预编译更新语句，仅在实际值变化时执行
const updatePlay = db.prepare('UPDATE songs SET play_count = ? WHERE id = ?');
const updateFav = db.prepare('UPDATE songs SET favorite_count = ? WHERE id = ?');

const changed = [];

// 4. 事务包装：整体提交，失败回滚
const txn = db.transaction(() => {
  for (const [id, before] of beforeMap) {
    const newPlay = playMap.get(id) || 0;
    const newFav = favMap.get(id) || 0;
    if (before.play_count !== newPlay) updatePlay.run(newPlay, id);
    if (before.favorite_count !== newFav) updateFav.run(newFav, id);
    if (before.play_count !== newPlay || before.favorite_count !== newFav) {
      changed.push({ id, before, after: { play_count: newPlay, favorite_count: newFav } });
    }
  }
});

console.log('========== 重新统计 播放量/收藏量 ==========');
console.log(`歌曲总数: ${beforeMap.size}`);
console.log(`播放历史覆盖歌曲数: ${playMap.size}`);
console.log(`收藏覆盖歌曲数: ${favMap.size}`);

txn();

console.log(`\n已变更歌曲数: ${changed.length}`);
console.log('\n差异明细 (id | play: before->after | favorite: before->after):');
for (const c of changed) {
  console.log(
    `  #${c.id} | play: ${c.before.play_count} -> ${c.after.play_count} | favorite: ${c.before.favorite_count} -> ${c.after.favorite_count}`
  );
}
console.log('\n统计完成。');
