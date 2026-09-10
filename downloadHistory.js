import crypto from "crypto";
import { supabaseAdmin } from "./supabaseAdmin.js";

// Bucket privado no Supabase Storage deste app (nao o da BraboSpace) -
// precisa ser criado manualmente no dashboard, ver SETUP.md.
const BUCKET = "download-history";

function slugEmail(email) {
  return String(email || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
}

// Grava uma linha de historico e, se o download deu certo, sobe o zip pro
// Storage antes - assim quem consultar o historico consegue re-baixar sem
// raspar o site de novo. Downloads com erro/cancelados tambem viram linha
// (sem storage_path), pra dar contexto de "o que aconteceu" no historico.
export async function saveDownloadHistory({ userEmail, url, mode, status, buffer, fileName, errorMessage }) {
  let storagePath = null;
  let fileSize = null;

  if (status === "success" && buffer) {
    storagePath = `${slugEmail(userEmail)}/${crypto.randomUUID()}-${fileName}`;
    fileSize = buffer.length;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType: "application/zip", upsert: false });
    if (uploadError) throw new Error(`Falha no upload pro storage: ${uploadError.message}`);
  }

  const { error } = await supabaseAdmin.rpc("insert_download_history", {
    p_user_email: userEmail,
    p_url: url,
    p_mode: mode,
    p_status: status,
    p_storage_path: storagePath,
    p_file_name: fileName ?? null,
    p_file_size: fileSize,
    p_error_message: errorMessage ?? null,
  });
  if (error) throw new Error(`Falha ao gravar historico: ${error.message}`);
}

export async function listDownloadHistory({ userEmail, limit = 50, offset = 0 }) {
  const { data, error } = await supabaseAdmin.rpc("list_download_history", {
    p_user_email: userEmail,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Devolve um signed URL fresco (expira em 5min) pro arquivo de um registro
// do historico - nunca expomos o storage_path cru pro cliente. Confere
// posse (p_user_email) dentro da propria funcao RPC.
export async function getDownloadHistorySignedUrl({ userEmail, id, expiresIn = 300 }) {
  const { data: entry, error } = await supabaseAdmin
    .rpc("get_download_history_entry", { p_id: id, p_user_email: userEmail })
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!entry || !entry.storage_path) return null;

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(entry.storage_path, expiresIn, { download: entry.file_name ?? true });
  if (signError) throw new Error(signError.message);

  return {
    url: signed.signedUrl,
    fileName: entry.file_name,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export async function deleteDownloadHistoryEntry({ userEmail, id }) {
  const { data: entry, error } = await supabaseAdmin
    .rpc("get_download_history_entry", { p_id: id, p_user_email: userEmail })
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!entry) return false;

  if (entry.storage_path) {
    await supabaseAdmin.storage.from(BUCKET).remove([entry.storage_path]);
  }
  const { error: deleteError } = await supabaseAdmin.rpc("delete_download_history", {
    p_id: id,
    p_user_email: userEmail,
  });
  if (deleteError) throw new Error(deleteError.message);
  return true;
}
