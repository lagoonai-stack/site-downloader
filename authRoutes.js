import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { issueSession, clearSession, readSession } from "./session.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Tente novamente mais tarde." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Tente novamente mais tarde." },
});

const GENERIC_LOGIN_MESSAGE =
  "Se este e-mail estiver cadastrado como assinante ativo, voce recebera um codigo de acesso em instantes.";

router.post("/login", loginLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "E-mail invalido." });
  }

  try {
    const { data: status } = await supabaseAdmin.rpc("get_subscriber_status", {
      p_email: email,
    });

    if (status === "active") {
      const { error } = await supabaseAdmin.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) console.error("Erro ao enviar OTP:", error.message);
    }
  } catch (err) {
    console.error("Erro no login:", err.message);
  }

  return res.json({ message: GENERIC_LOGIN_MESSAGE });
});

router.post("/verify", verifyLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();

  if (!EMAIL_RE.test(email) || !code) {
    return res.status(400).json({ error: "Dados invalidos." });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });

    if (error || !data?.user) {
      return res.status(401).json({ error: "Codigo invalido ou expirado." });
    }

    const { data: status } = await supabaseAdmin.rpc("get_subscriber_status", {
      p_email: email,
    });

    if (status !== "active") {
      return res.status(401).json({ error: "Assinatura nao encontrada ou inativa." });
    }

    issueSession(res, email);
    return res.json({ message: "Login realizado com sucesso." });
  } catch (err) {
    console.error("Erro na verificacao:", err.message);
    return res.status(500).json({ error: "Erro ao verificar codigo." });
  }
});

// Cobre quem clica no link do e-mail (Supabase valida com ele mesmo e
// redireciona de volta com um access_token no fragmento da URL) em vez
// de digitar o codigo. O token vem do proprio Supabase Auth - so
// confirmamos que ele e valido e pertence a um e-mail com assinatura
// ativa antes de abrir nossa propria sessao.
router.post("/session-from-token", verifyLimiter, async (req, res) => {
  const accessToken = String(req.body?.access_token || "");
  if (!accessToken) {
    return res.status(400).json({ error: "Token ausente." });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !data?.user?.email) {
      return res.status(401).json({ error: "Token invalido ou expirado." });
    }
    const email = data.user.email.toLowerCase();

    const { data: status } = await supabaseAdmin.rpc("get_subscriber_status", {
      p_email: email,
    });

    if (status !== "active") {
      return res.status(401).json({ error: "Assinatura nao encontrada ou inativa." });
    }

    issueSession(res, email);
    return res.json({ message: "Login realizado com sucesso." });
  } catch (err) {
    console.error("Erro ao validar token de sessao:", err.message);
    return res.status(500).json({ error: "Erro ao validar token." });
  }
});

router.post("/logout", (req, res) => {
  clearSession(res);
  res.json({ message: "Sessao encerrada." });
});

router.get("/me", (req, res) => {
  res.json({ authenticated: !!readSession(req) });
});

export default router;
