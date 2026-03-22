
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

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
      system: `You are a location extraction assistant. Given a social media URL (Instagram, TikTok, Yelp, Infatuation, etc.), extract the business information and return ONLY a JSON object with no markdown, no explanation, just raw JSON.

Return this exact shape:
{
  "name": "Business name",
  "address": "Full street address",
  "city": "City name",
  "category": "restaurant|bar|coffee|retail|other",
  "latitude": 40.7128,
  "longitude": -74.0060,
  "confidence": "high|medium|low",
  "notes": "Why you are confident or uncertain"
}

For latitude/longitude: use your best knowledge of the business location. If you cannot determine exact coords, use the city center and set confidence to low.
For category: food/dining → restaurant, drinks/nightlife → bar, cafe → coffee, shopping → retail, else → other.
If you truly cannot identify the business, return: {"error": "Could not identify business from this link"}`,
      messages: [{ role: "user", content: `Extract the business from this link: ${url}` }],
    }),
  });

  const data = await response.json();
  const text = data.content?.map((b) => b.text || "").join("") || "";

  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return res.status(200).json(parsed);
  } catch {
    return res.status(500).json({ error: "Failed to parse Claude response", raw: text });
  }
}
