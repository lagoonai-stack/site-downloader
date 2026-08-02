import { Router } from "express";
import crypto from "crypto";
import { supabaseAdmin } from "./supabaseAdmin.js";

const router = Router();

const ACTIVE_STATUSES = new Set(["paid", "approved"]);
const INACTIVE_STATUSES = new Set([
  "refunded",
  "refused",
  "chargedback",
  "canceled",
  "cancelled",
  "expired",
]);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function extractIncomingToken(req) {
  return req.query?.token ?? req.body?.token ?? req.get("x-kiwify-token");
}

router.post("/kiwify", (req, res) => {
  const expected = process.env.KIWIFY_WEBHOOK_TOKEN;
  const incoming = extractIncomingToken(req);
  const tokenValid = Boolean(expected) && Boolean(incoming) && safeEqual(incoming, expected);

  if (!tokenValid) {
    logKiwifyWebhook({ tokenValid: false, payload: req.body ?? {} });
    return res.status(401).json({ error: "Token invalido." });
  }
  res.status(200).json({ received: true });

  handleKiwifyEvent(req.body).catch((err) =>
    console.error("Erro ao processar webhook Kiwify:", err.message)
  );
});
async function logKiwifyWebhook({ tokenValid, eventStatus = null, customerEmail = null, payload, processingError = null }) {
  const { error } = await supabaseAdmin.rpc("log_kiwify_webhook", {
    p_token_valid: tokenValid,
    p_event_status: eventStatus,
    p_customer_email: customerEmail,
    p_payload: payload ?? {},
    p_processing_error: processingError,
  });
  if (error) console.error("Erro ao gravar log do webhook:", error.message);
}

async function handleKiwifyEvent(payload) {
  const email = payload?.Customer?.email ?? payload?.customer?.email;
  const rawStatus = String(
    payload?.order_status ?? payload?.Subscription?.status ?? ""
  ).toLowerCase();
  const status = ACTIVE_STATUSES.has(rawStatus)
    ? "active"
    : INACTIVE_STATUSES.has(rawStatus)
    ? "canceled"
    : "inactive";

  if (!email || typeof email !== "string") {
    console.warn("Webhook Kiwify recebido sem e-mail de cliente reconhecivel.");
    await logKiwifyWebhook({
      tokenValid: true,
      eventStatus: rawStatus,
      payload,
      processingError: "e-mail do cliente nao encontrado no payload",
    });
    return;
  }

  const { error } = await supabaseAdmin.rpc("kiwify_upsert_subscriber", {
    p_email: email.trim().toLowerCase(),
    p_status: status,
    p_kiwify_order_id: payload?.order_id ?? null,
    p_kiwify_subscription_id: payload?.Subscription?.id ?? null,
    p_product_name: payload?.Product?.product_name ?? payload?.product?.name ?? null,
  });

  await logKiwifyWebhook({
    tokenValid: true,
    eventStatus: rawStatus,
    customerEmail: email,
    payload,
    processingError: error?.message ?? null,
  });

  if (error) console.error("Erro ao gravar assinante no Supabase:", error.message);
}

export default router;
