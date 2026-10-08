// FinancePRO — relais Enable Banking (Supabase Edge Function "bank")
//
// La clé privée Enable Banking ne quitte jamais ce serveur : l'app appelle
// cette fonction avec le jeton Supabase de l'utilisateur connecté, la fonction
// vérifie l'utilisateur, signe un JWT et interroge l'API Enable Banking.
//
// Secrets à définir (Supabase → Edge Functions → Secrets) :
//   ENABLE_BANKING_APP_ID       identifiant de l'application Enable Banking
//   ENABLE_BANKING_PRIVATE_KEY  contenu du fichier .pem téléchargé
//   ALLOWED_USER_IDS            id(s) Supabase autorisé(s), séparés par des virgules
//   ALLOWED_ORIGINS             (optionnel) défaut : https://lo30cha.github.io
// SUPABASE_URL et SUPABASE_ANON_KEY sont fournis automatiquement par Supabase.

const env = (k: string) => (Deno.env.get(k) || "").trim();

const EB_API = () => env("ENABLE_BANKING_API") || "https://api.enablebanking.com";
const ORIGINS = () =>
  (env("ALLOWED_ORIGINS") || "https://lo30cha.github.io")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const USERS = () => env("ALLOWED_USER_IDS").split(",").map((s) => s.trim()).filter(Boolean);

function cors(origin: string | null): Record<string, string> {
  const allowed = origin && ORIGINS().includes(origin) ? origin : ORIGINS()[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

// ---------- JWT RS256 ----------
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

function derLen(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return new Uint8Array([0x80 | out.length, ...out]);
}
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Enveloppe une clé PKCS#1 ("BEGIN RSA PRIVATE KEY") en PKCS#8.
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const octet = concat(new Uint8Array([0x04]), derLen(pkcs1.length), pkcs1);
  const body = concat(version, algId, octet);
  return concat(new Uint8Array([0x30]), derLen(body.length), body);
}

let keyCache: { pem: string; key: CryptoKey } | null = null;
async function privateKey(): Promise<CryptoKey> {
  const pem = env("ENABLE_BANKING_PRIVATE_KEY").replace(/\\n/g, "\n");
  if (!pem) throw new HttpError(500, "ENABLE_BANKING_PRIVATE_KEY manquant");
  if (keyCache && keyCache.pem === pem) return keyCache.key;
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const der = isPkcs1 ? pkcs1ToPkcs8(raw) : raw;
  const key = await crypto.subtle.importKey(
    "pkcs8", der as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  keyCache = { pem, key };
  return key;
}

async function ebJwt(): Promise<string> {
  const appId = env("ENABLE_BANKING_APP_ID");
  if (!appId) throw new HttpError(500, "ENABLE_BANKING_APP_ID manquant");
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const body = b64urlStr(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await privateKey(), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

async function eb(method: string, path: string, body?: unknown) {
  const res = await fetch(EB_API() + path, {
    method,
    headers: { Authorization: `Bearer ${await ebJwt()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const d = data as Record<string, unknown> | null;
    const msg = (d && typeof d === "object" && (d.message || d.error)) || `Enable Banking ${res.status}`;
    throw new HttpError(res.status === 401 || res.status === 403 ? 502 : res.status, String(msg), data);
  }
  return data as any;
}

// ---------- Utilisateur Supabase ----------
async function verifyUser(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Non connecté");
  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anon || req.headers.get("apikey") || "" },
  });
  if (!res.ok) throw new HttpError(401, "Session invalide");
  const user = await res.json();
  const allowed = USERS();
  if (!allowed.length) throw new HttpError(403, "ALLOWED_USER_IDS non configuré");
  if (!user?.id || !allowed.includes(user.id)) throw new HttpError(403, "Utilisateur non autorisé");
  return user.id;
}

// ---------- Normalisation ----------
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64url(h).slice(0, 20);
}

function maskIban(iban?: string) {
  if (!iban) return "";
  const s = iban.replace(/\s+/g, "");
  return s.length > 8 ? `${s.slice(0, 4)} •••• ${s.slice(-4)}` : s;
}

async function normalizeTx(t: any) {
  const amt = parseFloat(t?.transaction_amount?.amount ?? "0") || 0;
  const signed = t?.credit_debit_indicator === "DBIT" ? -Math.abs(amt) : Math.abs(amt);
  const date = t.booking_date || t.value_date || t.transaction_date || "";
  const ri = Array.isArray(t.remittance_information) ? t.remittance_information.join(" ") : (t.remittance_information || "");
  const counterparty = (signed < 0 ? t?.creditor?.name : t?.debtor?.name) || "";
  const label = (ri || counterparty || t.bank_transaction_code?.description || "Opération").replace(/\s+/g, " ").trim();
  const id = t.entry_reference || t.transaction_id ||
    await sha([date, signed.toFixed(2), label, t.value_date || ""].join("|"));
  return {
    id: String(id),
    date,
    amount: Math.round(signed * 100) / 100,
    currency: t?.transaction_amount?.currency || "EUR",
    label,
    counterparty,
    status: t.status || "BOOK",
  };
}

// ---------- Actions ----------
const DAY = 86400;

async function actAspsps(p: any) {
  const psu = p.psu_type === "business" ? "business" : "personal";
  const data = await eb("GET", `/aspsps?country=${encodeURIComponent(p.country || "FR")}&psu_type=${psu}`);
  const q = String(p.query ?? "Crédit Agricole").toLowerCase();
  const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const list = (data?.aspsps || [])
    .filter((a: any) => !q || strip(a.name).includes(strip(q)))
    .map((a: any) => ({
      name: a.name,
      country: a.country,
      logo: a.logo || "",
      max_days: Math.floor((a.maximum_consent_validity || 90 * DAY) / DAY),
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name, "fr"));
  return { aspsps: list };
}

function checkRedirect(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new HttpError(400, "redirect_url invalide"); }
  if (!ORIGINS().includes(u.origin)) throw new HttpError(400, "redirect_url non autorisée");
  return u.toString();
}

async function actStart(p: any) {
  if (!p.aspsp?.name) throw new HttpError(400, "Banque manquante");
  if (!p.state || String(p.state).length < 16) throw new HttpError(400, "state manquant");
  const redirect = checkRedirect(String(p.redirect_url || ""));
  const maxDays = Math.max(1, Math.min(180, Number(p.max_days) || 90));
  const validUntil = new Date(Date.now() + maxDays * DAY * 1000).toISOString();
  const data = await eb("POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: { name: p.aspsp.name, country: p.aspsp.country || "FR" },
    state: String(p.state),
    redirect_url: redirect,
    psu_type: p.psu_type === "business" ? "business" : "personal",
  });
  return { url: data.url, authorization_id: data.authorization_id };
}

async function actSession(p: any) {
  if (!p.code) throw new HttpError(400, "code manquant");
  const data = await eb("POST", "/sessions", { code: String(p.code) });
  const accounts = [];
  for (const a of data.accounts || []) {
    accounts.push({
      uid: a.uid,
      // Identifiant stable d'un consentement à l'autre (l'uid change à chaque nouvelle session)
      key: (a.identification_hash || await sha(a.account_id?.iban || a.uid || "")).slice(0, 12),
      name: a.name || a.product || a.details || "Compte",
      iban: maskIban(a.account_id?.iban),
      currency: a.currency || "EUR",
      product: a.product || "",
    });
  }
  return {
    session_id: data.session_id,
    valid_until: data.access?.valid_until || null,
    aspsp: data.aspsp || null,
    accounts,
  };
}

const UID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function actTransactions(p: any) {
  const uid = String(p.account_uid || "");
  if (!UID_RE.test(uid)) throw new HttpError(400, "account_uid invalide");
  const from = DATE_RE.test(p.date_from || "") ? p.date_from : new Date(Date.now() - 90 * DAY * 1000).toISOString().slice(0, 10);
  const out: any[] = [];
  let key: string | null = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ date_from: from });
    if (DATE_RE.test(p.date_to || "")) qs.set("date_to", p.date_to);
    if (key) qs.set("continuation_key", key);
    const data = await eb("GET", `/accounts/${encodeURIComponent(uid)}/transactions?${qs}`);
    for (const t of data.transactions || []) out.push(await normalizeTx(t));
    key = data.continuation_key || null;
    if (!key) break;
  }
  return { transactions: out };
}

async function actBalances(p: any) {
  const uid = String(p.account_uid || "");
  if (!UID_RE.test(uid)) throw new HttpError(400, "account_uid invalide");
  const data = await eb("GET", `/accounts/${encodeURIComponent(uid)}/balances`);
  const list = (data.balances || []).map((b: any) => ({
    type: b.balance_type,
    amount: parseFloat(b.balance_amount?.amount ?? "0") || 0,
    currency: b.balance_amount?.currency || "EUR",
    date: b.reference_date || b.last_change_date_time || null,
  }));
  // Préférence : solde comptable clôturé, puis disponible, puis le premier.
  const pref = ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV"];
  const best = pref.map((t) => list.find((b: any) => b.type === t)).find(Boolean) || list[0] || null;
  return { balances: list, balance: best };
}

async function actDeleteSession(p: any) {
  const sid = String(p.session_id || "");
  if (!UID_RE.test(sid)) throw new HttpError(400, "session_id invalide");
  await eb("DELETE", `/sessions/${encodeURIComponent(sid)}`);
  return { ok: true };
}

const ACTIONS: Record<string, (p: any) => Promise<unknown>> = {
  aspsps: actAspsps,
  start: actStart,
  session: actSession,
  transactions: actTransactions,
  balances: actBalances,
  delete_session: actDeleteSession,
};

export async function handler(req: Request): Promise<Response> {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  try {
    if (req.method !== "POST") throw new HttpError(405, "POST attendu");
    await verifyUser(req);
    const payload = await req.json().catch(() => ({}));
    const fn = ACTIONS[String(payload?.action || "")];
    if (!fn) throw new HttpError(400, "Action inconnue");
    const result = await fn(payload);
    return new Response(JSON.stringify(result), { headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof Error ? e.message : "Erreur";
    if (!(e instanceof HttpError)) console.error(e);
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
}

if (!Deno.env.get("FINANCEPRO_TEST")) Deno.serve(handler);
