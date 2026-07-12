const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BUFFER_API_KEY = process.env.BUFFER_API_KEY;
const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_TEMPLATE_ID = process.env.CREATOMATE_TEMPLATE_ID;

const INSTAGRAM_CHANNEL_ID = '6a5297ba404834462896cabf';
const TIKTOK_CHANNEL_ID = '6a5297ce404834462896cb0f';

// Posts at 6pm ET (11pm UTC) daily
const POST_HOUR_UTC = 23;

exports.handler = async function(event) {
  try {
    console.log('Starting daily content generation...');
    const today = new Date().toISOString().split('T')[0];

    // 1. Fetch tonight's games + starters
    const games = await fetchTonightsGames(today);
    if (!games.length) {
      console.log('No games today, skipping.');
      return { statusCode: 200, body: 'No games today' };
    }

    // 2. Fetch live odds
    const odds = await fetchOdds();

    // 3. Fetch Baseball Savant stats for each starting pitcher
    const savantData = await fetchSavantStats(games);

    // 4. Build context string and generate post via Claude
    const context = buildContext(games, odds, savantData, today);
    const post = await generatePost(context);

    // 5. Parse the post into sections
    const parsed = parsePost(post);
    console.log('Generated post hook:', parsed.hook);

    // 6. Render video via Creatomate
    const videoUrl = await renderVideo(parsed, games, savantData, odds);
    console.log('Video rendered:', videoUrl);

    // 7. Schedule to Buffer (Instagram + TikTok)
    const scheduleTime = getScheduleTime();
    await scheduleToBuffer(parsed, scheduleTime, videoUrl);

    console.log('Content scheduled for', scheduleTime);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, post: parsed, scheduledFor: scheduleTime })
    };

  } catch(err) {
    console.error('Content generation error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
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
  const pitchers = [];
  games.forEach(g => {
    if (g.away.pitcher) pitchers.push(g.away.pitcher);
    if (g.home.pitcher) pitchers.push(g.home.pitcher);
  });

  const stats = {};
  const year = new Date().getFullYear();

  await Promise.all(pitchers.map(async (pitcher) => {
    try {
      const url = `https://baseballsavant.mlb.com/statcast_search/csv?player_type=pitcher&hfSea=${year}%7C&player_id=${pitcher.id}&group_by=name&sort_col=pitches&sort_order=desc&type=details&min_pitches=0&min_results=0&min_abs=0`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MLBBetGPT/1.0)' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = await res.text();
      const rows = parseCSV(csv);

      if (rows.length > 0) {
        const swings = rows.filter(r => ['swinging_strike','swinging_strike_blocked','foul','hit_into_play','foul_tip'].includes(r.description)).length;
        const whiffs = rows.filter(r => ['swinging_strike','swinging_strike_blocked'].includes(r.description)).length;
        const inPlay = rows.filter(r => r.type === 'X').length;
        const hardHit = rows.filter(r => parseFloat(r.launch_speed) >= 95).length;
        const velos = rows.map(r => parseFloat(r.release_speed)).filter(v => !isNaN(v) && v > 0);

        stats[pitcher.id] = {
          name: pitcher.name,
          whiffPct: swings > 0 ? ((whiffs / swings) * 100).toFixed(1) : 'N/A',
          hardHitPct: inPlay > 0 ? ((hardHit / inPlay) * 100).toFixed(1) : 'N/A',
          avgVelo: velos.length > 0 ? (velos.reduce((a,b) => a+b, 0) / velos.length).toFixed(1) : 'N/A',
          pitches: rows.length
        };
      }
    } catch(e) {
      console.error(`Savant error for ${pitcher.name}:`, e.message);
      stats[pitcher.id] = null;
    }
  }));

  return stats;
}

// ── BUILD CONTEXT ──
function buildContext(games, odds, savantData, date) {
  const dateStr = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });
  let ctx = `DATE: ${dateStr}\n\nTONIGHT'S MLB GAMES:\n\n`;

  games.slice(0, 8).forEach(g => {
    const gameTime = new Date(g.time).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
    ctx += `${g.away.team} @ ${g.home.team} (${gameTime})\n`;

    // Odds
    const gameOdds = (Array.isArray(odds) ? odds : []).find(o =>
      o.away_team && g.away.team && (
        o.away_team.includes(g.away.team.split(' ').pop()) ||
        g.away.team.includes(o.away_team.split(' ').pop())
      )
    );
    if (gameOdds) {
      const h2h = gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h');
      const total = gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'totals');
      if (h2h) {
        const ao = h2h.outcomes.find(o => o.name === gameOdds.away_team)?.price;
        const ho = h2h.outcomes.find(o => o.name === gameOdds.home_team)?.price;
        if (ao && ho) ctx += `  ML: ${g.away.team} ${ao > 0 ? '+' : ''}${ao} | ${g.home.team} ${ho > 0 ? '+' : ''}${ho}\n`;
      }
      if (total) {
        const over = total.outcomes.find(o => o.name === 'Over');
        if (over) ctx += `  O/U: ${over.point} (Over ${over.price > 0 ? '+' : ''}${over.price})\n`;
      }
    }

    // Pitchers with Savant stats
    [{ side: g.away, label: 'Away' }, { side: g.home, label: 'Home' }].forEach(({ side, label }) => {
      if (!side.pitcher) { ctx += `  ${label} SP: TBD\n`; return; }
      ctx += `  ${label} SP: ${side.pitcher.name}`;
      const s = savantData[side.pitcher.id];
      if (s && s.pitches > 0) {
        ctx += ` | Whiff% ${s.whiffPct} | Hard Hit% ${s.hardHitPct} | Avg Velo ${s.avgVelo} mph`;
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
      max_tokens: 800,
      system: `You are the content writer for MLBBetGPT, an AI MLB analytics platform on Instagram and TikTok.

Write ONE compelling post that:
- Highlights a genuinely interesting analytical angle from tonight's slate
- Focuses on DATA and EDGES — never gives direct picks or guarantees
- Makes followers curious enough to visit MLBBetGPT for deeper analysis
- Uses specific stats naturally (whiff rates, velocities, odds movement)
- Feels like a sharp analyst sharing an insight, not a tipster

FORMAT your response EXACTLY like this:
HOOK: (first line — stops the scroll, max 10 words, use an emoji)
BODY: (2-4 lines of sharp analytical insight with specific stats)
CTA: Full breakdown at MLBBetGPT ⚾ (link in bio)
HASHTAGS: #MLB #BaseballAnalytics #SportsBetting #MLBpicks #BaseballStats #BettingAnalysis #MLBToday #SportsbookEdge

TONE: Confident, analytical, educational. Like a smart friend who knows baseball analytics.
NEVER: Give picks, use "lock" or "guaranteed", claim win records, or encourage reckless betting.`,
      messages: [{
        role: 'user',
        content: `Generate today's post based on this data:\n\n${context}`
      }]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error('Claude API error: ' + data.error.message);
  return data.content?.[0]?.text || '';
}

// ── PARSE POST INTO SECTIONS ──
function parsePost(text) {
  const lines = text.split('\n');
  const sections = { hook: '', body: '', cta: '', hashtags: '', caption: '' };
  const bodyLines = [];
  let currentSection = null;

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('HOOK:')) {
      currentSection = 'hook';
      sections.hook = trimmed.replace('HOOK:', '').trim();
    } else if (trimmed.startsWith('BODY:')) {
      currentSection = 'body';
      const val = trimmed.replace('BODY:', '').trim();
      if (val) bodyLines.push(val);
    } else if (trimmed.startsWith('CTA:')) {
      currentSection = 'cta';
      sections.cta = trimmed.replace('CTA:', '').trim();
    } else if (trimmed.startsWith('HASHTAGS:')) {
      currentSection = 'hashtags';
      sections.hashtags = trimmed.replace('HASHTAGS:', '').trim();
    } else if (currentSection === 'body' && trimmed) {
      bodyLines.push(trimmed);
    } else if (currentSection === 'hashtags' && trimmed) {
      sections.hashtags += ' ' + trimmed;
    }
  });

  sections.body = bodyLines.join('\n');
  sections.caption = `${sections.hook}\n\n${sections.body}\n\n${sections.cta}\n\n${sections.hashtags}`;
  return sections;
}

// ── RENDER VIDEO VIA CREATOMATE ──
async function renderVideo(parsed, games, savantData, odds) {
  // Find the featured game (first game with pitcher data)
  let featuredGame = null;
  let featuredSavant = null;
  let featuredTotal = null;

  for (const g of games) {
    const awayS = g.away.pitcher ? savantData[g.away.pitcher.id] : null;
    const homeS = g.home.pitcher ? savantData[g.home.pitcher.id] : null;
    if (awayS || homeS) {
      featuredGame = g;
      featuredSavant = awayS || homeS;

      // Find odds for this game
      const gameOdds = (Array.isArray(odds) ? odds : []).find(o =>
        o.away_team && g.away.team && (
          o.away_team.includes(g.away.team.split(' ').pop()) ||
          g.away.team.includes(o.away_team.split(' ').pop())
        )
      );
      if (gameOdds) {
        const total = gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'totals');
        const over = total?.outcomes?.find(o => o.name === 'Over');
        if (over) featuredTotal = over.point.toString();
      }
      break;
    }
  }

  const modifications = {
    hook_text: parsed.hook || 'Tonight's MLB Analytics Edge',
    stat1_value: featuredSavant?.whiffPct ? featuredSavant.whiffPct + '%' : 'N/A',
    stat2_value: featuredSavant?.avgVelo ? featuredSavant.avgVelo + ' mph' : 'N/A',
    stat3_value: featuredSavant?.hardHitPct ? featuredSavant.hardHitPct + '%' : 'N/A',
    stat4_value: featuredTotal || 'N/A',
    body_text: parsed.body || ''
  };

  console.log('Rendering video with modifications:', JSON.stringify(modifications));

  const res = await fetch('https://api.creatomate.com/v1/renders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CREATOMATE_API_KEY}`
    },
    body: JSON.stringify({
      template_id: CREATOMATE_TEMPLATE_ID,
      modifications
    })
  });

  const data = await res.json();
  console.log('Creatomate response:', JSON.stringify(data));

  if (!res.ok) throw new Error('Creatomate error: ' + JSON.stringify(data));

  // Poll for completion (Creatomate renders async)
  const renderId = Array.isArray(data) ? data[0]?.id : data?.id;
  if (!renderId) throw new Error('No render ID returned from Creatomate');

  return await pollRender(renderId);
}

// Poll Creatomate until render is complete
async function pollRender(renderId) {
  const maxAttempts = 30;
  const delay = 3000; // 3 seconds between polls

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, delay));

    const res = await fetch(`https://api.creatomate.com/v1/renders/${renderId}`, {
      headers: { 'Authorization': `Bearer ${CREATOMATE_API_KEY}` }
    });

    const render = await res.json();
    console.log(`Render status (attempt ${i+1}):`, render.status);

    if (render.status === 'succeeded') {
      return render.url;
    } else if (render.status === 'failed') {
      throw new Error('Creatomate render failed: ' + render.error_message);
    }
  }

  throw new Error('Creatomate render timed out');
}

// ── SCHEDULE TO BUFFER VIA GRAPHQL ──
async function scheduleToBuffer(parsed, scheduleTime, videoUrl) {
  const channels = [INSTAGRAM_CHANNEL_ID, TIKTOK_CHANNEL_ID];

  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            status
            dueAt
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  for (const channelId of channels) {
    // Build assets array with video if available
    const assets = videoUrl ? [
      {
        video: {
          url: videoUrl
        }
      }
    ] : [];

    const variables = {
      input: {
        channelId,
        text: parsed.caption,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt: scheduleTime,
        assets
      }
    };

    const res = await fetch('https://api.buffer.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BUFFER_API_KEY}`
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    const data = await res.json();
    console.log(`Buffer response for channel ${channelId}:`, JSON.stringify(data));

    if (data.errors) {
      console.error(`Buffer GraphQL error for channel ${channelId}:`, JSON.stringify(data.errors));
    } else {
      const result = data.data?.createPost;
      if (result?.post) {
        console.log(`Scheduled to ${channelId}: post ${result.post.id} at ${result.post.dueAt}`);
      } else if (result?.message) {
        console.error(`Buffer createPost error:`, result.message);
      }
    }
  }
}

// ── HELPERS ──
function getScheduleTime() {
  const now = new Date();
  const scheduled = new Date(now);
  scheduled.setUTCHours(POST_HOUR_UTC, 0, 0, 0);
  if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1);
  return scheduled.toISOString();
}

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

