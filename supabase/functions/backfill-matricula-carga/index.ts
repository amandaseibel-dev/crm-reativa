// Edge Function: backfill-matricula-carga
// -----------------------------------------------------------------------------
// TRANSPORTADOR DA STAGE, E SO ISSO. Recebe um pedaco do plano no CORPO da
// requisicao e o deposita em `backfill_matricula_stage`. Nao aplica backfill,
// nao le a stage, nao apaga nada, nao tem tela.
//
// POR QUE ELA EXISTE. O plano real tem ~7.401 linhas e nao pode entrar no Git
// (repositorio publico) nem viajar por `apply_migration` (o SQL fica inteiro em
// `supabase_migrations.schema_migrations.statements` e tambem em
// `postgres_logs`). E nao pode ir como parametro de RPC: medido em 15/09/2026,
// `auto_explain.log_min_duration` = 10000 ms com
// `auto_explain.log_parameter_max_length` = -1, e nao da para desligar sem ser
// superusuario. Sobra o corpo de uma requisicao HTTP -- que, medido no mesmo
// dia, NAO e logado.
//
// O QUE FOI MEDIDO SOBRE OS LOGS, com um marcador sintetico enviado ao mesmo
// tempo no header, na query string e no corpo:
//
//   query string  -> APARECE em `request.search` e `request.url`
//   header custom -> NAO aparece (os headers logados sao uma allowlist:
//                    x_real_ip, accept, user_agent, host, content_length, cf_*)
//   corpo         -> NAO aparece, em nenhuma fonte de log
//
// Dai as duas regras que este arquivo obedece: NADA de plano ou segredo na URL,
// e NADA de `console.log` do corpo.
//
// CICLO DE VIDA. Esta funcao e TEMPORARIA, e a ordem importa:
//
//   1. deploy desta Edge + `BACKFILL_CARGA_TOKEN` no Vault/env;
//   2. carregar a stage em pedacos de 100 (o caller assina cada pedaco);
//   3. CONFERIR SEM APLICAR: como `postgres`, comparar contagem e recomputar a
//      canonicalizacao da stage contra o hash do artefato -- e so olhar;
//   4. aplicar o lote: `backfill_matricula_aplicar(lote, hash, quantidade)`,
//      por `apply_migration`, sem nenhum dado pessoal na chamada;
//   5. confirmar que o retorno traz `alteracoes` igual ao previsto;
//   6. confirmar que a stage daquele lote ficou vazia (o motor so limpa no
//      sucesso) e que a trilha tem a mesma quantidade;
//   7. REMOVER esta Edge;
//   8. ROTACIONAR ou apagar `BACKFILL_CARGA_TOKEN`.
//
// A auditoria sobrevive aos passos 7 e 8: quem guarda procedencia sao
// `backfill_matricula_lotes` e `backfill_matricula_origem`, no banco, e nenhuma
// delas depende deste canal para ser lida.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token",
};

// Teto por requisicao. O caller usa 100; 200 e a folga, nao o alvo.
export const MAX_REGISTROS = 200;
// Janela da assinatura. Curta de proposito: uma requisicao capturada vira
// inutil depressa.
export const JANELA_SEGUNDOS = 300;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });

/** Comparacao de tempo constante -- nao vaza o prefixo certo pelo tempo. */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(texto: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
}

/**
 * ASSINATURA DO PEDACO. Amarra o chunk ao lote, ao artefato e a sua posicao, e
 * carimba a hora. Sem isso, quem capturasse uma requisicao poderia reenviar o
 * corpo trocando `lote` e envenenar outra carga.
 */
export async function assinar(
  segredo: string, lote: string, hash: string, indice: number,
  digestoDosRegistros: string, ts: number,
): Promise<string> {
  const chave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = [lote, hash, String(indice), digestoDosRegistros, String(ts)].join("|");
  return hex(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(msg)));
}

type Registro = {
  pagamento_id: string; numero_parcela_completo: string; matricula: string;
  arquivo_origem: string; linha_no_arquivo: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida a FORMA de um registro. Nao julga conteudo -- isso e do motor. */
export function registroInvalido(r: unknown): string | null {
  if (typeof r !== "object" || r === null) return "registro nao e objeto";
  const x = r as Record<string, unknown>;
  if (typeof x.pagamento_id !== "string" || !UUID.test(x.pagamento_id))
    return "pagamento_id ausente ou fora do formato uuid";
  for (const campo of ["numero_parcela_completo", "matricula", "arquivo_origem"]) {
    const v = x[campo];
    if (typeof v !== "string" || v.trim() === "") return `${campo} ausente ou vazio`;
  }
  if (!Number.isInteger(x.linha_no_arquivo) || (x.linha_no_arquivo as number) < 1)
    return "linha_no_arquivo ausente ou nao inteiro positivo";
  return null;
}

export type Dependencias = {
  env: (nome: string) => string | undefined;
  /** Deposita as linhas na stage. Em producao: upsert ignorando duplicata. */
  inserir: (linhas: (Registro & { lote: string })[]) => Promise<{ inseridos: number }>;
  agora?: () => number;
};

export function criarHandler(deps: Dependencias) {
  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ erro: "use POST" }, 405);

    // NADA NA URL. A query string e logada em `request.search`; aceitar
    // parametro por ali seria abrir a porta que todo o resto fecha.
    const url = new URL(req.url);
    if (url.search !== "") return json({ erro: "esta rota nao aceita query string" }, 400);

    const segredo = deps.env("BACKFILL_CARGA_TOKEN") ?? "";
    if (segredo === "") return json({ erro: "canal nao configurado" }, 503);

    const token = req.headers.get("x-rotina-token") ?? "";
    if (!iguaisEmTempoConstante(token, segredo)) {
      return json({ erro: "nao autorizado" }, 401);
    }

    let corpo: Record<string, unknown>;
    try { corpo = await req.json(); } catch { return json({ erro: "corpo nao e JSON" }, 400); }

    const lote = typeof corpo.lote === "string" ? corpo.lote.trim() : "";
    const hash = typeof corpo.hash === "string" ? corpo.hash.trim() : "";
    const indice = corpo.indice;
    const ts = corpo.ts;
    const assinatura = typeof corpo.assinatura === "string" ? corpo.assinatura : "";
    const registros = corpo.registros;

    if (lote === "") return json({ erro: "lote obrigatorio" }, 400);
    if (hash === "") return json({ erro: "hash obrigatorio" }, 400);
    if (!Number.isInteger(indice) || (indice as number) < 0)
      return json({ erro: "indice obrigatorio" }, 400);
    if (!Number.isInteger(ts)) return json({ erro: "ts obrigatorio" }, 400);
    if (!Array.isArray(registros) || registros.length === 0)
      return json({ erro: "registros obrigatorios" }, 400);
    if (registros.length > MAX_REGISTROS)
      return json({ erro: `no maximo ${MAX_REGISTROS} registros por requisicao` }, 413);

    const agora = Math.floor((deps.agora?.() ?? Date.now()) / 1000);
    if (Math.abs(agora - (ts as number)) > JANELA_SEGUNDOS)
      return json({ erro: "assinatura fora da janela" }, 401);

    const digesto = await sha256Hex(JSON.stringify(registros));
    const esperada = await assinar(segredo, lote, hash, indice as number, digesto, ts as number);
    if (!iguaisEmTempoConstante(assinatura, esperada)) {
      return json({ erro: "assinatura invalida" }, 401);
    }

    for (let i = 0; i < registros.length; i++) {
      const motivo = registroInvalido(registros[i]);
      // A POSICAO, NUNCA O CONTEUDO. Dizer "linha 7 tem matricula vazia" ajuda a
      // depurar; ecoar a linha devolveria dado pessoal por um canal que existe
      // justamente para nao expor nenhum.
      if (motivo) return json({ erro: `registro ${i}: ${motivo}` }, 400);
    }

    const linhas = (registros as Registro[]).map((r) => ({
      lote,
      pagamento_id: r.pagamento_id,
      numero_parcela_completo: r.numero_parcela_completo,
      matricula: r.matricula,
      arquivo_origem: r.arquivo_origem,
      linha_no_arquivo: r.linha_no_arquivo,
    }));

    let inseridos = 0;
    try {
      ({ inseridos } = await deps.inserir(linhas));
    } catch (e) {
      // So a mensagem do banco, que nao carrega o corpo. Nunca as linhas.
      return json({ erro: "falha ao gravar na stage", detalhe: String((e as Error).message) }, 502);
    }

    // SO CONTAGEM. Nenhum registro volta.
    return json({ lote, indice, recebidos: linhas.length, inseridos });
  };
}

// Em producao a dependencia real: `service_role`, e so para INSERT. O upsert
// com `ignoreDuplicates` e o que torna o reenvio de um pedaco inofensivo --
// a chave (lote, pagamento_id) absorve a repeticao.
declare const Deno: { env: { get(n: string): string | undefined }; serve(h: unknown): void };

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  const { createClient } = await import("jsr:@supabase/supabase-js@2");
  const supa = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  Deno.serve(criarHandler({
    env: (n) => Deno.env.get(n),
    inserir: async (linhas) => {
      const { error, count } = await supa
        .from("backfill_matricula_stage")
        .upsert(linhas, { onConflict: "lote,pagamento_id", ignoreDuplicates: true, count: "exact" });
      if (error) throw new Error(error.message);
      return { inseridos: count ?? 0 };
    },
  }));
}
