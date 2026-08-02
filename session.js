import jwt from "jsonwebtoken";

const { SESSION_SECRET } = process.env;

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET precisa estar definido no .env");
}

const COOKIE_NAME = "session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Sessao e um JWT assinado guardado num cookie httpOnly: o navegador
// nunca consegue ler ou manipular o conteudo via JavaScript, e o
// servidor confia apenas na assinatura (nao em nada vindo do cliente).
export function issueSession(res, email) {
  const token = jwt.sign({ email }, SESSION_SECRET, {
    expiresIn: `${SESSION_TTL_MS}ms`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function readSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    return typeof payload.email === "string" ? { email: payload.email } : null;
  } catch {
    return null;
  }
}
