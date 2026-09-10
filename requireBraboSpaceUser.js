import { createClient } from "@supabase/supabase-js";

const { BRABOSPACE_SUPABASE_URL, BRABOSPACE_SUPABASE_ANON_KEY } = process.env;

if (!BRABOSPACE_SUPABASE_URL || !BRABOSPACE_SUPABASE_ANON_KEY) {
  throw new Error(
    "BRABOSPACE_SUPABASE_URL e BRABOSPACE_SUPABASE_ANON_KEY precisam estar definidos no .env"
  );
}

// Cliente separado do supabaseAdmin.js: aponta para o projeto Supabase da BraboSpace, que é
// DIFERENTE do projeto Supabase deste app (site-downloader). Serve só para validar o token de
// sessão que o front da BraboSpace já tem em mãos - não faz login nenhum por conta própria.
const braboSpaceAuth = createClient(BRABOSPACE_SUPABASE_URL, BRABOSPACE_SUPABASE_ANON_KEY);

// Mesma lista de src/lib/downloaderAccess.ts no repo da brabo-academy - manter as duas em
// sincronia. Vem do .env (nao fica hardcoded no codigo-fonte) porque esse repo e publico no
// GitHub - e-mail pessoal de gente de verdade nao deveria estar visivel pra qualquer um que
// abrir o repo.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

if (ALLOWED_EMAILS.length === 0) {
  throw new Error("ALLOWED_EMAILS precisa estar definido no .env (lista separada por virgula).");
}

export async function requireBraboSpaceUser(req, res, next) {
  const authHeader = req.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Nao autenticado." });
  }

  const { data, error } = await braboSpaceAuth.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();

  if (error || !email || !ALLOWED_EMAILS.includes(email)) {
    return res.status(403).json({ error: "Acesso nao autorizado." });
  }

  // Usado por historico de downloads e report de erros pra saber de quem e
  // cada registro (filtrar "meus downloads", por exemplo).
  req.userEmail = email;
  next();
}
