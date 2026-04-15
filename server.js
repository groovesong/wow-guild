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

app.get('/api/players', (req, res) => res.json(readJ('./players.json') || {players:{},overrides:{}}));
app.post('/api/players', (req, res) => { if (!checkPw(req.body.password, res)) return; writeJ('./players.json', {players: req.body.players||{}, overrides: req.body.overrides||{}}); res.json({ ok: true }); });

app.get('/api/manual', (req, res) => res.json(readJ('./manual.json') || []));
app.post('/api/manual', (req, res) => { if (!checkPw(req.body.password, res)) return; writeJ('./manual.json', req.body.chars); res.json({ ok: true }); });

// ── 쐐기돌 ──
const KS_FILE = './keystones.json';
const readKS = () => readJ(KS_FILE) || [];
const writeKS = (d) => writeJ(KS_FILE, d);

app.get('/api/keystones', (req, res) => res.json(readKS()));

app.post('/api/keystones', (req, res) => {
  const { player, char, dungeon, level } = req.body;
  if (!char || !dungeon || !level) return res.status(400).json({ error: '필수 항목 누락' });
  let ks = readKS();
  // 같은 캐릭터 기존 항목 교체
  ks = ks.filter(k => k.char !== char);
  ks.push({ player, char, dungeon, level: parseInt(level), updatedAt: new Date().toISOString() });
  writeKS(ks);
  res.json({ ok: true });
});

app.delete('/api/keystones/:char', (req, res) => {
  writeKS(readKS().filter(k => k.char !== decodeURIComponent(req.params.char)));
  res.json({ ok: true });
});


const PARTY_FILE = './parties.json';
const readParties = () => readJ(PARTY_FILE) || [];
const writeParties = (d) => writeJ(PARTY_FILE, d);

app.get('/api/parties', (req, res) => res.json(readParties()));

app.post('/api/parties', (req, res) => {
  const { title, description, author, authorChar, authorCharIlvl, authorSpecs, authorRoles, date, postPassword } = req.body;
  if (!title || !author) return res.status(400).json({ error: '필수 항목 누락' });
  if (!postPassword) return res.status(400).json({ error: '글 비밀번호를 설정해주세요' });
  const parties = readParties();
  const id = Date.now().toString();
  const roles = authorRoles && authorRoles.length ? authorRoles : ['DPS'];
  // 역할별로 분리 (역할 2개면 2개 슬롯)
  const authorSlots = authorChar ? roles.map(role => ({
    player: author, char: authorChar, specs: authorSpecs||[], roles: [role], role, confirmed: true
  })) : [];
  parties.unshift({
    id, title, description, date, author, authorChar, authorCharIlvl: authorCharIlvl||null,
    postPassword, createdAt: new Date().toISOString(), status: 'open',
    confirmed: null, applications: [], comments: [], authorSlots,
  });
  writeParties(parties);
  res.json({ ok: true, id });
});

app.post('/api/parties/:id/apply', (req, res) => {
  const { player, char, specs, roles, role } = req.body;
  if (!player || !char) return res.status(400).json({ error: '필수 항목 누락' });
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없는 글' });
  if (post.status !== 'open') return res.status(400).json({ error: '마감된 모집' });
  const allApplied = [...(post.authorSlots||[]), ...post.applications];
  if (allApplied.find(a => a.player === player)) return res.status(400).json({ error: '이미 신청함' });
  const finalRoles = roles && roles.length ? roles : [role||'DPS'];
  post.applications.push({ player, char, specs: specs||[], roles: finalRoles, role: finalRoles[0], appliedAt: new Date().toISOString() });
  writeParties(parties);
  res.json({ ok: true });
});

app.delete('/api/parties/:id/apply/:player', (req, res) => {
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post || post.status !== 'open') return res.status(400).json({ error: '취소 불가' });
  post.applications = post.applications.filter(a => a.player !== req.params.player);
  writeParties(parties);
  res.json({ ok: true });
});

app.post('/api/parties/:id/confirm', (req, res) => {
  const { password, confirmed } = req.body;
  if (!checkPw(password, res)) return;
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없는 글' });
  post.confirmed = confirmed;
  post.status = 'confirmed';
  writeParties(parties);
  res.json({ ok: true });
});

app.post('/api/parties/:id/reopen', (req, res) => {
  const { password } = req.body;
  if (!checkPw(password, res)) return;
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없는 글' });
  post.status = 'open'; post.confirmed = null;
  writeParties(parties);
  res.json({ ok: true });
});

app.post('/api/parties/:id/comment', (req, res) => {
  const { player, text } = req.body;
  if (!player || !text) return res.status(400).json({ error: '필수 항목 누락' });
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없는 글' });
  post.comments.push({ player, text, createdAt: new Date().toISOString() });
  writeParties(parties);
  res.json({ ok: true });
});

app.delete('/api/parties/:id', (req, res) => {
  const { password, type } = req.body;
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없는 글' });
  if (type === 'author') {
    if (password !== post.postPassword) return res.status(401).json({ error: '비밀번호 오류' });
  } else {
    if (!checkPw(password, res)) return;
  }
  writeParties(parties.filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ http://localhost:${PORT}`));
