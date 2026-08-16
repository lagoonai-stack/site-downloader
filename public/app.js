const btn = document.getElementById("btn");
const status = document.getElementById("status");

document.getElementById("btnLogout").addEventListener("click", async () => {
  await fetch("api/auth/logout", { method: "POST" });
  window.location.href = "login.html";
});

btn.addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim();
  if (!url) { status.textContent = "Cole uma URL primeiro."; return; }

  btn.disabled = true;
  status.textContent = "Baixando... (pode levar alguns segundos)";
  try {
    const resp = await fetch(`download?url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = new URL(url).hostname + ".zip";
    a.click();
    URL.revokeObjectURL(a.href);
    status.textContent = "Pronto! Download iniciado.";
  } catch (e) {
    status.textContent = "Erro: " + e.message;
  } finally {
    btn.disabled = false;
  }
});
