// Helper de contenção para chamadas SECUNDÁRIAS (dashboards/contadores/TV).
// NÃO usar em fluxos críticos (login, busca de alunos, carteira, atendimento):
// esses devem falhar/retornar de forma explícita, sem cache nem retry silencioso.
//
// Garante, para chamadas caras que rodam em polling e concorrência:
//  - cache em memória de curta duração (evita repetir a mesma RPC em rajada);
//  - single-flight por chave (duas telas/foco não disparam a mesma RPC junta);
//  - timeout local + no máximo UMA tentativa adicional com backoff;
//  - AbortController (cancela ao desmontar / ao estourar timeout);
//  - nunca lança: retorna sempre { data, error }, isolando a falha do CRM.
//
// Uso:
//   const { data, error } = await chamarRpcContido(supabase, "contadores_cabecalho",
//     {}, { cacheMs: 60000, timeoutMs: 8000 });

const cache = new Map();     // chave -> { expira, valor }
const emVoo = new Map();     // chave -> Promise

function chaveDe(nome, params) {
  return nome + ":" + JSON.stringify(params || {});
}

function comTimeout(promise, timeoutMs, controller) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try { controller?.abort(); } catch (e) { /* noop */ }
      resolve({ data: null, error: new Error("timeout local (" + timeoutMs + "ms)") });
    }, timeoutMs);
    promise.then(
      (r) => { clearTimeout(t); resolve(r); },
      (e) => { clearTimeout(t); resolve({ data: null, error: e }); }
    );
  });
}

export async function chamarRpcContido(supabase, nome, params = {}, opcoes = {}) {
  const {
    cacheMs = 0,
    timeoutMs = 8000,
    tentativasExtras = 1,   // no máximo 1 retry
    backoffMs = 1500,
    signal,                 // AbortSignal externo (desmontagem do componente)
  } = opcoes;

  const chave = chaveDe(nome, params);

  // 1) Cache curto: serve a mesma resposta em rajadas de foco/polling.
  if (cacheMs > 0) {
    const c = cache.get(chave);
    if (c && c.expira > Date.now()) return c.valor;
  }

  // 2) Single-flight: se já há uma chamada igual em voo, aguarda a mesma.
  if (emVoo.has(chave)) return emVoo.get(chave);

  const executar = (async () => {
    let ultimo = { data: null, error: new Error("não executado") };
    for (let tentativa = 0; tentativa <= tentativasExtras; tentativa++) {
      if (signal?.aborted) return { data: null, error: new Error("abortado") };
      const controller = new AbortController();
      if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
      const req = supabase.rpc(nome, params).abortSignal(controller.signal);
      ultimo = await comTimeout(Promise.resolve(req), timeoutMs, controller);
      if (!ultimo.error) break;
      if (tentativa < tentativasExtras) {
        await new Promise((r) => setTimeout(r, backoffMs * (tentativa + 1)));
      }
    }
    if (cacheMs > 0 && !ultimo.error) {
      cache.set(chave, { expira: Date.now() + cacheMs, valor: ultimo });
    }
    return ultimo;
  })();

  emVoo.set(chave, executar);
  try {
    return await executar;
  } finally {
    emVoo.delete(chave);
  }
}

// Invalida o cache (ex.: após uma ação que muda os contadores).
export function invalidarRpcContido(nome, params) {
  if (!nome) { cache.clear(); return; }
  cache.delete(chaveDe(nome, params));
}
