const stepEmail = document.getElementById("stepEmail");
const stepCode = document.getElementById("stepCode");
const subtitle = document.getElementById("subtitle");
const status = document.getElementById("status");
const emailInput = document.getElementById("email");
const codeInput = document.getElementById("code");

let currentEmail = "";

// Quem clica no link do e-mail (em vez de digitar o codigo) e
// redirecionado de volta pra ca pelo proprio Supabase, com um
// access_token no fragmento da URL (#access_token=...). Detectamos
// isso e completamos o login por esse caminho tambem.
(async function handleMagicLinkRedirect() {
  const hash = window.location.hash;
  if (!hash.includes("access_token=")) return;

  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get("access_token");
  history.replaceState(null, "", window.location.pathname);
  if (!accessToken) return;

  status.textContent = "Confirmando login...";
  try {
    await postJson("api/auth/session-from-token", { access_token: accessToken });
    status.textContent = "Login realizado! Redirecionando...";
    window.location.href = "./";
  } catch (err) {
    status.textContent = err.message;
  }
})();

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || "Erro inesperado.");
  return data;
}

document.getElementById("btnRequest").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  currentEmail = emailInput.value.trim();
  if (!currentEmail) { status.textContent = "Informe um e-mail."; return; }

  btn.disabled = true;
  status.textContent = "Enviando...";
  try {
    const data = await postJson("api/auth/login", { email: currentEmail });
    status.textContent = data.message;
    stepEmail.classList.add("hidden");
    stepCode.classList.remove("hidden");
    subtitle.textContent = "Confira seu e-mail e digite o codigo recebido.";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnVerify").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const code = codeInput.value.trim();
  if (!code) { status.textContent = "Informe o codigo recebido."; return; }

  btn.disabled = true;
  status.textContent = "Verificando...";
  try {
    await postJson("api/auth/verify", { email: currentEmail, code });
    status.textContent = "Login realizado! Redirecionando...";
    window.location.href = "./";
  } catch (err) {
    status.textContent = err.message;
    btn.disabled = false;
  }
});

document.getElementById("btnBack").addEventListener("click", () => {
  stepCode.classList.add("hidden");
  stepEmail.classList.remove("hidden");
  subtitle.textContent = "Acesso exclusivo para assinantes. Informe seu e-mail para receber um codigo de acesso.";
  status.textContent = "";
  codeInput.value = "";
});
