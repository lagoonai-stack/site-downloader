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

// Mesma lista de src/lib/downloaderAccess.ts no repo da brabo-academy - manter as duas em sincronia.
const ALLOWED_EMAILS = [
  "neveskarolina6@gmail.com",
  "lagoon.auto.ai@gmail.com",
  "guilhermegrasso@gmail.com",
  "obrabodosvideos@gmail.com",
];

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

  next();
}
