/* =====================================================================
   Power Pump Men 2.0 — servidor de pagos (Mercado Pago Checkout Pro)
   Corre como Railway Function (Bun). Un solo archivo, sin dependencias.

   Variables de entorno (Railway → servicio → Variables):
     MP_ACCESS_TOKEN       Access Token de producción de Mercado Pago (secreto)
     MP_WEBHOOK_SECRET     Clave secreta de Webhooks de Mercado Pago (opcional, recomendado)
     ADMIN_EMAIL           Email que recibe el aviso de cada pago aprobado
     SITE_URL              URL pública de la tienda (sin barra final)
     ALLOWED_ORIGINS       Orígenes permitidos para CORS, separados por coma
     STATEMENT_DESCRIPTOR  Texto que ve el cliente en el resumen de la tarjeta
   ===================================================================== */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const env = Bun.env;
const MP_API = "https://api.mercadopago.com";
const SITE_URL = (env.SITE_URL || "https://matirodi.github.io/descubri-tu-placer").replace(/\/+$/, "");
const SITE_ORIGIN = new URL(SITE_URL).origin;
const PUBLIC_URL = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/+$/, "");
const ORIGINS = (env.ALLOWED_ORIGINS || `${SITE_ORIGIN},http://localhost:5173,http://127.0.0.1:5173`)
  .split(",").map(s => s.trim()).filter(Boolean);
const DESCRIPTOR = (env.STATEMENT_DESCRIPTOR || "DTP TIENDA").slice(0, 22);

/* Precios y envíos: la única fuente de verdad. El navegador solo manda el id del kit y la provincia. */
const KITS: Record<string, { name: string; price: number }> = {
  starter: { name: "Kit Starter", price: 24900 },
  power: { name: "Power 2.0 Original", price: 34900 },
  elite: { name: "Elite Bundle", price: 54900 },
};
const SHIPPING: Record<string, number> = {
  "CABA": 2500, "GBA": 3000, "Buenos Aires Interior": 3800, "Córdoba": 4000, "Santa Fe": 4000,
  "Entre Ríos": 4200, "Mendoza": 4500, "San Luis": 4500, "La Pampa": 4500, "Misiones": 4800,
  "Corrientes": 4800, "Chaco": 4800, "Formosa": 4800, "Tucumán": 4800, "Salta": 5000, "Jujuy": 5000,
  "Santiago del Estero": 5000, "Catamarca": 5200, "La Rioja": 5200, "San Juan": 5200, "Neuquén": 5500,
  "Río Negro": 5500, "Chubut": 6000, "Santa Cruz": 6500, "Tierra del Fuego": 7000,
};

/* ─── utilidades ─── */
const money = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");

function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.normalize("NFC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!ORIGINS.includes(origin)) return { "Vary": "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

/* Límite simple por IP (en memoria) */
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10000) hits.clear();
  return list.length > max;
}

function clientIp(req: Request, server: { requestIP(r: Request): { address: string } | null }) {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || server.requestIP(req)?.address || "?";
}

async function mp(path: string, init: RequestInit = {}) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) throw new Error("MP_ACCESS_TOKEN no configurado");
  const res = await fetch(MP_API + path, {
    ...init,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[mp] ${init.method || "GET"} ${path} → ${res.status}`, JSON.stringify(body).slice(0, 400));
    throw new Error(`Mercado Pago respondió ${res.status}`);
  }
  return body as any;
}

/* ─── POST /api/checkout ─── */
async function createCheckout(req: Request) {
  if (!env.MP_ACCESS_TOKEN) return json({ error: "Los pagos todavía no están configurados. Escribinos y te ayudamos con tu compra." }, 503);
  if (Number(req.headers.get("content-length") || 0) > 8000) return json({ error: "Solicitud demasiado grande." }, 413);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Datos inválidos." }, 400); }
  if (clean(b.website, 50)) return json({ error: "Datos inválidos." }, 400); // honeypot anti-bots

  const kitId = clean(b.kit, 20);
  const kit = KITS[kitId];
  const d = {
    nombre: clean(b.nombre, 60),
    apellido: clean(b.apellido, 60),
    email: clean(b.email, 120).toLowerCase(),
    telefono: clean(b.telefono, 30),
    provincia: clean(b.provincia, 40),
    ciudad: clean(b.ciudad, 80),
    cp: clean(b.cp, 10),
    direccion: clean(b.direccion, 120),
    piso: clean(b.piso, 40),
  };
  const ship = SHIPPING[d.provincia];
  const errors: string[] = [];
  if (!kit) errors.push("kit");
  if (!d.nombre) errors.push("nombre");
  if (!d.apellido) errors.push("apellido");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errors.push("email");
  if (!/^[0-9+()\-\s]{8,30}$/.test(d.telefono)) errors.push("telefono");
  if (ship === undefined) errors.push("provincia");
  if (!d.ciudad) errors.push("ciudad");
  if (!/^[A-Za-z0-9]{3,10}$/.test(d.cp)) errors.push("cp");
  if (!d.direccion) errors.push("direccion");
  if (errors.length) return json({ error: "Revisá los datos del formulario.", fields: errors }, 400);

  const total = kit.price + ship;
  const ref = `PPM-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;

  const pref = await mp("/checkout/preferences", {
    method: "POST",
    headers: { "X-Idempotency-Key": ref },
    body: JSON.stringify({
      items: [
        { id: kitId, title: `${kit.name} · pedido ${ref}`, description: "Producto de bienestar", quantity: 1, unit_price: kit.price, currency_id: "ARS" },
        { id: "envio", title: `Envío a ${d.provincia}`, quantity: 1, unit_price: ship, currency_id: "ARS" },
      ],
      payer: { name: d.nombre, surname: d.apellido, email: d.email },
      external_reference: ref,
      statement_descriptor: DESCRIPTOR,
      back_urls: {
        success: `${SITE_URL}/pago.html`,
        pending: `${SITE_URL}/pago.html`,
        failure: `${SITE_URL}/pago.html`,
      },
      auto_return: "approved",
      ...(PUBLIC_URL ? { notification_url: `${PUBLIC_URL}/api/webhook` } : {}),
      expires: true,
      expiration_date_from: new Date(Date.now() - 60 * 1000).toISOString(),
      expiration_date_to: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      metadata: {
        order_ref: ref, kit: kitId, kit_name: kit.name, precio: kit.price, envio: ship, total,
        nombre: d.nombre, apellido: d.apellido, email: d.email, telefono: d.telefono,
        provincia: d.provincia, ciudad: d.ciudad, cp: d.cp, direccion: d.direccion, piso: d.piso,
      },
    }),
  });

  console.log(`[pedido] ${ref} creado · ${kit.name} · total ${money(total)}`);
  return json({ url: pref.init_point, ref, total });
}

/* ─── Firma de webhooks (x-signature) ─── */
function validSignature(header: string, requestId: string | null, dataId: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=").map(s => s.trim())));
  const ts = parts.ts, v1 = parts.v1;
  if (!ts || !v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  let manifest = "";
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ─── Aviso por email de pagos aprobados ─── */
const notified = new Set<string>();

async function notifyApproved(pay: any) {
  const m = pay.metadata || {};
  const to = env.ADMIN_EMAIL;
  console.log(`[pago] ${m.order_ref || pay.external_reference} aprobado · pago ${pay.id} · ${money(pay.transaction_amount)}`);
  if (!to) return;
  const direccion = `${m.direccion || ""}${m.piso ? ", " + m.piso : ""}, ${m.ciudad || ""}, ${m.provincia || ""} (CP ${m.cp || ""})`;
  const payload = {
    _subject: `Pago aprobado ${m.order_ref || ""} — ${m.kit_name || ""} — ${money(pay.transaction_amount)}`,
    _template: "table",
    _captcha: "false",
    Pedido: m.order_ref || pay.external_reference,
    Producto: m.kit_name,
    Precio: money(m.precio || 0),
    Envio: money(m.envio || 0),
    Total_cobrado: money(pay.transaction_amount),
    Pago_Mercado_Pago: String(pay.id),
    Medio_de_pago: `${pay.payment_method_id || ""} (${pay.payment_type_id || ""}) · ${pay.installments || 1} cuota/s`,
    Nombre: `${m.nombre || ""} ${m.apellido || ""}`.trim(),
    email: m.email,
    Telefono: m.telefono,
    Direccion: direccion,
    _autoresponse:
      `¡Gracias por tu compra, ${m.nombre || ""}! Recibimos el pago de tu pedido ${m.order_ref || ""} ` +
      `(${m.kit_name || "Power Pump Men 2.0"}, total ${money(pay.transaction_amount)}). ` +
      `Lo despachamos en un embalaje 100% discreto y te escribimos con el seguimiento. — Descubrí Tu Placer`,
  };
  try {
    const r = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": SITE_ORIGIN, "Referer": `${SITE_URL}/` },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error(`[email] FormSubmit respondió ${r.status}`);
  } catch (e) {
    console.error("[email] no se pudo enviar el aviso", e);
  }
}

/* ─── POST /api/webhook ─── */
async function webhook(req: Request, url: URL) {
  const raw = await req.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* algunas notificaciones llegan solo por query */ }
  const type = url.searchParams.get("type") || url.searchParams.get("topic") || body.type || body.topic;
  const dataId = String(url.searchParams.get("data.id") || body?.data?.id || url.searchParams.get("id") || "");
  if (type !== "payment" || !/^\d{1,20}$/.test(dataId)) return new Response("ok");

  const secret = env.MP_WEBHOOK_SECRET;
  const sig = req.headers.get("x-signature");
  if (secret && sig && !validSignature(sig, req.headers.get("x-request-id"), dataId, secret)) {
    console.warn(`[webhook] firma inválida para el pago ${dataId}`);
    return new Response("invalid signature", { status: 401 });
  }

  // Nunca se confía en el contenido del aviso: el estado se consulta directo a Mercado Pago.
  const pay = await mp(`/v1/payments/${dataId}`);
  if (!String(pay.external_reference || "").startsWith("PPM-")) return new Response("ok");
  console.log(`[webhook] pago ${pay.id} · ${pay.external_reference} · ${pay.status}/${pay.status_detail}`);
  if (pay.status === "approved" && !notified.has(String(pay.id))) {
    notified.add(String(pay.id));
    await notifyApproved(pay);
  }
  return new Response("ok");
}

/* ─── GET /api/payment-status ─── */
async function paymentStatus(url: URL) {
  const id = url.searchParams.get("payment_id") || "";
  const ref = url.searchParams.get("ref") || "";
  if (!/^\d{1,20}$/.test(id) || !/^PPM-[A-Z0-9-]{4,40}$/.test(ref)) return json({ error: "Parámetros inválidos." }, 400);
  const pay = await mp(`/v1/payments/${id}`);
  if (pay.external_reference !== ref) return json({ error: "Pago no encontrado." }, 404);
  const m = pay.metadata || {};
  return json({
    status: pay.status,
    status_detail: pay.status_detail,
    ref,
    kit: m.kit || null,
    kit_name: m.kit_name || null,
    total: pay.transaction_amount,
    payment_type: pay.payment_type_id,
  });
}

/* ─── servidor ─── */
const server = Bun.serve({
  port: Number(env.PORT || 3000),
  async fetch(req, srv) {
    const url = new URL(req.url);
    const c = cors(req);
    const sec = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
    const out = (r: Response) => { for (const [k, v] of Object.entries({ ...c, ...sec })) r.headers.set(k, v); return r; };

    try {
      if (req.method === "OPTIONS") return out(new Response(null, { status: 204 }));

      if (url.pathname === "/" || url.pathname === "/health") {
        return out(json({ ok: true, servicio: "pagos Power Pump Men 2.0", mercadoPago: Boolean(env.MP_ACCESS_TOKEN), webhooks: Boolean(PUBLIC_URL) }));
      }

      if (url.pathname === "/api/checkout" && req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && !ORIGINS.includes(origin)) return out(json({ error: "Origen no permitido." }, 403));
        if (limited("co:" + clientIp(req, srv), 8, 10 * 60 * 1000)) return out(json({ error: "Demasiados intentos. Probá de nuevo en unos minutos." }, 429));
        return out(await createCheckout(req));
      }

      if (url.pathname === "/api/webhook" && req.method === "POST") {
        return out(await webhook(req, url));
      }

      if (url.pathname === "/api/payment-status" && req.method === "GET") {
        if (limited("st:" + clientIp(req, srv), 30, 10 * 60 * 1000)) return out(json({ error: "Demasiadas consultas." }, 429));
        return out(await paymentStatus(url));
      }

      return out(json({ error: "No encontrado." }, 404));
    } catch (e: any) {
      console.error("[error]", url.pathname, e?.message || e);
      // En webhooks, un 500 hace que Mercado Pago reintente más tarde.
      return out(json({ error: "No pudimos procesar el pago en este momento. Probá de nuevo en unos minutos." }, url.pathname === "/api/webhook" ? 500 : 502));
    }
  },
});

console.log(`[pagos] escuchando en :${server.port} · sitio ${SITE_URL} · webhooks ${PUBLIC_URL ? PUBLIC_URL + "/api/webhook" : "sin dominio público"}`);
