// App fica hospedado sob um subpath (ex.: app.brabospace.com/downloader) — o proxy
// reverso já remove esse prefixo antes de chegar aqui, então as rotas do Express
// continuam todas na raiz. O que falta é avisar o NAVEGADOR do prefixo real, senão
// todo link/fetch relativo à raiz ("/login.html", "/api/auth/...") escapa do subpath
// e cai fora da regra de roteamento do proxy. <base href> resolve isso pro HTML/fetch;
// redirects do próprio servidor (ver requireActiveSubscriber.js) precisam do mesmo valor.
export const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "");
