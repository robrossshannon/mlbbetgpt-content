// MLBBetGPT Daily Content Generator
// Runs every morning at 9am ET via cron
// Pulls tonight's games, starters, Savant stats, odds
// Generates Instagram post script via Claude
// Emails to robrossshannon.betgpt@gmail.com for approval

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const APPROVAL_EMAIL = 'robrossshannon.betgpt@gmail.com';
const APPROVE_URL = process.env.SITE_URL + '/api/approve-post';

exports.handler = async function(event) {
  try {
    console.log('Starting daily content generation...');
    const today = new Date().toISOString().split('T')[0];

    // 1. Fetch tonight's games + starters from MLB API
    const games = await fetchTonightsGames(today);
    if (!games.length) {
      console.log('No games today, skipping.');
      return { statusCode: 200, body: 'No games today' };
    }

    // 2. Fetch live odds
    const odds = await fetchOdds();

    // 3. Fetch Baseball Savant stats for each starting pitcher
    const savantData = await fetchSavantStats(games);

    // 4. Build context and generate post via Claude
    const context = buildContext(games, odds, savantData, today);
    const post = await generatePost(context);

    // 5. Store post in Netlify Blobs for approval/retrieval
    await storePost(post, today);

    // 6. Email for approval
    await sendApprovalEmail(post, today);

    console.log('Content generation complete!');
    return { statusCode: 200, body: JSON.stringify({ success: true, post }) };

  } catch(err) {
    console.error('Content generation error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ── FETCH TONIGHT'S GAMES ──
async function fetchTonightsGames(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`;
  const res = await fetch(url);
  const data = await res.json();
  const games = data.dates?.[0]?.games || [];

  return games.map(g => ({
    gameId: g.gamePk,
    time: g.gameDate,
    away: {
      team: g.teams?.away?.team?.name,
      pitcher: g.teams?.away?.probablePitcher ? {
        name: g.teams.away.probablePitcher.fullName,
        id: g.teams.away.probablePitcher.id
      } : null
    },
    home: {
      team: g.teams?.home?.team?.name,
      pitcher: g.teams?.home?.probablePitcher ? {
        name: g.teams.home.probablePitcher.fullName,
        id: g.teams.home.probablePitcher.id
      } : null
    }
  }));
}

// ── FETCH ODDS ──
async function fetchOdds() {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,totals&oddsFormat=american`;
    const res = await fetch(url);
    return await res.json();
  } catch(e) {
    console.error('Odds fetch error:', e);
    return [];
  }
}

// ── FETCH BASEBALL SAVANT STATS ──
async function fetchSavantStats(games) {
  const pitcherIds = [];
  games.forEach(g => {
    if (g.away.pitcher) pitcherIds.push({ id: g.away.pitcher.id, name: g.away.pitcher.name });
    if (g.home.pitcher) pitcherIds.push({ id: g.home.pitcher.id, name: g.home.pitcher.name });
  });

  const stats = {};
  const currentYear = new Date().getFullYear();

  await Promise.all(pitcherIds.map(async (pitcher) => {
    try {
      // Baseball Savant pitcher leaderboard CSV endpoint — free, no key needed
      const url = `https://baseballsavant.mlb.com/statcast_search/csv?hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=${currentYear}%7C&hfSit=&player_type=pitcher&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=&game_date_lt=&hfInfield=&team=&position=&hfOutfield=&hfRO=&home_road=&hfFlag=&hfBBT=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&min_abs=0&type=details&player_id=${pitcher.id}`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MLBBetGPT/1.0)' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = await res.text();
      const parsed = parseCSV(csv);

      if (parsed.length > 0) {
        // Aggregate key metrics from pitch-level data
        const pitches = parsed;
        const totalPitches = pitches.length;
        const swingMiss = pitches.filter(p => p.description === 'swinging_strike' || p.description === 'swinging_strike_blocked').length;
        const hardHit = pitches.filter(p => parseFloat(p.launch_speed) >= 95).length;
        const inPlay = pitches.filter(p => p.type === 'X').length;

        stats[pitcher.id] = {
          name: pitcher.name,
          totalPitches,
          whiffPct: totalPitches > 0 ? ((swingMiss / totalPitches) * 100).toFixed(1) : null,
          hardHitPct: inPlay > 0 ? ((hardHit / inPlay) * 100).toFixed(1) : null,
          avgVelo: avg(pitches.map(p => parseFloat(p.release_speed)).filter(v => !isNaN(v))).toFixed(1)
        };
      }
    } catch(e) {
      console.error(`Savant fetch error for ${pitcher.name}:`, e.message);
      stats[pitcher.id] = null;
    }
  }));

  return stats;
}

// ── BUILD CONTEXT STRING ──
function buildContext(games, odds, savantData, date) {
  const dateStr = new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  let ctx = `DATE: ${dateStr}\n\nTONIGHT'S MLB GAMES WITH ANALYTICS:\n\n`;

  games.forEach(g => {
    const gameTime = new Date(g.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    ctx += `${g.away.team} @ ${g.home.team} (${gameTime})\n`;

    // Add odds
    const gameOdds = odds.find(o =>
      o.away_team.includes(g.away.team?.split(' ').pop()) ||
      o.home_team.includes(g.home.team?.split(' ').pop())
    );
    if (gameOdds) {
      const h2h = gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h');
      const total = gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'totals');
      if (h2h) {
        const awayOdds = h2h.outcomes.find(o => o.name === gameOdds.away_team)?.price;
        const homeOdds = h2h.outcomes.find(o => o.name === gameOdds.home_team)?.price;
        ctx += `  Moneyline: ${g.away.team} ${awayOdds > 0 ? '+' : ''}${awayOdds} | ${g.home.team} ${homeOdds > 0 ? '+' : ''}${homeOdds}\n`;
      }
      if (total) {
        const overLine = total.outcomes.find(o => o.name === 'Over');
        ctx += `  Total: O/U ${overLine?.point} (Over ${overLine?.price > 0 ? '+' : ''}${overLine?.price})\n`;
      }
    }

    // Add pitcher stats
    [g.away, g.home].forEach(side => {
      if (!side.pitcher) { ctx += `  ${side.team} SP: TBD\n`; return; }
      ctx += `  ${side.team} SP: ${side.pitcher.name}`;
      const savant = savantData[side.pitcher.id];
      if (savant) {
        ctx += ` | Whiff% ${savant.whiffPct}% | Hard Hit% ${savant.hardHitPct}% | Avg Velo ${savant.avgVelo} mph`;
      }
      ctx += '\n';
    });
    ctx += '\n';
  });

  return ctx;
}

// ── GENERATE POST VIA CLAUDE ──
async function generatePost(context) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: `You are the content writer for MLBBetGPT, an AI MLB analytics platform on Instagram.

Your job is to write ONE compelling Instagram post per day that:
- Highlights an interesting analytical angle from tonight's MLB slate
- Focuses on DATA and EDGES, never gives direct picks
- Makes the reader curious enough to visit MLBBetGPT for deeper analysis
- Feels like a sharp analyst sharing an insight, not a tipster
- Uses relevant stats naturally (e.g. "Cole's whiff rate is top 5% in MLB this season")
- Ends with a soft CTA to the app

FORMAT your response as:
HOOK: (first line — must stop the scroll, max 10 words)
BODY: (2-4 lines of analytical insight with specific stats)
CTA: (one line driving to the app)
HASHTAGS: (8-10 relevant hashtags)

TONE: Confident, analytical, educational. Like a smart friend who knows baseball analytics.
DO NOT: Give picks, guarantee outcomes, use "lock", "guaranteed", or claim win records.`,
      messages: [{
        role: 'user',
        content: `Based on tonight's MLB data, generate one Instagram post that highlights the most interesting analytical angle:\n\n${context}`
      }]
    })
  });

  const data = await res.json();
  return data.content?.[0]?.text || 'Failed to generate post';
}

// ── STORE POST (Netlify Blobs) ──
async function storePost(post, date) {
  // Store in environment for retrieval by approve endpoint
  // In production this would use Netlify Blobs or a simple DB
  console.log('Post generated for', date, ':', post.slice(0, 100) + '...');
}

// ── SEND APPROVAL EMAIL VIA SENDGRID ──
async function sendApprovalEmail(post, date) {
  const dateStr = new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // Parse the post sections
  const sections = parsePost(post);

  const emailBody = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f5f5f5; padding: 20px;">
  <div style="background: #0d1220; border-radius: 12px; padding: 30px; color: white;">
    <h1 style="color: #c8102e; margin: 0 0 5px 0;">⚾ MLBBetGPT</h1>
    <p style="color: rgba(255,255,255,0.5); margin: 0 0 25px 0;">Daily Content — ${dateStr}</p>

    <div style="background: rgba(255,255,255,0.05); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
      <h3 style="color: #f59e0b; margin: 0 0 15px 0;">📱 Tonight's Instagram Post</h3>
      <div style="white-space: pre-wrap; line-height: 1.7; color: #dde1ed;">${post}</div>
    </div>

    <div style="display: flex; gap: 12px; margin-top: 20px;">
      <a href="${APPROVE_URL}?date=${date}&action=approve"
         style="background: #22c55e; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        ✅ Approve & Post
      </a>
      <a href="${APPROVE_URL}?date=${date}&action=regenerate"
         style="background: #f59e0b; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        🔄 Regenerate
      </a>
      <a href="${APPROVE_URL}?date=${date}&action=skip"
         style="background: rgba(255,255,255,0.1); color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        ⏭ Skip Today
      </a>
    </div>
  </div>

  <p style="text-align: center; color: #999; font-size: 12px; margin-top: 15px;">
    MLBBetGPT Daily Content Pipeline · For entertainment purposes only
  </p>
</body>
</html>`;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SENDGRID_API_KEY}`
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: APPROVAL_EMAIL }] }],
      from: { email: 'content@mlbbetgpt.com', name: 'MLBBetGPT Content' },
      subject: `⚾ MLBBetGPT Post Ready for Approval — ${dateStr}`,
      content: [{ type: 'text/html', value: emailBody }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SendGrid error: ${err}`);
  }

  console.log('Approval email sent to', APPROVAL_EMAIL);
}

// ── HELPERS ──
function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (values[i] || '').trim().replace(/"/g, ''); });
    return obj;
  });
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function parsePost(post) {
  const sections = {};
  const lines = post.split('\n');
  lines.forEach(line => {
    if (line.startsWith('HOOK:')) sections.hook = line.replace('HOOK:', '').trim();
    if (line.startsWith('BODY:')) sections.body = line.replace('BODY:', '').trim();
    if (line.startsWith('CTA:')) sections.cta = line.replace('CTA:', '').trim();
    if (line.startsWith('HASHTAGS:')) sections.hashtags = line.replace('HASHTAGS:', '').trim();
  });
  return sections;
}
