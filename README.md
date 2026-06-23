# MLBBetGPT Content Pipeline

## How it works

Every day at 9am ET this pipeline:
1. Pulls tonight's MLB games + starting pitchers (MLB Stats API)
2. Pulls live odds (The Odds API)  
3. Pulls Statcast analytics for each starter (Baseball Savant)
4. Feeds everything to Claude to generate an Instagram post
5. Emails robrossshannon.betgpt@gmail.com for approval
6. On approval → posts to Instagram automatically

## Environment Variables needed in Netlify

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `ODDS_API_KEY` | Your Odds API key |
| `SENDGRID_API_KEY` | SendGrid API key (free tier works) |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Graph API token |
| `INSTAGRAM_ACCOUNT_ID` | Your Instagram Business Account ID |
| `SITE_URL` | https://your-site.netlify.app |

## Setup steps

### 1. SendGrid (free email)
- Sign up at sendgrid.com (free tier = 100 emails/day)
- Create an API key
- Verify your sender email (content@mlbbetgpt.com or your Gmail)

### 2. Instagram API
- Go to developers.facebook.com
- Create an app → Add Instagram Graph API
- Connect your Instagram Business account
- Generate a long-lived access token
- Get your Instagram Account ID

### 3. Deploy to Netlify
- Push this folder to GitHub
- Connect to Netlify
- Add all environment variables
- The cron job runs automatically at 9am ET daily

## Testing

To test manually, hit:
GET https://your-site.netlify.app/.netlify/functions/generate-content

This will generate a post and email it immediately.
