export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const isInstagram = url.includes("instagram.com");

  try {
    if (isInstagram) {
      return await handleInstagram(url, res);
    } else {
      return await handleGenericUrl(url, res);
    }
  } catch (e) {
    return res.status(500).json({ error: "Extraction failed", detail: e.message });
  }
}

async function handleInstagram(url, res) {
  const signals = {};

  const [htmlResult, oembedResult] = await Promise.allSettled([
    fetchInstagramHTML(url),
    fetchOEmbed(url),
  ]);

  if (htmlResult.status === "fulfilled") Object.assign(signals, htmlResult.value);
  if (oembedResult.status === "fulfilled") Object.assign(signals, oembedResult.value);

  let thumbnailBase64 = null;
  if (signals.thumbnailUrl) {
    thumbnailBase64 = await fetchImageAsBase64(signals.thumbnailUrl);
  }

  const systemPrompt = `You are a location extraction assistant. Your job is to identify a specific business (restaurant, bar, coffee shop, retail store, etc.) from Instagram post data and return its location.

You will receive raw signals from an Instagram post: HTML metadata, caption text, location tags, account name, hashtags, and possibly a thumbnail image.

Reason across ALL signals together to identify the specific business. Consider:
- Location tags are highly reliable when present
- Account names often reveal the business (e.g. @carnegiedeli = Carnegie Deli)
- Captions may mention the business name directly or via @ tags
- Hashtags sometimes contain business names
- The thumbnail may show signage, location stickers, or text overlays
- For influencer posts, look for tagged locations or @ mentions of the business
- For business posts, the account IS the business

Return ONLY a raw JSON object, no markdown, no explanation:
{
  "name": "Exact business name",
  "address": "Full street address",
  "city": "City",
  "state": "State abbreviation",
  "country": "Country",
  "category": "restaurant|bar|coffee|retail|other",
  "latitude": 40.7128,
  "longitude": -74.0060,
  "confidence": "high|medium|low",
  "confidence_reason": "Brief explanation of what signals led to this conclusion",
  "source_signal": "location_tag|caption_mention|account_name|visual|combined"
}

If you truly cannot identify a specific business, return:
{"error": "Could not identify a specific business", "what_we_found": "describe what signals were present"}`;

  const userContent = [];

  if (thumbnailBase64) {
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: thumbnailBase64 },
    });
  }

  userContent.push({
    type: "text",
    text: `Instagram post signals:

URL: ${url}
Account name: ${signals.accountName || "unknown"}
Location tag: ${signals.locationTag || "none"}
Caption: ${signals.caption || "none"}
Hashtags: ${signals.hashtags || "none"}
Tagged accounts: ${signals.taggedAccounts || "none"}
Post type: ${signals.postType || "unknown"}
Additional metadata: ${signals.additionalMeta || "none"}

Please identify the specific business from these signals.`,
  });

  const claudeRes = await callClaude(systemPrompt, userContent);
  return res.status(200).json(claudeRes);
}

async function fetchInstagramHTML(url) {
  const signals = {};
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    const html = await response.text();

    // JSON-LD
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        if (jsonLd.name) signals.accountName = jsonLd.name;
        if (jsonLd.caption) signals.caption = jsonLd.caption;
        if (jsonLd.description) signals.caption = signals.caption || jsonLd.description;
        if (jsonLd.thumbnailUrl) signals.thumbnailUrl = jsonLd.thumbnailUrl;
        if (jsonLd.contentLocation) signals.locationTag = JSON.stringify(jsonLd.contentLocation);
        signals.postType = jsonLd["@type"] || "unknown";
      } catch (_) {}
    }

    // Meta tags
    const metaMatches = html.matchAll(/<meta[^>]+(?:property|name)="([^"]+)"[^>]+content="([^"]+)"/g);
    for (const match of metaMatches) {
      const prop = match[1];
      const content = match[2];
      if (prop === "og:description" && !signals.caption) signals.caption = decodeHTMLEntities(content);
      if (prop === "og:image" && !signals.thumbnailUrl) signals.thumbnailUrl = content;
      if (prop === "og:title") signals.ogTitle = decodeHTMLEntities(content);
    }

    // window._sharedData
    const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});<\/script>/);
    if (sharedDataMatch) {
      try {
        const sharedData = JSON.parse(sharedDataMatch[1]);
        const media = sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
        if (media) {
          signals.caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || signals.caption;
          signals.locationTag = media.location?.name || signals.locationTag;
          signals.accountName = media.owner?.username || signals.accountName;
          signals.thumbnailUrl = media.display_url || signals.thumbnailUrl;
        }
      } catch (_) {}
    }

    // Hashtags and mentions from caption
    if (signals.caption) {
      const hashtags = signals.caption.match(/#[\w]+/g);
      const mentions = signals.caption.match(/@[\w.]+/g);
      if (hashtags) signals.hashtags = hashtags.join(" ");
      if (mentions) signals.taggedAccounts = mentions.join(" ");
    }

    // Inline location name
    const locationMatch = html.match(/"location":\{"id":"[^"]+","has_public_page":[^,]+,"name":"([^"]+)"/);
    if (locationMatch && !signals.locationTag) signals.locationTag = locationMatch[1];

    if (signals.ogTitle) signals.additionalMeta = signals.ogTitle;

  } catch (e) {
    signals.htmlError = e.message;
  }
  return signals;
}

async function fetchOEmbed(url) {
  const signals = {};
  try {
    const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&maxwidth=320`;
    const res = await fetch(oembedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.ok) {
      const data = await res.json();
      if (data.author_name) signals.accountName = signals.accountName || data.author_name;
      if (data.thumbnail_url) signals.thumbnailUrl = signals.thumbnailUrl || data.thumbnail_url;
      if (data.title) signals.oembedTitle = data.title;
    }
  } catch (_) {}
  return signals;
}

async function handleGenericUrl(url, res) {
  const systemPrompt = `You are a location extraction assistant. Given a URL (Yelp, Infatuation, TikTok, Google Maps, a restaurant website, etc.), identify the business and return ONLY a raw JSON object:

{
  "name": "Business name",
  "address": "Full street address",
  "city": "City",
  "state": "State abbreviation",
  "country": "Country",
  "category": "restaurant|bar|coffee|retail|other",
  "latitude": 40.7128,
  "longitude": -74.0060,
  "confidence": "high|medium|low",
  "confidence_reason": "What signals led to this",
  "source_signal": "url_structure|known_business|other"
}

If you cannot identify a specific business: {"error": "Could not identify business from this link"}`;

  const result = await callClaude(systemPrompt, [{ type: "text", text: `Extract the business from: ${url}` }]);
  return res.status(200).json(result);
}

async function callClaude(system, userContent) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const data = await response.json();
  const text = data.content?.map((b) => b.text || "").join("") || "";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { error: "Failed to parse response", raw: text };
  }
}

async function fetchImageAsBase64(imageUrl) {
  try {
    const res = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch {
    return null;
  }
}

function decodeHTMLEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
