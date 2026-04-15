// Claude Bot — FB Messenger + POS Pancake
// Template version — all brand-specific content from environment variables
// GitHub: Zian1416/furbiotics-chatbot (replace with this updated version)

const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Environment Variables (all brand-specific) ───────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PANCAKE_API_KEY = process.env.PANCAKE_API_KEY;
const PANCAKE_SHOP_ID = process.env.PANCAKE_SHOP_ID;
const PANCAKE_BASE = "https://pos.pages.fm/api/v1";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "You are a helpful customer assistant.";
const BRAND_NAME = process.env.BRAND_NAME || "Our Brand";

// ─── Pack Info from environment variable ─────────────────────────
// Format: JSON string
// Example: {"starter":{"custom_id":"SP-499","name":"Starter Pack","price":499000,"label":"Starter Pack (1 bottle) - ₱499"},"duo":{"custom_id":"DP-699","name":"Duo Pack","price":699000,"label":"Duo Pack (2 bottles) - ₱699"}}
let PACK_INFO = {};
let PACK_QUANTITY = {};

try {
  PACK_INFO = JSON.parse(process.env.PACK_INFO || "{}");
  PACK_QUANTITY = JSON.parse(process.env.PACK_QUANTITY || "{}");
} catch (e) {
  console.error("Failed to parse PACK_INFO or PACK_QUANTITY:", e.message);
}

// ─── NCR Detection ────────────────────────────────────────────────
const NCR_CITIES = [
  "metro manila", "ncr", "national capital region",
  "quezon city", "quezon", "qc",
  "makati", "makati city",
  "pasig", "pasig city",
  "taguig", "taguig city", "fort bonifacio", "bgc",
  "caloocan", "caloocan city",
  "manila", "city of manila",
  "paranaque", "parañaque", "paranaque city", "parañaque city",
  "las pinas", "las piñas", "las pinas city", "las piñas city",
  "pasay", "pasay city",
  "valenzuela", "valenzuela city",
  "malabon", "malabon city",
  "mandaluyong", "mandaluyong city",
  "marikina", "marikina city",
  "muntinlupa", "muntinlupa city", "alabang",
  "navotas", "navotas city",
  "san juan", "san juan city",
  "pateros",
];

const SUBDIVISION_WORDS = [
  "village", "subdivision", "subd", "homes", "residences",
  "estate", "heights", "hills", "place", "compound",
  "townhouse", "condo", "condominium", "tower", "building",
  "phase", "block"
];

// ─── String Helpers ───────────────────────────────────────────────
function normalize(str) {
  return (str || "").toLowerCase()
    .replace(/\bcity\b/gi, "")
    .replace(/\bmunicipality\b/gi, "")
    .replace(/\bbrgy\.?\b/gi, "")
    .replace(/\bbarangay\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wA = na.split(" ").filter(w => w.length > 2);
  const wB = nb.split(" ").filter(w => w.length > 2);
  if (!wA.length || !wB.length) return 0;
  const matched = wA.filter(w => wB.some(wb => wb.includes(w) || w.includes(wb) || levenshtein(w, wb) <= 2));
  return matched.length / Math.max(wA.length, wB.length);
}

function findBestMatch(list, fields, query) {
  if (!query || !list?.length) return null;
  let best = null, bestScore = 0;
  const fs = Array.isArray(fields) ? fields : [fields];
  for (const item of list) {
    for (const f of fs) {
      const score = similarity(item[f] || "", query);
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }
  return bestScore > 0.25 ? best : null;
}

function isNCRCity(str) {
  const lower = normalize(str || "");
  return NCR_CITIES.some(city => {
    const nc = normalize(city);
    return nc === lower || lower.includes(nc) || nc.includes(lower);
  });
}

function isSubdivisionName(str) {
  const lower = (str || "").toLowerCase();
  return SUBDIVISION_WORDS.some(word => lower.includes(word));
}

// ─── Address Parser ───────────────────────────────────────────────
function parseAddressParts(raw) {
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  let street = "", commune = "", district = "", province = "";

  if (parts.length === 0) return { street: raw, commune: "", district: "", province: "" };

  const last = parts[parts.length - 1];
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : "";

  if (isNCRCity(last)) {
    province = "Metro Manila";
    district = last.replace(/\bcity\b/gi, "").trim();
    const remaining = parts.slice(0, parts.length - 1);
    if (remaining.length >= 2) {
      const possibleCommune = remaining[remaining.length - 1];
      if (isSubdivisionName(possibleCommune) && remaining.length >= 2) {
        commune = remaining[remaining.length - 2];
        street = remaining.slice(0, remaining.length - 2).join(", ");
        if (street) street += ", " + possibleCommune;
        else street = possibleCommune;
      } else {
        commune = possibleCommune;
        street = remaining.slice(0, remaining.length - 1).join(", ");
      }
    } else if (remaining.length === 1) {
      commune = remaining[0];
      street = "";
    }
  } else if (parts.length >= 4) {
    province = parts[parts.length - 1];
    district = parts[parts.length - 2];
    const possibleCommune = parts[parts.length - 3];
    if (/metro manila|ncr/i.test(province) && isNCRCity(district)) {
      commune = possibleCommune;
      street = parts.slice(0, parts.length - 3).join(", ");
      district = district.replace(/\bcity\b/gi, "").trim();
    } else {
      commune = possibleCommune;
      street = parts.slice(0, parts.length - 3).join(", ");
    }
    if (isNCRCity(province) && !/metro manila|ncr/i.test(province)) {
      district = province.replace(/\bcity\b/gi, "").trim();
      province = "Metro Manila";
    }
  } else if (parts.length === 3) {
    commune = parts[0];
    district = parts[1];
    province = parts[2];
    if (isNCRCity(province)) { district = province.replace(/\bcity\b/gi, "").trim(); province = "Metro Manila"; }
  } else if (parts.length === 2) {
    district = parts[0];
    province = parts[1];
    if (isNCRCity(province)) { district = province.replace(/\bcity\b/gi, "").trim(); province = "Metro Manila"; }
  } else {
    district = parts[0];
    if (isNCRCity(district)) province = "Metro Manila";
  }

  province = (province || "").replace(/\bcity\b/gi, "").trim();
  district = (district || "").replace(/\bcity\b/gi, "").trim();
  commune = (commune || "").replace(/\bbrgy\.?\s*/gi, "").trim();

  return { street, commune, district, province };
}

// ─── Geo API ──────────────────────────────────────────────────────
let cachedProvinces = null;
const cachedDistricts = {};
const cachedCommunes = {};

async function fetchProvinces() {
  if (cachedProvinces) return cachedProvinces;
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/provinces`, {
      params: { country_code: 63, api_key: PANCAKE_API_KEY }, timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) cachedProvinces = data;
    return data;
  } catch (e) { console.error("fetchProvinces:", e.message); return []; }
}

async function fetchDistricts(provinceId) {
  if (cachedDistricts[provinceId]) return cachedDistricts[provinceId];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/districts`, {
      params: { province_id: provinceId, api_key: PANCAKE_API_KEY }, timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) cachedDistricts[provinceId] = data;
    return data;
  } catch (e) { console.error(`fetchDistricts ${provinceId}:`, e.message); return []; }
}

async function fetchCommunes(districtId, provinceId) {
  const key = `${districtId}_${provinceId}`;
  if (cachedCommunes[key]) return cachedCommunes[key];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/communes`, {
      params: { district_id: districtId, province_id: provinceId, api_key: PANCAKE_API_KEY }, timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) cachedCommunes[key] = data;
    return data;
  } catch (e) { console.error(`fetchCommunes ${districtId}:`, e.message); return []; }
}

async function resolveAddressIds(province, district, commune) {
  try {
    const provinces = await fetchProvinces();
    if (!provinces.length) return null;
    const mp = findBestMatch(provinces, ["name", "name_en"], province);
    if (!mp) return null;
    const districts = await fetchDistricts(mp.id);
    if (!districts.length) return { province_id: mp.id, province_name: mp.name_en || mp.name };
    const md = findBestMatch(districts, ["name", "name_en"], district);
    if (!md) return { province_id: mp.id, province_name: mp.name_en || mp.name };
    let commune_id = null, commune_name = null;
    if (commune) {
      const communes = await fetchCommunes(md.id, mp.id);
      const mc = findBestMatch(communes, ["name", "name_en"], commune);
      if (mc) { commune_id = mc.id; commune_name = mc.name_en || mc.name; }
    }
    return {
      province_id: mp.id, province_name: mp.name_en || mp.name,
      district_id: md.id, district_name: md.name_en || md.name,
      commune_id, commune_name: commune_name || commune
    };
  } catch (e) { console.error("resolveAddressIds:", e.message); return null; }
}

// ─── POS Pancake Order ────────────────────────────────────────────
async function getProductVariation(custom_id) {
  try {
    const res = await axios.get(`${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/products`, {
      params: { api_key: PANCAKE_API_KEY, custom_id }
    });
    const products = res.data?.data || res.data?.products || [];
    const product = Array.isArray(products) ? products.find(p => p.custom_id === custom_id) : null;
    if (!product) return null;
    const variation = product.variations?.[0];
    return { product_id: product.id, variation_id: variation?.id };
  } catch (e) { console.error("getProductVariation:", e.message); return null; }
}

async function createPancakeOrder(orderData) {
  try {
    const { name, phone, address, pack, payment } = orderData;

    // Find pack key from PACK_INFO
    const packKeys = Object.keys(PACK_INFO);
    let packKey = packKeys[0]; // default to first pack
    for (const key of packKeys) {
      if (pack.toLowerCase().includes(key.toLowerCase()) ||
          (PACK_INFO[key].label && pack.toLowerCase().includes(PACK_INFO[key].label.toLowerCase()))) {
        packKey = key;
        break;
      }
    }

    const packInfo = PACK_INFO[packKey];
    const quantity = PACK_QUANTITY[packKey] || 1;

    if (!packInfo) {
      console.error("Pack not found:", pack);
      return null;
    }

    const variation = await getProductVariation(packInfo.custom_id);
    const cleanPhone = phone.replace(/\D/g, "").replace(/^0/, "63");

    const { street, commune, district, province } = parseAddressParts(address);
    const addrIds = await resolveAddressIds(province, district, commune);

    const streetLine = street || commune || address;
    const notePayment = payment.toLowerCase().includes("gcash") ? "GCash" : "COD";

    const shippingAddress = {
      full_name: name,
      phone_number: cleanPhone,
      address: streetLine,
      full_address: address,
      country_code: "63",
      ...(addrIds && {
        province_id: addrIds.province_id,
        province_name: addrIds.province_name,
        district_id: addrIds.district_id,
        district_name: addrIds.district_name,
        commune_id: addrIds.commune_id,
        commune_name: addrIds.commune_name
      })
    };

    const payload = {
      order: {
        bill_full_name: name,
        bill_phone_number: cleanPhone,
        note: `Order via ${BRAND_NAME} Messenger Bot. Payment: ${notePayment}. Pack: ${packInfo.name} x${quantity}. Full address: ${address}`,
        shipping_address: shippingAddress,
        payment_type: payment.toLowerCase().includes("gcash") ? 2 : 1,
        items: [
          variation
            ? { product_id: variation.product_id, variation_id: variation.variation_id, quantity, price: packInfo.price }
            : { name: packInfo.name, quantity, price: packInfo.price }
        ]
      }
    };

    const res = await axios.post(
      `${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/orders`,
      payload,
      { params: { api_key: PANCAKE_API_KEY } }
    );
    console.log("Order created:", res.data?.data?.id);
    return res.data;
  } catch (e) {
    console.error("createPancakeOrder:", e.message);
    return null;
  }
}

// ─── Order Signal Parser ──────────────────────────────────────────
function parseOrderSignal(text) {
  const match = text.match(/\[PROCESS_ORDER:([^\]]+)\]/);
  if (!match) return null;
  const obj = {};
  match[1].split("|").forEach(part => {
    const [k, ...v] = part.split("=");
    if (k) obj[k.trim()] = v.join("=").trim();
  });
  const required = ["name", "phone", "address", "pack", "payment"];
  for (const field of required) {
    if (!obj[field] || obj[field].trim() === "" || obj[field] === "unknown" || obj[field] === "not specified") {
      return null;
    }
  }
  if (obj.phone.replace(/\D/g, "").length < 10) return null;
  if (obj.address.split(",").length < 2) return null;
  return obj;
}

// ─── Dedup & Lock ─────────────────────────────────────────────────
const conversationHistory = {};
const processedOrders = new Set();
const processedMessageIds = new Set();
const processingLock = new Set();
const adminPausedChats = new Set();

// ─── Webhook ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);
  res.sendStatus(200);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      if (!event.message) continue;
      const senderId = event.sender.id;
      const messageText = event.message.text;
      if (!messageText) continue;

      if (event.message.is_echo) {
        const targetUserId = event.recipient?.id;
        if (targetUserId) adminPausedChats.add(targetUserId);
        continue;
      }

      if (adminPausedChats.has(senderId)) continue;

      const messageId = event.message.mid;
      if (messageId) {
        if (processedMessageIds.has(messageId)) continue;
        processedMessageIds.add(messageId);
        setTimeout(() => processedMessageIds.delete(messageId), 10 * 60 * 1000);
      }

      if (processingLock.has(senderId)) continue;
      processingLock.add(senderId);

      try {
        if (!conversationHistory[senderId]) conversationHistory[senderId] = [];
        conversationHistory[senderId].push({ role: "user", content: messageText });
        if (conversationHistory[senderId].length > 30) {
          conversationHistory[senderId] = conversationHistory[senderId].slice(-30);
        }

        const response = await anthropic.messages.create({
          model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: conversationHistory[senderId],
        });

        let reply = response.content[0].text;

        const orderData = parseOrderSignal(reply);
        if (orderData) {
          const orderKey = `${senderId}-${orderData.name}-${orderData.phone}`;
          if (!processedOrders.has(orderKey)) {
            processedOrders.add(orderKey);
            createPancakeOrder(orderData).then(result => {
              if (result?.success || result?.data) {
                console.log("Order created:", result?.data?.id);
              }
            });
          }
          reply = reply.replace(/\[PROCESS_ORDER:[^\]]+\]/g, "").trim();
        }

        conversationHistory[senderId].push({ role: "assistant", content: reply });
        await sendMessage(senderId, reply);

      } catch (err) {
        console.error("Error:", err.message);
        await sendMessage(senderId, "Sorry, may technical issue kami ngayon. Please try again in a bit!");
      } finally {
        processingLock.delete(senderId);
      }
    }
  }
});

// ─── Messenger Send ───────────────────────────────────────────────
async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      { recipient: { id: recipientId }, message: { text: chunk } },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLength));
    start += maxLength;
  }
  return chunks;
}

app.get("/", (req, res) => res.send(`${BRAND_NAME} Claude Bot is running!`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
