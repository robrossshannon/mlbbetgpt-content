// Handles approval actions from the daily email
// ?action=approve → posts to Instagram
// ?action=regenerate → triggers new content generation
// ?action=skip → skips today

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

exports.handler = async function(event) {
  const params = event.queryStringParameters || {};
  const action = params.action;
  const date = params.date;

  try {
    if (action === 'approve') {
      // Retrieve stored post for this date
      const post = await retrievePost(date);
      if (!post) {
        return htmlResponse('❌ Post not found. It may have expired.', 'error');
      }

      // Post to Instagram
      await postToInstagram(post);
      return htmlResponse('✅ Post approved and published to Instagram!', 'success');

    } else if (action === 'regenerate') {
      // Trigger a new content generation
      await fetch(`${process.env.SITE_URL}/.netlify/functions/generate-content`, {
        method: 'POST'
      });
      return htmlResponse('🔄 Regenerating post... Check your email in a few minutes.', 'info');

    } else if (action === 'skip') {
      return htmlResponse('⏭ Skipped today\'s post.', 'info');

    } else {
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch(err) {
    console.error('Approval error:', err);
    return htmlResponse(`❌ Error: ${err.message}`, 'error');
  }
};

// ── POST TO INSTAGRAM ──
async function postToInstagram(postText) {
  // Parse sections from post
  const hook = extractSection(postText, 'HOOK');
  const body = extractSection(postText, 'BODY');
  const cta = extractSection(postText, 'CTA');
  const hashtags = extractSection(postText, 'HASHTAGS');

  const caption = `${hook}\n\n${body}\n\n${cta}\n\n${hashtags}`;

  // Instagram Graph API — create a text/image post
  // Note: For feed posts Instagram requires an image
  // We'll use a simple branded image URL or generate one
  // For now we create a caption-only post via the API

  // Step 1: Create media container
  const createRes = await fetch(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_ACCOUNT_ID}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: `${process.env.SITE_URL}/og-image.png`, // branded default image
      caption: caption,
      access_token: INSTAGRAM_ACCESS_TOKEN
    })
  });

  const createData = await createRes.json();
  if (createData.error) throw new Error(`Instagram create error: ${createData.error.message}`);

  const mediaId = createData.id;

  // Step 2: Publish the container
  const publishRes = await fetch(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_ACCOUNT_ID}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: mediaId,
      access_token: INSTAGRAM_ACCESS_TOKEN
    })
  });

  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`Instagram publish error: ${publishData.error.message}`);

  console.log('Posted to Instagram:', publishData.id);
  return publishData.id;
}

// ── RETRIEVE STORED POST ──
async function retrievePost(date) {
  // In production: retrieve from Netlify Blobs or KV store
  // For now returns null — will wire up storage in next step
  return process.env[`POST_${date}`] || null;
}

function extractSection(text, section) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith(`${section}:`)) return line.replace(`${section}:`, '').trim();
  }
  return '';
}

function htmlResponse(message, type) {
  const colors = { success: '#22c55e', error: '#ef4444', info: '#3b82f6' };
  const color = colors[type] || '#3b82f6';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #090d18;">
  <div style="background: #0d1220; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px;">
    <div style="font-size: 48px; margin-bottom: 16px;">⚾</div>
    <h2 style="color: ${color}; margin: 0 0 10px 0;">${message}</h2>
    <p style="color: rgba(255,255,255,0.4); font-size: 13px;">MLBBetGPT Content Pipeline</p>
    <a href="javascript:window.close()" style="color: ${color}; font-size: 13px;">Close this window</a>
  </div>
</body>
</html>`
  };
}
