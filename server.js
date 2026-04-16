import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const BNET_ID     = '356a797497114f8ea3ce658e0b8a2975';
const BNET_SECRET = 'db8MTPdmt4usebHinCZhTcAPS13n1P6s';
const API_HOST    = 'kr.api.blizzard.com';   // 문서 확인: kr 리전 호스트
const NAMESPACE   = 'profile-kr';            // 문서 확인: 길드/캐릭터는 profile-kr
const GUILD_REALM = 'azshara';
const GUILD_SLUG  = '붉-은-내-복-단';
const PASSWORD    = '0415';
const CACHE_MS    = 5 * 60 * 1000;

let tokenCache = null, tokenExpiry = 0;
let dataCache = null, dataCacheTime = 0;

app.use(express.static(__dirname));
app.use(express.json());

// 토큰 발급 (US에서 발급해도 전 리전 유효)
async function getToken() {
  if (tokenCache && Date.now() < tokenExpiry) return tokenCache;
  const creds = Buffer.from(`${BNET_ID}:${BNET_SECRET}`).toString('base64');
  const r = await fetch('https://us.battle.net/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`토큰 발급 실패: ${r.status}`);
  const data = await r.json();
  if (!data.access_token) throw new Error('access_token 없음: ' + JSON.stringify(data));
  tokenCache = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('✅ 토큰 발급 완료');
  return tokenCache;
}

// API 호출: kr.api.blizzard.com + profile-kr
async function bnet(path, ns = NAMESPACE) {
  const token = await getToken();
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://${API_HOST}${path}${sep}namespace=${ns}&locale=ko_KR`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` }, signal: ctrl.signal });
    if (!r.ok) { const txt = await r.text(); throw new Error(`${r.status} ${path} — ${txt.slice(0,100)}`); }
    return r.json();
  } finally { clearTimeout(tid); }
}

function getRole(spec) {
  if (!spec) return 'DPS';
  if (['혈기','보호','수호','양조','복수','방어'].some(t => spec.includes(t))) return 'TANK';
  if (['신성','회복','운무','보존','복원','수양'].some(h => spec.includes(h))) return 'HEALING';
  return 'DPS';
}

// 디버그: 토큰
app.get('/api/debug-token', async (req, res) => {
  try {
    const creds = Buffer.from(`${BNET_ID}:${BNET_SECRET}`).toString('base64');
    const r = await fetch('https://us.battle.net/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const txt = await r.text();
    res.json({ status: r.status, body: txt.slice(0,300) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-guild', async (req, res) => {
  try {
    const creds = Buffer.from(`${BNET_ID}:${BNET_SECRET}`).toString('base64');
    const results = {};

    // 각 리전에서 토큰 발급 시도
    for (const host of ['us.battle.net', 'kr.battle.net', 'apac.battle.net', 'eu.battle.net']) {
      const r = await fetch(`https://${host}/oauth/token`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
      });
      const txt = await r.text();
      results[`token_${host}`] = { status: r.status, body: txt.slice(0, 100) };

      // 토큰 발급 성공하면 kr API 테스트
      if (r.ok) {
        const token = JSON.parse(txt).access_token;
        const apiR = await fetch(`https://kr.api.blizzard.com/data/wow/realm/azshara?namespace=dynamic-kr&locale=ko_KR`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const apiTxt = await apiR.text();
        results[`kr_api_with_${host}_token`] = { status: apiR.status, body: apiTxt.slice(0, 200) };
      }
    }

    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 길드 데이터: 블리자드(템렙+쐐기돌) + Raider.io(M+점수) 병합
app.get('/api/guild', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && dataCache && Date.now() - dataCacheTime < CACHE_MS)
    return res.json({ ...dataCache, cached: true, cacheAge: Math.round((Date.now() - dataCacheTime) / 1000) });

  try {
    // 길드 로스터 (문서: /data/wow/guild/{realmSlug}/{nameSlug}/roster, namespace=profile-kr)
    console.log('길드 로스터 조회...');
    const roster = await bnet(`/data/wow/guild/${GUILD_REALM}/${encodeURIComponent(GUILD_SLUG)}/roster`);
    const members = roster.members || [];
    console.log(`멤버 ${members.length}명 조회 시작`);

    const BATCH = 10; // 5 → 10으로 늘림
    const results = [];

    const fetchWithTimeout = (url, opts={}, ms=5000) => {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
    };

    for (let i = 0; i < members.length; i += BATCH) {
      const batch = members.slice(i, i + BATCH);
      const fetched = await Promise.all(batch.map(async (m) => {
        const name = m.character.name;
        const realm = m.character.realm?.slug || GUILD_REALM;
        try {
          // 캐릭터 프로필 + Raider.io 병렬 호출
          const [charRes, rioRes] = await Promise.allSettled([
            bnet(`/profile/wow/character/${realm}/${encodeURIComponent(name)}`),
            fetchWithTimeout(`https://raider.io/api/v1/characters/profile?region=kr&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,gear`, {
              headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 4000).then(r => r.json()).catch(() => null)
          ]);

          const char = charRes.status === 'fulfilled' ? charRes.value : {};
          const rio  = rioRes.status  === 'fulfilled' ? rioRes.value  : null;

          // 신뢰도: 배틀넷 > 레이더 > 직접입력
          const bnetIlvl  = char.equipped_item_level || null;
          const rioIlvl   = rio?.gear?.item_level_equipped || null;
          const bnetScore = null; // 블리자드는 M+ 점수 미제공
          const rioScore  = rio?.mythic_plus_scores_by_season?.[0]?.scores?.all || null;

          // 배틀넷 없으면 레이더로 보완
          const ilvl  = bnetIlvl || rioIlvl || null;
          const score = rioScore || null;

          return {
            name,
            nameLower: name.toLowerCase(),
            class: char.character_class?.name || '',
            spec:  char.active_spec?.name || '',
            role:  getRole(char.active_spec?.name || ''),
            ilvl,
            score,
            rank:  m.rank,
            realm,
          };
        } catch (e) {
          console.log(`${name} 실패: ${e.message}`);
          return null;
        }
      }));
      results.push(...fetched.filter(Boolean));
      console.log(`${Math.min(i + BATCH, members.length)} / ${members.length}`);
    }

    dataCache = { members: results };
    dataCacheTime = Date.now();
    res.json({ ...dataCache, cached: false, cacheAge: 0 });
  } catch (err) {
    console.error('오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 저장 API
const readJ  = f => existsSync(f) ? JSON.parse(readFileSync(f,'utf-8')) : null;
const writeJ = (f,d) => writeFileSync(f, JSON.stringify(d, null, 2));
const checkPw = (pw,res) => { if(pw!==PASSWORD){res.status(401).json({error:'비밀번호 오류'});return false;}return true;};

const DEFAULT_NAMES = ['선호','병환','그루','태정','현명','영선','하정','황휘','혜원','세진','원석','화수','영준'];
function readPlayers() {
  const d = readJ('./players.json') || {};
  return { names: d.names || DEFAULT_NAMES, players: d.players || {}, overrides: d.overrides || {} };
}

app.get('/api/raid',    (req,res) => res.json(readJ('./raid.json')||{slots:null}));
app.post('/api/raid',   (req,res) => {if(!checkPw(req.body.password,res))return;writeJ('./raid.json',{slots:req.body.slots,updatedAt:new Date().toISOString()});res.json({ok:true});});
app.get('/api/players', (req,res) => res.json(readPlayers()));
app.post('/api/players',(req,res) => {
  if(!checkPw(req.body.password,res))return;
  const cur=readPlayers();
  writeJ('./players.json',{
    names: req.body.names ?? cur.names,
    players: req.body.players ?? cur.players,
    overrides: req.body.overrides ?? cur.overrides,
  });
  res.json({ok:true});
});
app.get('/api/manual',  (req,res) => res.json(readJ('./manual.json')||[]));
app.post('/api/manual', (req,res) => {if(!checkPw(req.body.password,res))return;writeJ('./manual.json',req.body.chars);res.json({ok:true});});

// 쐐기돌 수동 입력
app.get('/api/keystones', (req,res) => res.json(readJ('./keystones.json')||[]));
app.post('/api/keystones', (req,res) => {
  const {player,char,dungeon,level}=req.body;
  if(!char||!dungeon||!level)return res.status(400).json({error:'필수 항목 누락'});
  let ks=readJ('./keystones.json')||[];
  ks=ks.filter(k=>k.char!==char);
  ks.push({player,char,dungeon,level:parseInt(level),updatedAt:new Date().toISOString()});
  writeJ('./keystones.json',ks);
  res.json({ok:true});
});
app.delete('/api/keystones/:char', (req,res) => {
  writeJ('./keystones.json',(readJ('./keystones.json')||[]).filter(k=>k.char!==decodeURIComponent(req.params.char)));
  res.json({ok:true});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ 서버 실행 중! http://localhost:${PORT}`);
  console.log(`🔍 토큰 테스트: http://localhost:${PORT}/api/debug-token`);
  console.log(`🔍 길드 테스트: http://localhost:${PORT}/api/debug-guild\n`);
});