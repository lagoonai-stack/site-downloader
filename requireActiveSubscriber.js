import { supabaseAdmin } from "./supabaseAdmin.js";
import { readSession, clearSession } from "./session.js";

// Default-deny: qualquer rota que passar por este middleware sem uma
// assinatura ativa e recusada. O status e sempre reconferido no
// Supabase a cada requisicao (nao confia so no cookie) para que um
// cancelamento/reembolso vindo do webhook da Kiwify derrube o acesso
// imediatamente, sem esperar o cookie expirar.
export async function requireActiveSubscriber(req, res, next) {
  const deny = () => {
    if (req.accepts(["html", "json"]) === "html") {
      return res.redirect("/login.html");
    }
    return res.status(401).json({ error: "Nao autenticado." });
  };

  const session = readSession(req);
  if (!session) return deny();

  const { data: status, error } = await supabaseAdmin.rpc("get_subscriber_status", {
    p_email: session.email,
  });

  if (error) {
    console.error("Erro ao verificar assinante:", error.message);
    return res.status(500).json({ error: "Erro interno." });
  }

  if (status !== "active") {
    clearSession(res);
    return deny();
  }

  next();
}
