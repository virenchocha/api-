// api/chat.js — Entangle AI Agent Proxy
// Fetches live Shopify catalog → sends to Claude as context

const SHOPIFY_STOREFRONT_QUERY = `
  query GetProducts {
    products(first: 50) {
      edges {
        node {
          title
          handle
          description
          availableForSale
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          compareAtPriceRange {
            minVariantPrice { amount currencyCode }
          }
          variants(first: 10) {
            edges {
              node {
                title
                availableForSale
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
              }
            }
          }
          collections(first: 3) {
            edges { node { title handle } }
          }
        }
      }
    }
  }
`;

async function fetchShopifyProducts() {
  const res = await fetch(
    `https://entangle.in/api/2024-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({ query: SHOPIFY_STOREFRONT_QUERY })
    }
  );

  if (!res.ok) throw new Error('Shopify fetch failed');
  const data = await res.json();
  const products = data?.data?.products?.edges || [];

  return products.map(({ node: p }) => {
    const minPrice = parseFloat(p.priceRange.minVariantPrice.amount);
    const maxPrice = parseFloat(p.priceRange.maxVariantPrice.amount);
    const compareAt = parseFloat(p.compareAtPriceRange?.minVariantPrice?.amount || 0);
    const priceStr = minPrice === maxPrice
      ? `Rs. ${minPrice.toFixed(0)}`
      : `Rs. ${minPrice.toFixed(0)} – Rs. ${maxPrice.toFixed(0)}`;
    const originalStr = compareAt > minPrice ? ` (was Rs. ${compareAt.toFixed(0)})` : '';

    const variants = p.variants.edges
      .map(v => `${v.node.title}${v.node.availableForSale ? '' : ' [sold out]'}`)
      .join(', ');

    const collections = p.collections.edges.map(c => c.node.title).join(', ');
    const available = p.availableForSale ? 'In stock' : 'Sold out';
    const url = `https://entangle.in/products/${p.handle}`;

    return `• ${p.title} | ${priceStr}${originalStr} | ${available} | Variants: ${variants} | Category: ${collections} | URL: ${url}`;
  }).join('\n');
}

function buildSystemPrompt(productCatalog) {
  return `You are a warm, knowledgeable sales and customer care assistant for Entangle (entangle.in) — a premium Indian men's clothing brand.

BRAND:
Entangle sells premium shirts and t-shirts crafted from uniquely selected, high-quality fabrics.
Philosophy: "Where Fabric Tells a Story" — timeless appeal, modern refinement, elegant design.
Website: https://entangle.in
Phone: +91 8320768558
Email: wecare@entangle.in
Contact page: https://entangle.in/pages/contact-us

CURRENT OFFERS:
- Buy 2 items → Get Rs. 200 OFF
- Buy 3 items → Get Rs. 300 OFF
- Buy 4+ items → Get 10% OFF
Full offers: https://entangle.in/pages/offers-deals

COLLECTIONS:
- All products: https://entangle.in/collections/all
- Shirts: https://entangle.in/collections/shirt
- T-Shirts: https://entangle.in/collections/t-shirt
- Style Arrivals: https://entangle.in/collections/style-arrivals

LIVE PRODUCT CATALOG (fetched right now from the store):
${productCatalog || 'Product catalog temporarily unavailable — direct customers to https://entangle.in/collections/all'}

YOUR RULES:
- Keep replies to 2–4 sentences. Warm, conversational, never robotic.
- Never use bullet lists or markdown formatting in replies.
- When recommending a product, always include its direct URL.
- Highlight the current multi-buy offers when a customer is browsing.
- If a product is sold out, suggest similar available items or ask them to contact wecare@entangle.in for restock info.
- For order issues, shipping queries, or anything you can't answer, direct to wecare@entangle.in or +91 8320768558.
- All prices are in Indian Rupees (Rs.).`;
}

export default async function handler(req, res) {
  // CORS — allow only your store domain
  res.setHeader('Access-Control-Allow-Origin', 'https://www.entangle.in');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Step 1: Fetch live Shopify catalog
    let productCatalog = '';
    try {
      productCatalog = await fetchShopifyProducts();
    } catch (e) {
      console.error('Shopify fetch error:', e.message);
      // Continue without catalog — Claude will still work
    }

    // Step 2: Build system prompt with live catalog
    const system = buildSystemPrompt(productCatalog);

    // Step 3: Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 350,
        system,
        messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude error: ${err}`);
    }

    const data = await claudeRes.json();
    const reply = data.content?.[0]?.text || "I'm having trouble right now. Please reach us at wecare@entangle.in!";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({
      reply: "Something went wrong on our end. Please contact us at wecare@entangle.in or +91 8320768558!"
    });
  }
}
