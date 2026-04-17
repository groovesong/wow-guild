const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { readFileSync, writeFileSync, existsSync } = require('fs');
const path = require('path');
const app = express();

const BNET_ID     = '356a797497114f8ea3ce658e0b8a2975';
const BNET_SECRET = 'db8MTPdmt4usebHinCZhTcAPS13n1P6s';
const API_HOST    = 'kr.api.blizzard.com';   // 문서 확인: kr 리전 호스트
const NAMESPACE   = 'profile-kr';            // 문서 확인: 길드/캐릭터는 profile-kr
const GUILD_REALM = 'azshara';
const GUILD_SLUG  = '붉-은-내-복-단';

const fetchWithTimeout = (url, opts={}, ms=5000) => {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
};
const PASSWORD    = '0415';
const CACHE_MS    = 5 * 60 * 1000;

let tokenCache = null, tokenExpiry = 0;
let dataCache = null, dataCacheTime = 0, rosterCache = null;

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
app.get("/api/debug-kt-member/:name", async (req, res) => {
  const m = dataCache?.members?.find(x=>x.name.toLowerCase()===req.params.name.toLowerCase());
  if(!dataCache) return res.json({error:"캐시없음"});
  if(!m) return res.json({error:"없음",names:dataCache.members?.map(x=>x.name)});
  res.json({name:m.name,realm:m.realm,level:m.level,class:m.class,bestRuns:m.bestRuns});
});
app.get("/api/debug-rio/:realm/:name", async (req, res) => {
  try {
    const rio = await fetchWithTimeout(
      `https://raider.io/api/v1/characters/profile?region=kr&realm=${req.params.realm}&name=${encodeURIComponent(req.params.name)}&fields=mythic_plus_best_runs:current`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000
    ).then(r => r.json());
    const RIO_DUN={"Windrunner Spire":"윈드러너 첨탑","Magisters' Terrace":"마법학자의 정원","Maisara Caverns":"마이사라 동굴","Nexus-Point Xenas":"공결탑 제나스","Pit of Saron":"사론의 구덩이","Skyreach":"하늘탑","Seat of the Triumvirate":"삼두정의 권좌","Algeth'ar Academy":"알게타르 대학"};
    const mapped=(rio.mythic_plus_best_runs||[]).map(r=>({en:r.dungeon, kr:RIO_DUN[r.dungeon]||'❌매핑없음', level:r.mythic_level, inTime:(r.num_keystone_upgrades||0)>0}));
    res.json({count:mapped.length, mapped});
  } catch(e){res.json({error:e.message});}
});

app.get('/api/debug-season/:realm/:name', async (req, res) => {
  try {
    const data = await bnet(`/profile/wow/character/${req.params.realm}/${encodeURIComponent(req.params.name)}/mythic-keystone-profile/season/17`);
    res.json(data);
  } catch(e) { res.json({error: e.message}); }
});

app.get('/api/debug-roster', async (req, res) => {
  try {
    const roster = await bnet(`/data/wow/guild/${GUILD_REALM}/${encodeURIComponent(GUILD_SLUG)}/roster`);
    const members = (roster.members || []).map(m => ({
      name: m.character.name,
      realm: m.character.realm?.slug,
      level: m.character.level,
    }));
    res.json(members);
  } catch(e) { res.json({error: e.message}); }
});

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
  if (!force && dataCache && Date.now() - dataCacheTime < CACHE_MS) {
    // 캐시 반환 시에도 level=0인 캐릭터는 로스터에서 패치
    try {
      const roster = await bnet(`/data/wow/guild/${GUILD_REALM}/${encodeURIComponent(GUILD_SLUG)}/roster`);
      const lm = {};
      (roster.members || []).forEach(m => { if(m.character?.name) lm[m.character.name] = m.character.level || 0; });
      dataCache.members.forEach(m => { if(!m.level && lm[m.name]) m.level = lm[m.name]; });
    } catch {}
    return res.json({ ...dataCache, cached: true, cacheAge: Math.round((Date.now() - dataCacheTime) / 1000) });
  }

  try {
    // 길드 로스터 (문서: /data/wow/guild/{realmSlug}/{nameSlug}/roster, namespace=profile-kr)
    console.log('길드 로스터 조회...');
    const roster = await bnet(`/data/wow/guild/${GUILD_REALM}/${encodeURIComponent(GUILD_SLUG)}/roster`);
    const members = roster.members || [];
    rosterCache = members; // 레벨 필터링용
    const levelMap = {};
    members.forEach(m => { if(m.character?.name) levelMap[m.character.name] = m.character.level || 0; });
    console.log(`멤버 ${members.length}명 조회 시작`);
    const BATCH = 10;
    const results = [];


    for (let i = 0; i < members.length; i += BATCH) {
      const batch = members.slice(i, i + BATCH);
      const fetched = await Promise.all(batch.map(async (m) => {
        const name = m.character.name;
        const realm = m.character.realm?.slug || GUILD_REALM;
        try {
          // 캐릭터 프로필 + Raider.io 병렬 호출
          const [charRes, rioRes, ksSeasonRes] = await Promise.allSettled([
            bnet(`/profile/wow/character/${realm}/${encodeURIComponent(name)}`),
            fetchWithTimeout(`https://raider.io/api/v1/characters/profile?region=kr&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,gear`, {
              headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 4000).then(r => r.json()).catch(() => null),
            bnet(`/profile/wow/character/${realm}/${encodeURIComponent(name)}/mythic-keystone-profile/season/17`).catch(() => null)
          ]);

          const char     = charRes.status     === 'fulfilled' ? charRes.value     : {};
          const rio      = rioRes.status      === 'fulfilled' ? rioRes.value      : null;
          const ksSeason = ksSeasonRes.status === 'fulfilled' ? ksSeasonRes.value : null;

          // 신뢰도: 배틀넷 > 레이더 > 직접입력
          const bnetIlvl  = char.equipped_item_level || null;
          const rioIlvl   = rio?.gear?.item_level_equipped || null;
          const rioScore  = rio?.mythic_plus_scores_by_season?.[0]?.scores?.all || null;

          const ilvl  = bnetIlvl || rioIlvl || null;
          const score = rioScore || null;

          // 시즌 베스트 런 (던전별 최고 단수)
          const bestRuns = {};
          if (ksSeason?.best_runs) {
            ksSeason.best_runs.forEach(run => {
              const dunName = run.dungeon?.name;
              if (dunName && (!bestRuns[dunName] || run.keystone_level > bestRuns[dunName])) {
                bestRuns[dunName] = run.keystone_level;
              }
            });
          }

          return {
            name,
            nameLower: name.toLowerCase(),
            class: char.character_class?.name || rio?.class || '',
            spec:  char.active_spec?.name || rio?.active_spec_name || '',
            role:  getRole(char.active_spec?.name || rio?.active_spec_name || ''),
            level: char.level || rio?.level || levelMap[name] || 0,
            ilvl,
            score,
            bestRuns,
            rank:  m.rank,
            realm,
          };
        } catch (e) {
          console.log(`${name} 실패: ${e.message}`);
          // 레이더io에서 클래스/스펙 보완 시도
          let cls = '', spec = '', rioIlvl = null, rioScore = null, rioLevel = 0;
          try {
            const rio = await fetchWithTimeout(
              `https://raider.io/api/v1/characters/profile?region=kr&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,gear`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } }, 4000
            ).then(r => r.json());
            cls = rio.class || '';
            spec = rio.active_spec_name || '';
            rioIlvl = rio.gear?.item_level_equipped || null;
            rioScore = rio.mythic_plus_scores_by_season?.[0]?.scores?.all || null;
            rioLevel = rio.level || 0;
          } catch {}
          return {
            name, nameLower: name.toLowerCase(),
            class: cls, spec, role: getRole(spec),
            level: levelMap[name] || rioLevel || 0,
            ilvl: rioIlvl, score: rioScore, bestRuns: {},
            rank: m.rank, realm,
          };
        }
      }));
      results.push(...fetched);
      console.log(`${Math.min(i + BATCH, members.length)} / ${members.length}`);
    }
    // 레벨 0인 경우 roster에서 강제 보완
    results.forEach(m => { if(!m.level && levelMap[m.name]) m.level = levelMap[m.name]; });

    dataCache = { members: results };
    dataCacheTime = Date.now();
    res.json({ ...dataCache, cached: false, cacheAge: 0 });
  } catch (err) {
    console.error('오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 저장 API
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const dataPath = f => `${DATA_DIR}/${f}`;
const readJ  = f => existsSync(dataPath(f)) ? JSON.parse(readFileSync(dataPath(f),'utf-8')) : null;
const writeJ = (f,d) => writeFileSync(dataPath(f), JSON.stringify(d, null, 2));
const checkPw = (pw,res) => { if(pw!==PASSWORD){res.status(401).json({error:'비밀번호 오류'});return false;}return true;};

const DEFAULT_NAMES = ['선호','병환','그루','태정','현명','영선','하정','황휘','혜원','세진','원석','화수','영준'];
function readPlayers() {
  // Railway 환경변수 우선, 없으면 파일
  const envData = process.env.PLAYERS_DATA ? JSON.parse(process.env.PLAYERS_DATA) : null;
  const d = readJ('players.json') || envData || {};
  const base = envData || {};
  return {
    names:     d.names     || base.names     || DEFAULT_NAMES,
    players:   d.players   || base.players   || {},
    overrides: d.overrides || base.overrides || {}
  };
}

app.get('/api/raid',    (req,res) => res.json(readJ('raid.json')||{slots:null}));
app.post('/api/raid',   (req,res) => {if(!checkPw(req.body.password,res))return;writeJ('raid.json',{slots:req.body.slots,updatedAt:new Date().toISOString()});res.json({ok:true});});
app.get('/api/players', (req,res) => res.json(readPlayers()));
app.post('/api/players',(req,res) => {
  if(!checkPw(req.body.password,res))return;
  const cur=readPlayers();
  writeJ('players.json',{
    names: req.body.names ?? cur.names,
    players: req.body.players ?? cur.players,
    overrides: req.body.overrides ?? cur.overrides,
  });
  res.json({ok:true});
});
app.get('/api/manual',  (req,res) => res.json(readJ('manual.json')||[]));
app.post('/api/manual', (req,res) => {if(!checkPw(req.body.password,res))return;writeJ('manual.json',req.body.chars);res.json({ok:true});});

// 쐐기돌 수동 입력
app.get('/api/keystones', (req,res) => res.json(readJ('keystones.json')||[]));
app.post('/api/keystones', (req,res) => {
  const {player,char,dungeon,level}=req.body;
  if(!char||!dungeon||!level)return res.status(400).json({error:'필수 항목 누락'});
  let ks=readJ('keystones.json')||[];
  ks=ks.filter(k=>k.char!==char);
  ks.push({player,char,dungeon,level:parseInt(level),updatedAt:new Date().toISOString()});
  writeJ('keystones.json',ks);
  res.json({ok:true});
});
app.delete('/api/keystones/:char', (req,res) => {
  writeJ('keystones.json',(readJ('keystones.json')||[]).filter(k=>k.char!==decodeURIComponent(req.params.char)));
  res.json({ok:true});
});

// ── 5인 파티 찾기 ──
const PARTY_FILE = 'parties.json';
const readParties = () => readJ(PARTY_FILE) || [];
const writeParties = d => writeJ(PARTY_FILE, d);

function specToRole(specs) {
  if (!specs || !specs.length) return 'DPS';
  const T = ['혈기','보호','수호','양조','복수','방어'];
  const H = ['신성','회복','운무','보존','복원','수양'];
  if (specs.some(s => T.some(t => s.includes(t)))) return 'TANK';
  if (specs.some(s => H.some(h => s.includes(h)))) return 'HEALING';
  return 'DPS';
}

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;

async function notifySlack(party) {
  if (!SLACK_WEBHOOK) return;
  const dunInfo = party.dungeon ? `${party.dungeon} ${party.level}단` : '던전 미정';
  const timeInfo = party.startTime ? ` · ⏰ ${party.startTime} 출발` : '';
  const specs = (party.authorSpecs||[]).join(', ');
  try {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🗝️ *새 파티 모집 등록*\n*${party.title}*`
            }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*던전*\n${dunInfo}${timeInfo}` },
              { type: 'mrkdwn', text: `*작성자*\n${party.authorName} · ${party.authorChar||'-'}` },
              { type: 'mrkdwn', text: `*특성*\n${specs||'-'}` },
            ]
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: '파티 찾기 보기' },
              url: 'https://wow-guild-production.up.railway.app/'
            }]
          }
        ]
      })
    });
  } catch(e) { console.log('Slack 알림 실패:', e.message); }
}

app.get('/api/parties', (req, res) => res.json(readParties()));

app.post('/api/parties', (req, res) => {
  const { title, dungeon, level, startTime, authorName, authorChar, authorSpecs, password } = req.body;
  if (!title || !authorName || !password) return res.status(400).json({ error: '필수 항목 누락' });
  const parties = readParties();
  const id = Date.now().toString();
  parties.unshift({ id, title, dungeon: dungeon||'', level: parseInt(level)||0, startTime: startTime||'',
    authorName, authorChar: authorChar||'', authorSpecs: authorSpecs||[],
    authorRole: specToRole(authorSpecs), password, status: 'open',
    createdAt: new Date().toISOString(), applications: [], plans: { plan1: null, plan2: null }, comments: [] });
  writeParties(parties);
  notifySlack(parties[0]);
  res.json({ ok: true, id });
});

app.post('/api/parties/:id/apply', (req, res) => {
  const { name, char, specs } = req.body;
  if (!name || !char) return res.status(400).json({ error: '필수 항목 누락' });
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  if (p.status === 'closed' || p.status === 'confirmed') return res.status(400).json({ error: '모집이 마감됐어요' });
  if (p.applications.find(a => a.name === name)) return res.status(400).json({ error: '이미 신청했어요' });
  if (p.authorName === name) return res.status(400).json({ error: '작성자는 이미 포함돼 있어요' });
  p.applications.push({ name, char, specs: specs||[], role: specToRole(specs), appliedAt: new Date().toISOString() });
  writeParties(parties);
  res.json({ ok: true });
});

app.delete('/api/parties/:id/apply/:name', (req, res) => {
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  p.applications = p.applications.filter(a => a.name !== decodeURIComponent(req.params.name));
  ['plan1','plan2'].forEach(pk => {
    if (p.plans && p.plans[pk]) p.plans[pk] = p.plans[pk].filter(s => s.name !== decodeURIComponent(req.params.name));
  });
  writeParties(parties);
  res.json({ ok: true });
});

app.put('/api/parties/:id/plan', (req, res) => {
  const { password, plan1, plan2 } = req.body;
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  if (password !== p.password && password !== '0415') return res.status(401).json({ error: '비밀번호 오류' });
  p.plans = { plan1: plan1||null, plan2: plan2||null };
  writeParties(parties);
  res.json({ ok: true });
});

app.put('/api/parties/:id/title', (req, res) => {
  const { password, title } = req.body;
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  if (password !== p.password && password !== PASSWORD) return res.status(401).json({ error: '비밀번호 오류' });
  if (!title?.trim()) return res.status(400).json({ error: '제목을 입력해주세요' });
  p.title = title.trim();
  writeParties(parties);
  res.json({ ok: true });
});

app.put('/api/parties/:id/status', (req, res) => {
  const { password, status } = req.body;
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  if (password !== p.password && password !== '0415') return res.status(401).json({ error: '비밀번호 오류' });
  p.status = status;
  writeParties(parties);
  res.json({ ok: true });
});

app.delete('/api/parties/:id', (req, res) => {
  const parties = readParties();
  const post = parties.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없는 글' });
  const pw = req.body.password;
  if (pw !== PASSWORD && pw !== post.password) return res.status(401).json({ error: '비밀번호 오류' });
  writeParties(parties.filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

// 쐐기현황 전용 API
app.get('/api/keytracker', async (req, res) => {
  try {
    const token = await getToken();
    const guild = dataCache?.members;
    if (!guild) return res.json({ error: '길드 데이터 없음. ?force=1로 먼저 불러오세요' });
    // roster 원본에서 레벨 90 이상만 (캐시된 level은 0일 수 있으므로)
    const rosterRaw = rosterCache || [];
    const level90Names = rosterRaw.length > 0
      ? new Set(rosterRaw.filter(m => (m.character?.level||0) >= 90).map(m => m.character.name))
      : null; // roster 없으면 전체 포함
    const filtered = level90Names ? guild.filter(m => level90Names.has(m.name)) : guild;
    
    // 레이더io 던전명 → 한글 매핑
    const RIO_DUN={
      "Windrunner Spire":"윈드러너 첨탑",
      "Magisters' Terrace":"마법학자의 정원",
      "Maisara Caverns":"마이사라 동굴",
      "Nexus-Point Xenas":"공결탑 제나스",
      "Pit of Saron":"사론의 구덩이",
      "Skyreach":"하늘탑",
      "Seat of the Triumvirate":"삼두정의 권좌",
      "Algeth'ar Academy":"알게타르 대학",
    };
    // 레이더io 특성명 → 한글
    const RIO_SPEC={
      'Blood':'혈기','Frost':'냉기','Unholy':'부정',
      'Havoc':'포식','Vengeance':'복수',
      'Balance':'조화','Guardian':'수호','Feral':'야성','Restoration':'회복',
      'Augmentation':'증강','Devastation':'황폐','Preservation':'보존',
      'Beast Mastery':'야수','Marksmanship':'사격','Survival':'생존',
      'Arcane':'비전','Fire':'화염',
      'Brewmaster':'양조','Windwalker':'풍운','Mistweaver':'운무',
      'Holy':'신성','Protection':'보호','Retribution':'징벌',
      'Discipline':'수양','Shadow':'암흑',
      'Assassination':'암살','Outlaw':'무법','Subtlety':'잠행',
      'Elemental':'정기','Enhancement':'고양',
      'Affliction':'고통','Demonology':'악마','Destruction':'파괴',
      'Arms':'무기','Fury':'분노',
    };

    // roster 원본 레벨 기준 (캐시된 level은 0일 수 있음)
    const results = await Promise.all(filtered.map(async m => {
      const bestRuns = {};
      // 1차: 블리자드 API
      try {
        const data = await bnet(`/profile/wow/character/${m.realm}/${encodeURIComponent(m.name)}/mythic-keystone-profile/season/17`);
        (data.best_runs || []).forEach(run => {
          const dun = run.dungeon?.name; if (!dun) return;
          const me = (run.members || []).find(mb => mb.character?.name === m.name);
          const spec = me?.specialization?.name || '';
          const inTime = run.is_completed_within_time || false;
          if (!bestRuns[dun] || run.keystone_level > bestRuns[dun].level)
            bestRuns[dun] = { level: run.keystone_level, spec, inTime };
        });
      } catch {
        // 2차: 레이더io 폴백
        try {
          const rio = await fetchWithTimeout(
            `https://raider.io/api/v1/characters/profile?region=kr&realm=${m.realm}&name=${encodeURIComponent(m.name)}&fields=mythic_plus_best_runs:current`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000
          ).then(r => r.json());
          (rio.mythic_plus_best_runs || []).forEach(run => {
            const dunEn = run.dungeon; if (!dunEn) return;
            const dun = RIO_DUN[dunEn] || dunEn;
            const specEn = run.spec?.name || '';
            const spec = RIO_SPEC[specEn] || specEn;
            const inTime = (run.num_keystone_upgrades || 0) > 0;
            if (!bestRuns[dun] || run.mythic_level > bestRuns[dun].level)
              bestRuns[dun] = { level: run.mythic_level, spec, inTime };
          });
        } catch {}
      }
      return { name: m.name, class: m.class, bestRuns };
    }));
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

// ── 댓글 ──
app.get('/api/parties/:id/comments', (req, res) => {
  const p = readParties().find(p => p.id === req.params.id);
  res.json(p?.comments || []);
});
app.post('/api/parties/:id/comments', (req, res) => {
  const { name, password, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: '필수 항목 누락' });
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  if (!p.comments) p.comments = [];
  p.comments.push({ id: Date.now().toString(), name, password: password||'', text: text.slice(0,50), createdAt: new Date().toISOString() });
  writeParties(parties);
  res.json({ ok: true });
});
app.put('/api/parties/:id/comments/:cid', (req, res) => {
  const { password, text } = req.body;
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  const c = (p.comments||[]).find(c => c.id === req.params.cid);
  if (!c) return res.status(404).json({ error: '없는 댓글' });
  if (password !== c.password && password !== '0415') return res.status(401).json({ error: '비밀번호 오류' });
  c.text = text.slice(0,50);
  writeParties(parties);
  res.json({ ok: true });
});
app.delete('/api/parties/:id/comments/:cid', (req, res) => {
  const { password } = req.body;
  const parties = readParties();
  const p = parties.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  const c = (p.comments||[]).find(c => c.id === req.params.cid);
  if (!c) return res.status(404).json({ error: '없는 댓글' });
  if (password !== c.password && password !== '0415') return res.status(401).json({ error: '비밀번호 오류' });
  p.comments = p.comments.filter(x => x.id !== req.params.cid);
  writeParties(parties);
  res.json({ ok: true });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ 서버 실행 중! http://localhost:${PORT}`);
  console.log(`🔍 토큰 테스트: http://localhost:${PORT}/api/debug-token`);
  console.log(`🔍 길드 테스트: http://localhost:${PORT}/api/debug-guild\n`);
});
