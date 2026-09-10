import crypto from "crypto";
import { supabaseAdmin } from "./supabaseAdmin.js";

// Bucket privado no Supabase Storage deste app - precisa ser criado
// manualmente no dashboard, ver SETUP.md. Revisao dos reports e feita via
// SQL direto (mesmo padrao ja usado pra conferir kiwify_webhook_logs) -
// nao foi pedido painel de admin, entao nao construimos um.
const BUCKET = "error-reports";

function slugEmail(email) {
  return String(email || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
}

function extensionForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

export async function saveErrorReport({ userEmail, url, description, screenshotBuffer, screenshotMime }) {
  let screenshotPath = null;

  if (screenshotBuffer) {
    screenshotPath = `${slugEmail(userEmail)}/${crypto.randomUUID()}.${extensionForMime(screenshotMime)}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(screenshotPath, screenshotBuffer, { contentType: screenshotMime, upsert: false });
    if (uploadError) throw new Error(`Falha no upload do print: ${uploadError.message}`);
  }

  const { data, error } = await supabaseAdmin.rpc("insert_error_report", {
    p_user_email: userEmail,
    p_url: url,
    p_description: description,
    p_screenshot_path: screenshotPath,
  });
  if (error) throw new Error(`Falha ao gravar report: ${error.message}`);
  return data;
}
