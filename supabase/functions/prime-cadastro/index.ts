// Atualização cadastral pela Ulbra Prime.
//
// O QUE TRAZ, por aluno: telefones, e-mails, contratos e o semestre de cada
// título. Tudo entra COMPLEMENTANDO -- telefone novo não sobrescreve o antigo,
// e número que alguém invalidou não ressuscita. Quem garante isso é a RPC
// `aluno_contato_adicionar`, do outro lado.
//
// O PONTO DELICADO É O SEMESTRE DA DÍVIDA. Não dá para deduzir pelo mês do
// vencimento por causa da matrícula antecipada: o aluno paga em junho uma
// parcela que é do contrato do semestre seguinte. Pelo mês, cairia no semestre
// errado.
//
// O que separa é a SÉRIE DE COBRANÇA. O `documentNumber` da parcela termina
// com o número dela, e o prefixo é próprio de cada contrato:
//
//     0104425930100  -> série 0104425930, parcela 1   (jan/2026)
//     0104425930600  -> série 0104425930, parcela 6   (jun/2026)
//     0105121990000  -> série 0105121990, parcela 0   (jul/2026, matrícula 2026/2)
//
// Então: agrupa as parcelas por série, decide o semestre da SÉRIE pelo contrato
// que cobre a maioria dos vencimentos dela, e aplica esse semestre a todas as
// parcelas do grupo. A matrícula antecipada cai certo porque tem série própria.
//
// ARMADILHAS DA API, todas já custaram erro:
//   * a busca por CPF só funciona FORMATADA. Em dígitos puros devolve
//     totalItems 0, sem erro -- falha silenciosa;
//   * `referenceSemester` NÃO é o semestre do calendário, é o período do aluno
//     no curso. Quem manda é a janela de datas do contrato;
//   * `/financial-statement` é paginado (take=50 por padrão), mas o endpoint
//     composto `/students/{matrícula}` devolve o extrato inteiro de uma vez;
//   * a API só tem parcelas LIQUIDADAS. Ausência não prova dívida em aberto.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://prime-api.ulbra.ai/api";
const CARRIER_MENSALIDADES = 195;
const CARRIER_ACORDOS = 166;
const CONCORRENCIA = 4;

const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

function cpfFormatado(cpf: string) {
  const d = digitos(cpf);
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

async function primeGet(caminho: string, chave: string) {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
      // 503 = "Prime database unavailable", indisponibilidade temporária.
      if (r.status === 503) { await new Promise((s) => setTimeout(s, 1500 * (tentativa + 1))); continue; }
      if (!r.ok) return { ok: false as const, status: r.status };
      return { ok: true as const, dados: await r.json() };
    } catch {
      await new Promise((s) => setTimeout(s, 1200 * (tentativa + 1)));
    }
  }
  return { ok: false as const, status: 0 };
}

// Semestre-calendário a partir da data de início do contrato.
function semestreDe(validFrom: string | null): string | null {
  if (!validFrom) return null;
  const ano = Number(validFrom.slice(0, 4));
  const mes = Number(validFrom.slice(5, 7));
  if (!ano || !mes) return null;
  return `${ano}/${mes <= 6 ? 1 : 2}`;
}

async function colher(cpf: string, chave: string) {
  const formatado = encodeURIComponent(cpfFormatado(cpf));
  let registration: string | null = null;

  // 195 primeiro: é o portador mais populoso e resolve a maioria numa
  // requisição só. 166 cobre quem já negociou.
  for (const carrier of [CARRIER_MENSALIDADES, CARRIER_ACORDOS]) {
    const busca = await primeGet(`/students?search=${formatado}&carrierId=${carrier}&take=10`, chave);
    if (!busca.ok) return { cpf, erro: "BUSCA_FALHOU" };
    const itens: any[] = Array.isArray(busca.dados?.items) ? busca.dados.items : [];
    // `search` é substring: confere o CPF antes de aceitar.
    const achado = itens.find((i) => digitos(i?.cpf) === cpf);
    if (achado?.registration) { registration = String(achado.registration); break; }
  }
  if (!registration) return { cpf, foraDoEscopo: true };

  const composto = await primeGet(`/students/${encodeURIComponent(registration)}`, chave);
  if (!composto.ok) return { cpf, erro: "DETALHE_FALHOU" };

  const rd = composto.dados?.registrationData ?? {};
  const contratosApi: any[] = Array.isArray(composto.dados?.contracts) ? composto.dados.contracts : [];
  const parcelas: any[] = Array.isArray(composto.dados?.financialStatement) ? composto.dados.financialStatement : [];

  const contratos = contratosApi
    .filter((c) => c?.validFrom)
    .map((c) => ({
      valid_from: String(c.validFrom).slice(0, 10),
      valid_to: c.validTo ? String(c.validTo).slice(0, 10) : null,
      status: c.status ?? null,
      tipo: c.type ?? null,
      curso: c.course ?? null,
      campus: c.establishment ?? null,
      turno: c.shift ?? null,
      // Guardado como vem, mas NÃO é o semestre do calendário.
      periodo_curso: Number.isFinite(c.referenceSemester) ? c.referenceSemester : null,
      cancelado_em: c.cancelledAt ? String(c.cancelledAt).slice(0, 10) : null,
    }));

  // Agrupa as parcelas por série (prefixo do documentNumber).
  const series = new Map<string, any[]>();
  for (const p of parcelas) {
    const dn = String(p?.documentNumber ?? "");
    if (dn.length < 4) continue;
    const serie = dn.slice(0, -3);
    if (!series.has(serie)) series.set(serie, []);
    series.get(serie)!.push({
      boleto: String(p?.boleto ?? "").trim(),
      parcela: Number(dn.slice(-3)) / 100,
      vencimento: p?.dueDate ? String(p.dueDate).slice(0, 10) : null,
      liquidado_em: p?.paymentDate ? String(p.paymentDate).slice(0, 10) : null,
    });
  }

  // Cada série herda o semestre do contrato que cobre a MAIORIA dos
  // vencimentos dela. Maioria, e não a primeira parcela, porque uma parcela
  // solta fora da janela não deve arrastar a série inteira.
  const titulos: any[] = [];
  for (const [serie, itens] of series) {
    const votos = new Map<string, number>();
    for (const it of itens) {
      if (!it.vencimento) continue;
      const ct = contratos.find((c) => c.valid_from <= it.vencimento && (!c.valid_to || it.vencimento <= c.valid_to));
      const sem = ct ? semestreDe(ct.valid_from) : null;
      if (sem) votos.set(sem, (votos.get(sem) ?? 0) + 1);
    }
    let semestre: string | null = null;
    let melhor = 0;
    for (const [sem, n] of votos) if (n > melhor) { melhor = n; semestre = sem; }

    for (const it of itens) {
      if (!it.boleto) continue;
      titulos.push({ ...it, serie, semestre });
    }
  }

  const telefones = Array.isArray(rd?.phones)
    ? rd.phones.filter((p: unknown) => digitos(p).length >= 10).map((p: unknown) => String(p).trim())
    : [];
  const emails = [rd?.email, rd?.institutionalEmail]
    .filter((e: unknown) => typeof e === "string" && e.includes("@"))
    .map((e: string) => e.trim());

  return { cpf, registration, telefones, emails, contratos, titulos };
}

// Comparacao que nao entrega o segredo pelo tempo de resposta.
function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

async function emLotes<T, R>(itens: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = [];
  for (let i = 0; i < itens.length; i += n) {
    saida.push(...await Promise.all(itens.slice(i, i + n).map(fn)));
  }
  return saida;
}

Deno.serve(async (req) => {
  // PORTÃO DE ACESSO. `verify_jwt` só garante que quem chamou está logado --
  // qualquer operador passaria. Uma varredura na Prime lê PII de milhares de
  // alunos e gasta cota da API, então tem que ser gestão.
  //
  // A checagem usa o token de QUEM CHAMOU, não a service key: é o banco que
  // decide, pela mesma função que as políticas de RLS usam.
  const autorizacao = req.headers.get("Authorization") ?? "";
  if (!autorizacao.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ erro: "SEM_TOKEN" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  // Dois chamadores legítimos, e só dois:
  //
  //  1. a ROTINA NOTURNA, que se identifica com um token dedicado no header
  //     `x-rotina-token`. Não é a service key de propósito: aquela passa por
  //     cima de todo o RLS, e o estrago de um vazamento seria o banco inteiro.
  //     Com um token próprio, o pior que acontece é alguém disparar uma coleta.
  //     A comparação é de tempo constante -- comparar segredo com `===` vaza
  //     informação pelo tempo de resposta;
  //  2. a GESTÃO pela tela, com a sessão dela. Aí quem decide é o banco, pela
  //     mesma função que as políticas de RLS usam.
  const tokenEsperado = Deno.env.get("PRIME_CADASTRO_TOKEN") ?? "";
  const tokenRecebido = req.headers.get("x-rotina-token") ?? "";
  const ehRotina = tokenEsperado.length > 0 && iguaisEmTempoConstante(tokenRecebido, tokenEsperado);

  if (!ehRotina) {
    const supaChamador = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: autorizacao } } },
    );
    const { data: ehGestao, error: erroGestao } = await supaChamador.rpc("usuario_e_gestao");
    if (erroGestao || ehGestao !== true) {
      return new Response(JSON.stringify({ erro: "ACESSO_NEGADO", detalhe: "restrito a gestao" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }
  }

  const chave = Deno.env.get("PRIME_API_KEY");
  if (!chave) {
    return new Response(JSON.stringify({ erro: "PRIME_API_KEY nao configurada" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* sem corpo = usa os padrões */ }

  const limite = Math.min(Number(corpo?.limite) || 50, 500);
  let cpfs: string[] = Array.isArray(corpo?.cpfs) ? corpo.cpfs.map(digitos).filter((c: string) => c.length === 11) : [];

  // Sem lista explícita: pega quem tem dívida em aberto e ainda não foi
  // coletado, do maior saldo para o menor.
  if (cpfs.length === 0) {
    const { data, error } = await supa.rpc("prime_cadastro_pendentes", { p_limite: limite });
    if (error) {
      return new Response(JSON.stringify({ erro: "PENDENTES_FALHOU", detalhe: error.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    cpfs = (data ?? []).map((r: any) => r.cpf);
  }
  cpfs = cpfs.slice(0, limite);

  const colhidos = await emLotes(cpfs, CONCORRENCIA, (cpf) => colher(cpf, chave));

  let aplicados = 0, fora = 0, erros = 0, telNovos = 0, mailNovos = 0, tit = 0;
  for (const c of colhidos) {
    if ((c as any).foraDoEscopo) { fora++; continue; }
    if ((c as any).erro) { erros++; continue; }
    const { data, error } = await supa.rpc("prime_cadastro_aplicar", { p_dados: c });
    if (error) { erros++; continue; }
    aplicados++;
    telNovos += data?.telefones_novos ?? 0;
    mailNovos += data?.emails_novos ?? 0;
    tit += data?.titulos ?? 0;
  }

  return new Response(JSON.stringify({
    pedidos: cpfs.length, aplicados, fora_do_escopo: fora, erros,
    telefones_novos: telNovos, emails_novos: mailNovos, titulos_classificados: tit,
  }), { headers: { "Content-Type": "application/json" } });
});
