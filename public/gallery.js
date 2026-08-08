const grid = document.getElementById("grid");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const LABEL = { escuro: "Escuro", claro: "Claro", componente: "Componente" };

let DATA = [];
let state = { cat: "todos", q: "" };

document.getElementById("btnLogout").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
});

function cardHtml(d) {
  const previewHref = d.liveUrl || `/${d.previewPath}`;
  const actionBtn = d.liveUrl
    ? `<button class="action-btn install-btn" data-url="${d.liveUrl}" data-name="${d.slug}">Instalar</button>`
    : `<a class="action-btn preview-btn" href="/${d.previewPath}" target="_blank" rel="noopener">Prévia</a>`;
  return `<article class="gcard">
    <a class="thumb-wrap" href="${previewHref}" target="_blank" rel="noopener" title="${d.name}">
      <img loading="lazy" src="/${d.thumb}" alt="${d.name}" onerror="this.style.opacity=.15">
    </a>
    <div class="meta">
      <div class="meta-left">
        <div class="title" title="${d.name}">${d.name}</div>
        <span class="badge">${LABEL[d.category] || d.category}</span>
      </div>
      <div class="actions">${actionBtn}</div>
    </div>
  </article>`;
}

function render() {
  const q = state.q.trim().toLowerCase();
  const list = DATA.filter((d) => {
    const okCat = state.cat === "todos" || d.category === state.cat;
    const okQ = !q || d.name.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q);
    return okCat && okQ;
  });
  countEl.textContent = list.length + (list.length === 1 ? " design" : " designs");
  if (!list.length) {
    grid.innerHTML = `<div class="empty">Nenhum design encontrado.</div>`;
    return;
  }
  grid.innerHTML = list.map(cardHtml).join("");
}

document.getElementById("filters").addEventListener("click", (e) => {
  const b = e.target.closest(".pill");
  if (!b) return;
  document.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  b.classList.add("active");
  state.cat = b.dataset.cat;
  render();
});

let searchTimer;
document.getElementById("q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value;
    render();
  }, 120);
});

grid.addEventListener("click", async (e) => {
  const btn = e.target.closest(".install-btn");
  if (!btn) return;
  const url = btn.dataset.url;
  const name = btn.dataset.name;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Baixando...";
  statusEl.textContent = "";
  try {
    const resp = await fetch(`/download?url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".zip";
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = "Pronto!";
  } catch (err) {
    btn.textContent = "Erro";
    statusEl.textContent = `Erro ao instalar ${name}: ${err.message}`;
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = prevText;
    }, 2500);
  }
});

(async function init() {
  const resp = await fetch("/catalog.json");
  DATA = await resp.json();
  render();
})();
