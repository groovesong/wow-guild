import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

let cache = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000;

app.use(express.static(__dirname));

app.get('/api/guild', async (req, res) => {
  const force = req.query.force === '1';

  if (!force && cache && Date.now() - cacheTime < CACHE_MS) {
    return res.json({ ...cache, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) });
  }

  try {
    const guildUrl = 'https://raider.io/api/v1/guilds/profile?region=kr&realm=azshara&name=%EB%B6%89%20%EC%9D%80%20%EB%82%B4%20%EB%B3%B5%20%EB%8B%A8&fields=members';
    const guildRes = await fetch(guildUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const guildData = await guildRes.json();

    if (guildData.statusCode === 400) return res.status(400).json(guildData);

    const members = guildData.members || [];
    console.log(`길드원 ${members.length}명 아이템 레벨 조회 시작...`);

    const BATCH = 10;
    const results = [];
    for (let i = 0; i < members.length; i += BATCH) {
      const batch = members.slice(i, i + BATCH);
      const fetched = await Promise.all(batch.map(async (m) => {
        try {
          const name = encodeURIComponent(m.character.name);
          const realm = encodeURIComponent(m.character.realm || 'azshara');
          const url = `https://raider.io/api/v1/characters/profile?region=kr&realm=${realm}&name=${name}&fields=gear,mythic_plus_scores_by_season:current`;
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const d = await r.json();
          return {
            ...m,
            character: {
              ...m.character,
              items: { item_level_equipped: d.gear?.item_level_equipped || null },
              mythic_plus_scores_by_season: d.mythic_plus_scores_by_season || m.character.mythic_plus_scores_by_season
            }
          };
        } catch (e) {
          console.log(`${m.character.name} 조회 실패: ${e.message}`);
          return m;
        }
      }));
      results.push(...fetched);
      console.log(`${Math.min(i + BATCH, members.length)} / ${members.length} 완료`);
    }

    const response = { ...guildData, members: results };
    cache = response;
    cacheTime = Date.now();
    res.json({ ...response, cached: false, cacheAge: 0 });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n✅ 서버 실행 중!`);
  console.log(`👉 브라우저에서 열기: http://localhost:${PORT}\n`);
});
