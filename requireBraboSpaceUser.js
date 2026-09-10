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
//
// Alguns paineis de deploy (Dokploy incluso) guardam o valor exatamente como foi colado no
// campo - aspas em volta do valor inteiro, virgula sobrando no final, etc. viram parte da
// string e quebrariam a comparacao de e-mail silenciosamente. Limpa esses casos comuns em
// vez de exigir que o valor esteja perfeito.
function parseAllowedEmails(raw) {
  const stripped = (raw || "").trim().replace(/^['"]|['"]$/g, "");
  return stripped
    .split(/[,;\n]/)
    .map((e) => e.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean);
}

const ALLOWED_EMAILS = parseAllowedEmails(process.env.ALLOWED_EMAILS);

if (ALLOWED_EMAILS.length === 0) {
  throw new Error("ALLOWED_EMAILS precisa estar definido no .env (lista separada por virgula).");
}

// So a contagem e um pedacinho de cada e-mail (nunca o e-mail completo) - da pra conferir nos
// logs do Dokploy se a variavel chegou certa no container sem expor a lista inteira em texto
// puro no log.
console.log(
  `[auth] ALLOWED_EMAILS carregado: ${ALLOWED_EMAILS.length} endereco(s) - ` +
    ALLOWED_EMAILS.map((e) => e.slice(0, 3) + "***@" + e.split("@")[1]).join(", ")
);

export async function requireBraboSpaceUser(req, res, next) {
  const authHeader = req.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Nao autenticado." });
  }

  const { data, error } = await braboSpaceAuth.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();

  if (error || !email || !ALLOWED_EMAILS.includes(email)) {
    // So no log do servidor (nunca na resposta) - ajuda a diferenciar "token
    // invalido/expirado" de "email valido mas fora da lista" sem expor nada
    // pro cliente.
    console.warn(
      `[auth] acesso negado - ${error ? `token invalido/expirado (${error.message})` : email ? `e-mail "${email}" nao esta em ALLOWED_EMAILS` : "sessao sem e-mail"}`
    );
    return res.status(403).json({ error: "Acesso nao autorizado." });
  }

  // Usado por historico de downloads e report de erros pra saber de quem e
  // cada registro (filtrar "meus downloads", por exemplo).
  req.userEmail = email;
  next();
}
