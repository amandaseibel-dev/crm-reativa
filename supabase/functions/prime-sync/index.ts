// Edge Function: prime-sync
// -----------------------------------------------------------------------------
// Lê a Ulbra Prime API e ENRIQUECE O CADASTRO do nosso CRM. Somente cadastro:
// telefone, endereço, curso, campus, turno, situação acadêmica e se a matrícula
// está vigente. NUNCA dá baixa, cria acordo, altera saldo, parcela ou título.
//
// POR QUE NADA DE FINANCEIRO (medido em produção, 2026-08-24):
//   * A API é SOMENTE-LEITURA -- o servidor responde `allow: GET` em todas as
//     rotas. Não existe escrever de volta no Ulbra.
//   * As parcelas de ACORDO não existem na API: o portador 166 (Santander
//     Reativa) nunca devolve uma parcela (+9.000 varridas, zero), e
//     /agreements vem vazio em 100% dos alunos testados.
//   * A Prime marca a mensalidade como PAGA quando o aluno negocia e NÃO
//     reverte quando o acordo é CANCELADO. Dar baixa por isso apagaria dívida
//     viva: dos 41 títulos que "pareciam pagos", 12 de 13 alunos tinham acordo
//     cancelado. Ver memória `prime-baixa-automatica-proibida-acordo-cancelado`.
//
// AÇÕES (POST JSON, campo `acao`):
//   "coletar"  -> pega os devedores com cadastro incompleto (maior saldo
//                 primeiro), consulta a Prime e grava o espelho em
//                 prime_cadastro_sync. Não escreve em `alunos`.
//   "aplicar"  -> copia do espelho para `alunos`, SOMENTE onde está vazio.
//                 Cada campo escrito vira linha em prime_cadastro_aplicado.
//   "carriers" -> diagnóstico: lista os portadores (conferir 166 e 195).
//
// AUTORIZAÇÃO: service_role (cron) OU usuário de gestão.
//
// ARMADILHAS DA API que este código trata (cada uma causou erro real):
//   1. Busca por CPF SÓ funciona formatada ("052.961.800-11"). Em dígitos puros
//      devolve totalItems:0 SEM ERRO -- falha silenciosa.
//   2. Toda listagem é paginada com `take` padrão 50. Um aluno com 61 parcelas
//      entrega 50 e não avisa.
//   3. 503 "Prime database unavailable" é temporário -> backoff.
//   4. O nome do portador varia; o que vale é o `id`. `covenant` vem com zero à
//      esquerda ("0272047") e é null no 195.
//
// A chave vive APENAS no secret PRIME_API_KEY. Ela dá acesso a CPF e financeiro
// de 400 mil pessoas -- nunca no navegador, nunca no repositório, nunca logada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PRIME_BASE = "https://prime-api.ulbra.ai/api";

// Portadores da Reativa. Confirmados em produção; os judiciais (165, 202) ficam
// FORA do escopo por decisão da gestão.
const CARRIER_ACORDOS = 166;      // SANTANDER REATIVA - CONVENIO 0272047
const CARRIER_MENSALIDADES = 195; // REATIVA RECUPERAÇÃO DE CRÉDITO

const LOTE_PADRAO = 300;   // alunos por execução
const CONCORRENCIA = 6;    // requisições simultâneas à Prime
const TAKE_MAX = 200;      // nunca confiar no default de 50

// Espelha public.usuario_e_gestao().
const GESTAO = new Set([
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
]);

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const digitos = (s: unknown): string => String(s ?? "").replace(/\D/g, "");

// ARMADILHA 1: a Prime só encontra CPF FORMATADO.
function cpfFormatado(cpf: string): string {
  const d = digitos(cpf);
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// GET na Prime com backoff no 503 (ARMADILHA 3). Nunca loga a chave nem o path
// com CPF.
async function primeGet(
  path: string,
  chave: string,
  tentativas = 3,
): Promise<{ ok: true; dados: any } | { ok: false; status: number }> {
  let ultimoStatus = 0;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(`${PRIME_BASE}${path}`, {
        headers: { "X-API-Key": chave, Accept: "application/json" },
      });
      if (r.ok) return { ok: true, dados: await r.json() };
      ultimoStatus = r.status;
      // 401 é chave errada: não adianta insistir.
      if (r.status === 401) return { ok: false, status: 401 };
      if (r.status !== 503 && r.status < 500) return { ok: false, status: r.status };
    } catch {
      ultimoStatus = 0;
    }
    await new Promise((res) => setTimeout(res, 400 * Math.pow(2, i)));
  }
  return { ok: false, status: ultimoStatus };
}

// ARMADILHA 2: pagina até esgotar totalItems em vez de aceitar o default de 50.
async function primeGetTudo(
  base: string,
  chave: string,
): Promise<any[] | null> {
  const itens: any[] = [];
  let skip = 0;
  for (let guarda = 0; guarda < 50; guarda++) {
    const sep = base.includes("?") ? "&" : "?";
    const r = await primeGet(`${base}${sep}skip=${skip}&take=${TAKE_MAX}`, chave);
    if (!r.ok) return null;
    const lote = Array.isArray(r.dados?.items) ? r.dados.items : [];
    itens.push(...lote);
    skip += lote.length;
    if (lote.length === 0 || skip >= (r.dados?.totalItems ?? 0)) break;
  }
  return itens;
}

// Executa `tarefa` sobre `itens` com concorrência limitada.
async function emLotes<T, R>(
  itens: T[],
  limite: number,
  tarefa: (item: T) => Promise<R>,
): Promise<R[]> {
  const saida: R[] = [];
  for (let i = 0; i < itens.length; i += limite) {
    saida.push(...await Promise.all(itens.slice(i, i + limite).map(tarefa)));
  }
  return saida;
}

// Colhe o cadastro de UM CPF, SOMENTE se a pessoa estiver em um dos nossos
// portadores. A Prime tem 400 mil alunos e 124 portadores -- o resto da base é
// cobrança de outras agências e NÃO é responsabilidade da Reativa. Buscar já
// filtrado pelo portador é o portão de escopo, e sai de graça: substitui a
// busca solta em vez de somar requisição.
// Medido em 2026-08-24: numa amostra de 45 devedores do CRM, 44 estavam em 166
// ou 195 e 1 não estava em nenhum dos dois -- esse 1 não deve ser tocado.
async function colherCadastro(cpf: string, chave: string) {
  const formatado = encodeURIComponent(cpfFormatado(cpf));
  let aluno: any = null;
  let portador: number | null = null;

  // 195 primeiro: é o portador mais populoso (mensalidades) e resolve a maioria
  // numa requisição só. 166 (acordos) cobre quem já negociou.
  for (const carrier of [CARRIER_MENSALIDADES, CARRIER_ACORDOS]) {
    const busca = await primeGet(
      `/students?search=${formatado}&carrierId=${carrier}&take=10`,
      chave,
    );
    if (!busca.ok) return { erro: true as const };
    const itens: any[] = Array.isArray(busca.dados?.items) ? busca.dados.items : [];
    // Confere o CPF: `search` é substring e pode trazer gente que não é a pessoa.
    const achado = itens.find((i) => digitos(i?.cpf) === cpf);
    if (achado?.registration) {
      aluno = achado;
      portador = carrier;
      break;
    }
  }
  // Fora dos nossos dois portadores: não é nossa carteira, não coletamos.
  if (!aluno) return { foraDoEscopo: true as const };

  const reg = encodeURIComponent(String(aluno.registration));
  const [cad, contratos] = await Promise.all([
    primeGet(`/students/${reg}/registration-data`, chave),
    primeGetTudo(`/students/${reg}/contracts`, chave),
  ]);

  const rd = cad.ok ? cad.dados : {};
  const telefones: string[] = Array.isArray(rd?.phones)
    ? rd.phones.filter((p: unknown) => digitos(p).length >= 10).map((p: unknown) => String(p).trim())
    : [];

  // Contrato vigente = sem cancelamento e ainda dentro da validade.
  // É o sinal de que o devedor ESTUDA HOJE -- abordagem de cobrança diferente.
  const hoje = new Date().toISOString().slice(0, 10);
  let vigente = false;
  let validoAte: string | null = null;
  for (const c of contratos ?? []) {
    const ate = typeof c?.validTo === "string" ? c.validTo.slice(0, 10) : null;
    if (!c?.cancelledAt && ate && ate >= hoje) {
      vigente = true;
      if (!validoAte || ate > validoAte) validoAte = ate;
    }
  }
  const ultimo = (contratos ?? []).at(-1) ?? {};

  return {
    linha: {
      cpf,
      registration: String(aluno.registration),
      nome: rd?.fullName ?? aluno?.name ?? null,
      rg: rd?.rg ?? null,
      telefones,
      endereco: rd?.address ?? null,
      curso: aluno?.course ?? ultimo?.course ?? null,
      campus: aluno?.campus ?? ultimo?.establishment ?? null,
      turno: aluno?.shift ?? ultimo?.shift ?? null,
      status_academico: aluno?.status ?? null,
      contrato_vigente: vigente,
      contrato_valid_to: validoAte,
      portador: portador,          // 166 (acordos) ou 195 (mensalidades)
      coletado_em: new Date().toISOString(),
    },
    vigente,
    ganhouTelefone: telefones.length > 0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "metodo_nao_suportado" }, 405);

  const chave = Deno.env.get("PRIME_API_KEY") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!chave) return json({ erro: "prime_api_key_ausente" }, 500);
  if (!url || !servico) return json({ erro: "ambiente_incompleto" }, 500);

  // --- autorização: service_role (cron) OU gestão -----------------------------
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  let autorizado = token === servico;
  if (!autorizado && token) {
    const comoUsuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: auth } },
    });
    const { data } = await comoUsuario.auth.getUser();
    const email = (data?.user?.email ?? "").toLowerCase();
    autorizado = GESTAO.has(email);
  }
  if (!autorizado) return json({ erro: "nao_autorizado" }, 403);

  const admin = createClient(url, servico, { auth: { persistSession: false } });

  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* corpo vazio = coletar */ }
  const acao = String(corpo?.acao ?? "coletar");

  // --- diagnóstico: portadores -----------------------------------------------
  if (acao === "carriers") {
    const r = await primeGet("/carriers?take=200", chave);
    if (!r.ok) return json({ erro: "prime_indisponivel", status: r.status }, 502);
    const itens: any[] = r.dados?.items ?? [];
    return json({
      total: itens.length,
      nossos: itens
        .filter((c) => c.id === CARRIER_ACORDOS || c.id === CARRIER_MENSALIDADES)
        .map((c) => ({ id: c.id, name: c.name, covenant: c.covenant })),
    });
  }

  // --- aplicar: espelho -> alunos (só campo vazio) ----------------------------
  if (acao === "aplicar") {
    const { data: exec } = await admin
      .from("prime_cadastro_execucoes")
      .insert({ acao: "aplicar" })
      .select("id")
      .single();

    const { data, error } = await admin.rpc("prime_cadastro_aplicar", {
      p_execucao_id: exec?.id ?? null,
    });
    if (error) {
      await admin.from("prime_cadastro_execucoes")
        .update({ terminado_em: new Date().toISOString(), erros: 1, detalhe: { falha: error.code } })
        .eq("id", exec?.id);
      return json({ erro: "falha_ao_aplicar", codigo: error.code }, 500);
    }
    const r = Array.isArray(data) ? data[0] : data;
    await admin.from("prime_cadastro_execucoes").update({
      terminado_em: new Date().toISOString(),
      aplicados: r?.alunos_tocados ?? 0,
      detalhe: {
        telefones: r?.telefones ?? 0,
        cursos: r?.cursos ?? 0,
        situacoes: r?.situacoes ?? 0,
      },
    }).eq("id", exec?.id);

    return json({ ok: true, execucao_id: exec?.id, ...r });
  }

  // --- coletar: Prime -> espelho ---------------------------------------------
  if (acao !== "coletar") return json({ erro: "acao_desconhecida" }, 400);

  const limite = Math.min(Math.max(Number(corpo?.limite) || LOTE_PADRAO, 1), 1000);

  const { data: exec } = await admin
    .from("prime_cadastro_execucoes")
    .insert({ acao: "coletar" })
    .select("id")
    .single();

  const { data: alvos, error: erroAlvos } = await admin
    .rpc("prime_alvos_cadastro", { p_limite: limite });
  if (erroAlvos) {
    await admin.from("prime_cadastro_execucoes")
      .update({ terminado_em: new Date().toISOString(), erros: 1, detalhe: { falha: erroAlvos.code } })
      .eq("id", exec?.id);
    return json({ erro: "falha_ao_listar_alvos", codigo: erroAlvos.code }, 500);
  }

  const cpfs: string[] = (alvos ?? []).map((a: any) => a.cpf).filter(Boolean);
  const resultados = await emLotes(cpfs, CONCORRENCIA, (cpf) => colherCadastro(cpf, chave));

  const linhas = resultados.filter((r: any) => r?.linha).map((r: any) => r.linha);
  // Fora dos portadores 166/195: não é carteira da Reativa, ficou de fora.
  const foraDoEscopo = resultados.filter((r: any) => r?.foraDoEscopo).length;
  const erros = resultados.filter((r: any) => r?.erro).length;
  const comTelefone = resultados.filter((r: any) => r?.ganhouTelefone).length;
  const estudando = resultados.filter((r: any) => r?.vigente).length;

  if (linhas.length > 0) {
    // Upsert em blocos: o espelho é reescrito a cada coleta.
    for (let i = 0; i < linhas.length; i += 200) {
      const { error } = await admin
        .from("prime_cadastro_sync")
        .upsert(linhas.slice(i, i + 200), { onConflict: "cpf" });
      if (error) {
        await admin.from("prime_cadastro_execucoes")
          .update({ terminado_em: new Date().toISOString(), erros: erros + 1, detalhe: { falha: error.code } })
          .eq("id", exec?.id);
        return json({ erro: "falha_ao_gravar_espelho", codigo: error.code }, 500);
      }
    }
  }

  await admin.from("prime_cadastro_execucoes").update({
    terminado_em: new Date().toISOString(),
    alvos: cpfs.length,
    encontrados: linhas.length,
    erros,
    detalhe: { fora_do_escopo: foraDoEscopo, com_telefone: comTelefone, estudando_hoje: estudando },
  }).eq("id", exec?.id);

  return json({
    ok: true,
    execucao_id: exec?.id,
    alvos: cpfs.length,
    encontrados: linhas.length,
    fora_do_escopo: foraDoEscopo,
    erros,
    ganham_telefone: comTelefone,
    estudando_hoje: estudando,
  });
});
