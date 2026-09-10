// Registro em memoria dos downloads em andamento que o cliente pediu pra
// acompanhar (passou ?requestId= em /download). So existe enquanto o
// processo roda - nao precisa de persistencia, um restart do servidor
// derruba os downloads em curso de qualquer jeito.
//
// Cada job guarda o AbortController (cancela os fetch em andamento) e,
// quando aplicavel, a referencia do browser do Puppeteer (fechar cancela
// qualquer navegacao/evaluate pendente).
const jobs = new Map();

// Erro distinto de uma falha real - usado pra diferenciar "cancelado pelo
// usuario" de "deu erro de verdade" no catch do /download (muda a resposta
// HTTP e o status gravado no historico).
export class CancelError extends Error {
  constructor(message = "Cancelado pelo usuario") {
    super(message);
    this.name = "CancelError";
  }
}

// Quanto tempo um job fica no Map depois de terminar (sucesso, erro ou
// cancelado) - da tempo de um ultimo poll do cliente ver o estado final
// antes de sumir (sem isso, um poll logo apos o fim veria 404 e o cliente
// nao saberia se foi cancelado, deu erro ou terminou com sucesso).
const RETENTION_MS = 30_000;

export function createJob(requestId) {
  const controller = new AbortController();
  const job = {
    requestId,
    controller,
    signal: controller.signal,
    browser: null,
    stage: "iniciando",
    percent: 0,
    message: "",
    status: "running", // running | done | error | canceled
  };
  jobs.set(requestId, job);
  return job;
}

export function getJob(requestId) {
  return jobs.get(requestId) ?? null;
}

// Chamado pelo endpoint de cancelamento - so sinaliza, quem de fato para
// o trabalho e o proprio fluxo de download ao checar job.signal.aborted
// (e o fetchBuffer, que recebe o signal direto).
export function cancelJob(requestId) {
  const job = jobs.get(requestId);
  if (!job) return false;
  job.status = "canceling";
  job.controller.abort();
  if (job.browser) {
    job.browser.close().catch(() => {});
  }
  return true;
}

export function finishJob(requestId, status) {
  const job = jobs.get(requestId);
  if (!job) return;
  job.status = status;
  job.percent = status === "done" ? 100 : job.percent;
  setTimeout(() => jobs.delete(requestId), RETENTION_MS);
}
