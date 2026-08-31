// Edge Function: prime-acordo
// -----------------------------------------------------------------------------
// SONDAGEM: o Prime sabe quais mensalidades viraram acordo?
//
// Premissa da Amanda (31/08): "usar o Prime como banco de dados, CRM o espelho".
// Para cumprir isso falta uma coisa que hoje nao existe em lugar nenhum: a
// ligacao entre o acordo e as mensalidades que ele substituiu.
//
// Ja descartado:
//   * o Relatorio de Titulos em Aberto nao diz -- `Nº Importacao` vem vazio nas
//     9.466 linhas e `Vcto Origem` tem 627 valores distintos para 2.472 boletos
//     (e a data da negociacao, nao de cada mensalidade).
//   * o portador 166 nunca devolve parcela (+9.000 varridas em 24/08, zero).
//   * /agreements paginado veio vazio em 100% dos alunos testados.
//
// O que NUNCA foi testado por este caminho: o composto
// GET /students/{matricula}, que devolve registrationData, contracts,
// financialStatement e agreements INTEIROS, sem paginar.
//
// Esta funcao so LE e devolve o formato do que chega -- nao grava nada. E uma
// sonda: serve para decidir se da para construir o vinculo a partir do Prime.
//
// A chave vive so no secret PRIME_API_KEY.

const BASE = "https://prime-api.ulbra.ai/api";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token",
};

async function primeGet(caminho: string, chave: string) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
      if (r.status === 503) { await new Promise((s) => setTimeout(s, 1500 * (t + 1))); continue; }
      if (!r.ok) return { ok: false as const, status: r.status };
      return { ok: true as const, dados: await r.json() };
    } catch { await new Promise((s) => setTimeout(s, 1200 * (t + 1))); }
  }
  return { ok: false as const, status: 0 };
}

// Descreve a forma de um valor sem despejar dado pessoal: nomes de campo,
// tipos e um exemplo curto por campo. E o que interessa numa sonda.
function forma(v: unknown, prof = 0): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    return { _lista: v.length, _item: v.length ? forma(v[0], prof + 1) : null };
  }
  if (typeof v === "object") {
    if (prof > 3) return "{...}";
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = forma(val, prof + 1);
    return o;
  }
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const chave = Deno.env.get("PRIME_API_KEY") ?? "";
  const esperado = Deno.env.get("ROTINA_TOKEN") ?? "";
  const recebido = req.headers.get("x-rotina-token") ?? "";
  if (!chave) {
    return new Response(JSON.stringify({ erro: "PRIME_API_KEY ausente" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (esperado && recebido !== esperado) {
    return new Response(JSON.stringify({ erro: "token invalido" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const corpo = await req.json().catch(() => ({}));
  const matricula = String(corpo?.matricula ?? "").trim();
  const cru = corpo?.cru === true;
  if (!matricula) {
    return new Response(JSON.stringify({ erro: "informe a matricula" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const r = await primeGet(`/students/${encodeURIComponent(matricula)}`, chave);
  if (!r.ok) {
    return new Response(JSON.stringify({ erro: "prime respondeu " + r.status }),
      { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const d = r.dados as Record<string, unknown>;
  const fin = (d?.financialStatement ?? []) as unknown[];
  const acs = (d?.agreements ?? []) as unknown[];

  const resposta = {
    matricula,
    chaves_do_topo: Object.keys(d ?? {}),
    financialStatement: { total: Array.isArray(fin) ? fin.length : 0, forma: forma(fin) },
    agreements: { total: Array.isArray(acs) ? acs.length : 0, forma: forma(acs) },
    // a pergunta que decide tudo: alguma parcela diz de que acordo veio,
    // ou algum acordo lista as mensalidades que substituiu?
    tem_ligacao_mensalidade_acordo: JSON.stringify(d ?? {}).match(
      /agreementId|agreementNumber|originDocument|originalDocument|replacedDocument|documentoOrigem/i,
    )?.[0] ?? null,
    ...(cru ? { cru: d } : {}),
  };

  return new Response(JSON.stringify(resposta, null, 2),
    { headers: { ...cors, "Content-Type": "application/json" } });
});
