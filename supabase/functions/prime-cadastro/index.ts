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
// QUANTOS ALUNOS AO MESMO TEMPO.
//
// O limite que morde aqui NÃO é a Ulbra -- eles liberaram o acesso sem impor
// teto de chamadas. É o tempo da própria Edge Function: 150 segundos por
// invocação, e a resposta só sai no fim. Medido em 25/08/2026, com a função
// reportando a própria duração:
//
//     60 alunos, concorrência 12 -> 67s, 200 OK
//    150 alunos, concorrência 12 -> 504 IDLE_TIMEOUT
//    150 alunos, concorrência  4 -> 504 IDLE_TIMEOUT (duas vezes, e o mutirão
//                                   daquela madrugada não coletou nada)
//
// Dá ~1,1s por aluno, com ~3 chamadas cada (duas buscas por carrier mais o
// composto). Subir a concorrência faz caber mais aluno no mesmo tempo; pedir
// lote grande só estoura e desperdiça a viagem até a Ulbra.
//
// Se um dia eles pedirem para pegar leve, este é o número para baixar.
const CONCORRENCIA = 12;

const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

function cpfFormatado(cpf: string) {
  const d = digitos(cpf);
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

async function primeGet(caminho: string, chave: string) {
  // Guarda o ultimo status para que o erro diga QUAL foi -- sem isso a resposta
  // so dizia "BUSCA_FALHOU" e nao dava para distinguir 404 de 401 ou queda de rede.
  let ultimoStatus = 0;
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
      ultimoStatus = r.status;
      // 503 = "Prime database unavailable", indisponibilidade temporária.
      if (r.status === 503) { await new Promise((s) => setTimeout(s, 1500 * (tentativa + 1))); continue; }
      if (!r.ok) return { ok: false as const, status: r.status };
      return { ok: true as const, dados: await r.json() };
    } catch {
      ultimoStatus = -1;
      await new Promise((s) => setTimeout(s, 1200 * (tentativa + 1)));
    }
  }
  return { ok: false as const, status: ultimoStatus };
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
    if (!busca.ok) return { cpf, erro: `BUSCA_FALHOU_${busca.status}` };
    const itens: any[] = Array.isArray(busca.dados?.items) ? busca.dados.items : [];
    // `search` é substring: confere o CPF antes de aceitar.
    const achado = itens.find((i) => digitos(i?.cpf) === cpf);
    if (achado?.registration) { registration = String(achado.registration); break; }
  }
  if (!registration) return { cpf, foraDoEscopo: true };

  const composto = await primeGet(`/students/${encodeURIComponent(registration)}`, chave);
  if (!composto.ok) return { cpf, erro: `DETALHE_FALHOU_${composto.status}` };

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
      // Fracionario de proposito: documento terminado em 990 da 9,9. Quando isto
      // era gravado como int, um titulo assim derrubava o aluno inteiro.
      parcela: Number(dn.slice(-3)) / 100,
      vencimento: p?.dueDate ? String(p.dueDate).slice(0, 10) : null,
      liquidado_em: p?.paymentDate ? String(p.paymentDate).slice(0, 10) : null,
      // O PORTADOR DO TITULO -- a peca que decide se ainda se cobra.
      //   195 = mensalidade em cobranca (ainda deve)
      //   166 = saiu da cobranca (negociou ou pagou)
      // Vinha na resposta e era descartado. Sem ele so da para saber o portador
      // do ALUNO, que nao serve: quem tem duas matriculas aparece nos dois.
      carrier_id: Number.isFinite(p?.carrier?.id) ? p.carrier.id : null,
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
    .filter((e: unknown) => typeof e === "string" && (e as string).includes("@"))
    .map((e: unknown) => String(e).trim());

  // DIAGNOSTICO -- so contagem, nao muda nada do que e gravado.
  //
  // A pergunta que isto responde: o Prime consegue dizer quem AINDA DEVE?
  // Hoje nao consegue -- os 331.326 titulos que temos estao todos com data de
  // pagamento, e nao existe campo de valor. Falta saber se e a API que so
  // devolve parcela liquidada, ou se a parcela em aberto vem sem boleto e e
  // descartada aqui na linha `if (!it.boleto) continue`.
  //
  // Se `sem_pagamento` vier > 0, a API devolve parcela em aberto e o descarte e
  // nosso -- da para corrigir. Se vier 0 em todo lote, o Prime realmente so tem
  // o que ja foi pago, e divida continua sendo assunto da nossa base.
  const _diag = {
    recebidas: parcelas.length,
    sem_pagamento: parcelas.filter((p: any) => !p?.paymentDate).length,
    sem_boleto: parcelas.filter((p: any) => !String(p?.boleto ?? "").trim()).length,
    // `sem_valor` chuta os nomes `value`/`amount`. Para nao tirar conclusao de um
    // chute, `campos` lista as chaves que a API realmente manda numa parcela --
    // e ai da para ver se existe valor com outro nome.
    sem_valor: parcelas.filter((p: any) => p?.value == null && p?.amount == null).length,
    campos: parcelas.length ? Object.keys(parcelas[0]) : [],
  };

  return { cpf, registration, telefones, emails, contratos, titulos, _diag };
}

async function emLotes<T, R>(itens: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = [];
  for (let i = 0; i < itens.length; i += n) {
    saida.push(...await Promise.all(itens.slice(i, i + n).map(fn)));
  }
  return saida;
}

Deno.serve(async (req) => {
  // Cliente de servico criado logo no inicio: e ele que pergunta ao banco se o
  // token da rotina confere, antes de qualquer outra coisa.
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // PORTÃO DE ACESSO. A função roda com `verify_jwt = false` e decide sozinha
  // quem entra. Não é afrouxamento: são as mesmas duas portas de sempre -- o
  // token dedicado da rotina, ou uma sessão de gestão validada pelo banco. O
  // que saiu foi a exigência de um JWT só para atravessar o portão do Supabase,
  // que obrigava a guardar a anon key no Vault sem ganhar segurança nenhuma
  // (ela é pública, vai no bundle do navegador).
  const autorizacao = req.headers.get("Authorization") ?? "";

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
  // O token vive em UM lugar so, o Vault -- a funcao pergunta ao banco se
  // confere, em vez de guardar uma copia. Dois lugares significaria alguem
  // copiando segredo entre telas, que e quando segredo vaza. A comparacao la
  // dentro usa digest, para nao entregar o segredo pelo tempo de resposta.
  const tokenRecebido = req.headers.get("x-rotina-token") ?? "";
  let ehRotina = false;
  if (tokenRecebido) {
    const { data } = await supa.rpc("prime_cadastro_token_valido", { p_token: tokenRecebido });
    ehRotina = data === true;
  }

  if (!ehRotina) {
    // Sem o token, só passa quem apresentar sessão de gestão.
    if (!autorizacao.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ erro: "SEM_TOKEN" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
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

  // A chave da Prime vem do Vault, no mesmo lugar que o token da rotina. O
  // secret de ambiente continua valendo como alternativa -- se um dia alguem
  // preferir cadastrar pelo painel, funciona sem mudar nada aqui.
  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave) {
    const { data } = await supa.rpc("prime_api_key_backend");
    chave = typeof data === "string" ? data : "";
  }
  if (!chave) {
    return new Response(JSON.stringify({
      erro: "PRIME_API_KEY_AUSENTE",
      detalhe: "cadastre no Vault como 'prime_api_key' ou como secret PRIME_API_KEY da funcao",
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

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

  // Quanto o lote levou. Sem isso, a única forma de descobrir que ele não cabia
  // era o 504 -- que chega depois de já ter torrado a chamada.
  const inicio = Date.now();
  const colhidos = await emLotes(cpfs, CONCORRENCIA, (cpf) => colher(cpf, chave));

  let aplicados = 0, fora = 0, erros = 0, telNovos = 0, mailNovos = 0, tit = 0;
  // POR QUE contar o motivo: em 26/08/2026 a coleta passou cinco horas com 55
  // erros em cada lote de 60 e ninguem sabia de que erro se tratava -- a funcao
  // so devolvia o numero. Cinco horas de chamada desperdicada na Ulbra por
  // falta de uma linha de diagnostico.
  const motivos: Record<string, number> = {};
  const amostra: string[] = [];
  const anotar = (motivo: string, detalhe?: string) => {
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
    if (detalhe && amostra.length < 3) amostra.push(`${motivo}: ${detalhe}`.slice(0, 200));
  };

  // POR QUE guardar quem nao voltou: quando o Prime nao acha o CPF nos dois
  // portadores, nada era gravado em lugar nenhum -- e a fila define "falta
  // coletar" como "nao tem linha em prime_contratos". Como a ordem da fila e
  // deterministica, os mesmos CPFs voltavam a cada 2 minutos. Assim que o topo
  // da fila fosse so gente que o Prime nao conhece, a coleta pararia de vez:
  // resposta 200, `aplicados: 0`, ninguem coletado. Em 31/08 eram 27% do lote.
  const diag: any = { recebidas: 0, sem_pagamento: 0, sem_boleto: 0, sem_valor: 0, campos: {} as Record<string, number> };
  const semRetorno: string[] = [];
  const comErro: string[] = [];
  const okColhidos: string[] = [];

  for (const c of colhidos) {
    if ((c as any).foraDoEscopo) { fora++; semRetorno.push((c as any).cpf); continue; }
    if ((c as any).erro) { erros++; anotar(String((c as any).erro)); comErro.push((c as any).cpf); continue; }
    // o _diag e so nosso: nao vai para a RPC
    const { _diag, ...dados } = c as any;
    if (_diag) {
      diag.recebidas += _diag.recebidas ?? 0;
      diag.sem_pagamento += _diag.sem_pagamento ?? 0;
      diag.sem_boleto += _diag.sem_boleto ?? 0;
      diag.sem_valor += _diag.sem_valor ?? 0;
      for (const k of _diag.campos ?? []) diag.campos[k] = (diag.campos[k] ?? 0) + 1;
    }
    const { data, error } = await supa.rpc("prime_cadastro_aplicar", { p_dados: dados });
    // Erro nosso, nao do Prime -- mas se nao marcar, este CPF prende a fila do
    // mesmo jeito. Fica registrado com o motivo e volta a ser tentado em 7 dias.
    if (error) { erros++; anotar("APLICAR_FALHOU", error.message); comErro.push((c as any).cpf); continue; }
    aplicados++;
    okColhidos.push((c as any).cpf);
    telNovos += data?.telefones_novos ?? 0;
    mailNovos += data?.emails_novos ?? 0;
    tit += data?.titulos ?? 0;
  }

  // Uma chamada por motivo. `p_ok` limpa a marca de quem voltou a ser coletado.
  if (semRetorno.length || okColhidos.length) {
    const { error } = await supa.rpc("prime_cadastro_registrar_tentativa", {
      p_sem_retorno: semRetorno, p_ok: okColhidos, p_motivo: "FORA_DO_ESCOPO",
    });
    if (error) anotar("REGISTRAR_TENTATIVA_FALHOU", error.message);
  }
  if (comErro.length) {
    const { error } = await supa.rpc("prime_cadastro_registrar_tentativa", {
      p_sem_retorno: comErro, p_ok: [], p_motivo: "ERRO_NA_COLETA",
    });
    if (error) anotar("REGISTRAR_TENTATIVA_FALHOU", error.message);
  }

  return new Response(JSON.stringify({
    pedidos: cpfs.length, aplicados, fora_do_escopo: fora, erros,
    marcados_sem_retorno: semRetorno.length + comErro.length,
    telefones_novos: telNovos, emails_novos: mailNovos, titulos_classificados: tit,
    segundos: Math.round((Date.now() - inicio) / 1000), concorrencia: CONCORRENCIA,
    motivos, amostra, diagnostico_parcelas: diag,
  }), { headers: { "Content-Type": "application/json" } });
});
