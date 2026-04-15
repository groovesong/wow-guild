import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const CACHE_MS = 5 * 60 * 1000;
const PASSWORD = '0415';
let cache = null, cacheTime = 0;

app.use(express.static(__dirname));
app.use(express.json());

app.get('/api/guild', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && cache && Date.now() - cacheTime < CACHE_MS)
    return res.json({ ...cache, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) });
  try {
    const guildRes = await fetch('https://raider.io/api/v1/guilds/profile?region=kr&realm=azshara&name=%EB%B6%89%20%EC%9D%80%20%EB%82%B4%20%EB%B3%B5%20%EB%8B%A8&fields=members', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const guildData = await guildRes.json();
    if (guildData.statusCode === 400) return res.status(400).json(guildData);
    const members = guildData.members || [];
    console.log(`길드원 ${members.length}명 조회 시작...`);
    const BATCH = 10; const results = [];
    for (let i = 0; i < members.length; i += BATCH) {
      const fetched = await Promise.all(members.slice(i, i + BATCH).map(async m => {
        try {
          const name = encodeURIComponent(m.character.name);
          const realm = encodeURIComponent(m.character.realm || 'azshara');
          const d = await (await fetch(`https://raider.io/api/v1/characters/profile?region=kr&realm=${realm}&name=${name}&fields=gear,mythic_plus_scores_by_season:current`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
          return { ...m, character: { ...m.character, items: { item_level_equipped: d.gear?.item_level_equipped || null }, mythic_plus_scores_by_season: d.mythic_plus_scores_by_season || m.character.mythic_plus_scores_by_season } };
        } catch { return m; }
      }));
      results.push(...fetched);
      console.log(`${Math.min(i + BATCH, members.length)} / ${members.length} 완료`);
    }
    cache = { ...guildData, members: results }; cacheTime = Date.now();
    res.json({ ...cache, cached: false, cacheAge: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const readJ = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
const writeJ = (f, d) => writeFileSync(f, JSON.stringify(d));
const checkPw = (pw, res) => { if (pw !== PASSWORD) { res.status(401).json({ error: '비밀번호 오류' }); return false; } return true; };

app.get('/api/raid', (req, res) => res.json(readJ('./raid.json') || { slots: null }));
app.post('/api/raid', (req, res) => { if (!checkPw(req.body.password, res)) return; writeJ('./raid.json', { slots: req.body.slots, updatedAt: new Date().toISOString() }); res.json({ ok: true }); });

app.get('/api/players', (req, res) => res.json(readJ('./players.json') || {}));
app.post('/api/players', (req, res) => { if (!checkPw(req.body.password, res)) return; writeJ('./players.json', req.body.players); res.json({ ok: true }); });

app.get('/api/manual', (req, res) => res.json(readJ('./manual.json') || []));
app.post('/api/manual', (req, res) => { if (!checkPw(req.body.password, res)) return; writeJ('./manual.json', req.body.chars); res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ http://localhost:${PORT}`));
