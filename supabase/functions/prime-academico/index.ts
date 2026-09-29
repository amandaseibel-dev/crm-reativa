// Edge Function: prime-academico
// -----------------------------------------------------------------------------
// CONSULTA A SITUAÇÃO ACADÊMICA de um aluno no Prime e GRAVA a resposta inteira,
// linha por linha. Só lê da API; a única escrita é no nosso registro de consulta.
//
// POR QUE EXISTE. A situação acadêmica vem de `students_search` →
// `items[].status`, e é **por vínculo de curso**, não da pessoa. Sondado em
// 28/09/2026 (6 alunos, 35 vínculos): `registration` repete-se idêntico em todas
// as linhas do mesmo aluno, e os status dessas linhas discordam entre si. Ver
// docs/integracoes/prime-api.md.
//
// O QUE ESTA FUNÇÃO NUNCA FAZ:
//   - não escreve em `alunos`, e não toca `alunos.situacao_academica`;
//   - não escolhe uma linha como "a" situação da pessoa;
//   - não usa `contracts[].status` (status de CONTRATO) como substituto;
//   - não mexe em saldo, cobrança ou classificação da Efetividade.
//
// ACESSO: o gateway exige JWT válido (`verify_jwt = true`, em
// supabase/config.toml) e, além disso, o portão exige token de rotina OU sessão
// de gestão. Nenhuma das duas portas dispensa o gateway -- nem a da rotina.
// O portão é o mesmo módulo testado da `prime-sonda`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decidirAcesso } from "../prime-sonda/portao.ts";
import {
  desfecho, formatarCpf, paginarComAutorizacao,
  registrationDoCabecalho, vinculosDaResposta,
} from "./academico.ts";

const BASE = "https://prime-api.ulbra.ai/api";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token",
};

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const autorizacao = req.headers.get("Authorization") ?? "";
  const decisao = await decidirAcesso({
    tokenRecebido: req.headers.get("x-rotina-token") ?? "",
    segredoRotina: Deno.env.get("ROTINA_TOKEN") ?? Deno.env.get("PRIME_CADASTRO_TOKEN") ?? "",
    autorizacao,
    validarGestao: async (auth) => {
      const cliente = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } },
      );
      const { data, error } = await cliente.rpc("usuario_e_gestao");
      return !error && data === true;
    },
  });
  if (!decisao.ok) return json(decisao.corpo, decisao.status);

  const corpo = await req.json().catch(() => ({}));
  const alunoId = String(corpo?.aluno_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(alunoId)) return json({ erro: "ALUNO_ID_INVALIDO" }, 400);

  // Item do piloto, quando a chamada vem do lote. A ficha nao manda -- e por
  // isso o mesmo endpoint serve aos dois sem a tela precisar saber do piloto.
  const pilotoItem = String(corpo?.piloto_item_id ?? "").trim();
  const noPiloto = /^[0-9a-f-]{36}$/i.test(pilotoItem);
  const pilotoExec = String(corpo?.piloto_execucao ?? "").trim() || null;

  // O CPF vem DO BANCO, não do chamador. Quem manda o CPF na requisição
  // decide de quem é a consulta; quem manda o id do aluno pergunta sobre uma
  // ficha, e o CPF sai de lá. É a diferença entre consultar um aluno e
  // consultar um CPF arbitrário com a chave da Ulbra.
  const { data: aluno, error: erroAluno } = await supa
    .from("alunos").select("id, cpf").eq("id", alunoId).maybeSingle();
  if (erroAluno) return json({ erro: "BANCO_FALHOU", detalhe: erroAluno.message }, 502);
  if (!aluno) return json({ erro: "ALUNO_NAO_ENCONTRADO" }, 404);

  const cpf = formatarCpf(aluno.cpf);
  if (!cpf) return json({ erro: "CPF_INVALIDO_NA_FICHA" }, 422);

  // quem pediu -- só para carimbar o registro
  let email: string | null = null;
  if (autorizacao.startsWith("Bearer ")) {
    const cliente = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: autorizacao } } },
    );
    const { data } = await cliente.auth.getUser();
    email = data?.user?.email ?? null;
  }

  // ORÇAMENTO E PAR ITEM↔ALUNO vêm do SERVIDOR, nunca do corpo do pedido:
  // quem chama não pode escolher o próprio teto nem mandar consultar um aluno
  // que não é o do item reservado.
  // Pré-checagem: recusa cedo o que nem deveria começar (item de outro aluno,
  // item não reservado, lote interrompido). O ORÇAMENTO em si não vem daqui --
  // quem controla é a autorização de cada página, mais abaixo.
  if (noPiloto) {
    const { data: val, error: erroVal } = await supa.rpc("prime_academico_piloto_validar", {
      p_item: pilotoItem, p_aluno_id: alunoId,
    });
    if (erroVal) return json({ erro: "PILOTO_VALIDACAO_FALHOU", detalhe: erroVal.message }, 502);
    const v = val as { ok?: boolean; motivo?: string; orcamento?: number } | null;
    if (!v?.ok) return json({ erro: "PILOTO_ITEM_INVALIDO", detalhe: v?.motivo ?? "?" }, 409);
    if (Number(v.orcamento ?? 0) <= 0) {
      return json({ erro: "PILOTO_SEM_ORCAMENTO", detalhe: "teto de requisicoes esgotado" }, 409);
    }
  }

  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave) {
    const { data } = await supa.rpc("prime_chave_api");
    chave = typeof data === "string" ? data : "";
  }
  if (!chave) return json({ erro: "CHAVE_INDISPONIVEL" }, 500);

  // ---------------------------------------------------------------------------
  // A CHAMADA, PAGINADA.
  //
  // `take=50` sozinho era um teto silencioso: quem tivesse 51 vínculos perdia o
  // 51º sem nenhum sinal. Numa tela que decide cobrança, perder linha em
  // silêncio é pior do que não mostrar nada.
  //
  // Três desfechos, gravados como estados distintos. Achatar falha de rede em
  // "sem informação" viraria "o aluno não tem vínculo".
  // ---------------------------------------------------------------------------
  const TAKE = 50;
  const TETO = 500; // trava de seguranca: nunca girar para sempre

  const pag = await paginarComAutorizacao({
    take: TAKE, teto: TETO,
    // AUTORIZAR É DEBITAR. Sem lote, não há orçamento a controlar e a ficha
    // segue como sempre seguiu.
    autorizar: noPiloto
      ? async () => {
          const { data, error } = await supa.rpc("prime_academico_piloto_autorizar_pagina", {
            p_item: pilotoItem, p_aluno_id: alunoId, p_execucao: pilotoExec,
          });
          if (error) return { ok: false, motivo: "AUTORIZACAO_FALHOU: " + error.message };
          const d = data as { ok?: boolean; motivo?: string } | null;
          return { ok: d?.ok === true, motivo: d?.motivo };
        }
      : null,
    buscar: async (skip) => {
      try {
        const r = await fetch(
          `${BASE}/students?search=${encodeURIComponent(cpf)}&take=${TAKE}&skip=${skip}`,
          { method: "GET", headers: { "X-API-Key": chave } },
        );
        return { http: r.status, ok: r.ok, texto: await r.text() };
      } catch (e) {
        // rede, DNS, timeout -- nunca vaza a chave: so a classe do erro.
        return { erro: `falha de rede: ${(e as Error)?.name ?? "erro"}` };
      }
    },
  });

  const brutos = pag.brutos;
  const requisicoes = pag.requisicoes;
  const httpStatus = pag.httpStatus;
  // O total DECLARADO pela Ulbra, quando ela declara. Não é a contagem das
  // linhas que ficaram: serve justamente para comparar uma com a outra.
  const totalItems = pag.totalItems;
  const paginaIlegivel = pag.paginaIlegivel;
  const chegouAoFim = pag.chegouAoFim;
  let falha = pag.falha;
  const orcamentoEstourou = pag.negou !== null;

  // O FILTRO VEM ANTES DO DESFECHO. Uma busca que traga só linhas de OUTRA
  // pessoa (o `search` é substring) tem items > 0 e zero vínculos desta ficha:
  // chamar isso de COM_VINCULOS faria a tela dizer "consultei e encontrei" e
  // mostrar tabela vazia.
  const vinculos = falha || paginaIlegivel ? [] : vinculosDaResposta(brutos, aluno.cpf);
  const resultado = desfecho(falha, paginaIlegivel, vinculos,
                             chegouAoFim && !orcamentoEstourou);
  const registration = registrationDoCabecalho(vinculos);
  if (paginaIlegivel && !falha) falha = "resposta ilegivel (corpo sem items)";
  // O motivo fica escrito: a tela precisa dizer POR QUE a lista pode estar
  // incompleta, e "bateu no teto" é diferente de "a API caiu".
  if (resultado === "PAGINACAO_INCOMPLETA" && !falha) {
    falha = orcamentoEstourou
      // Negada na PRIMEIRA página, nada foi perguntado à Ulbra: não há "lista
      // incompleta", há lista nenhuma. Dizer a mesma frase nos dois casos
      // faria parecer que houve resposta parcial.
      ? (requisicoes === 0
          ? `consulta nao realizada: ${pag.negou} -- nenhuma requisicao foi enviada`
          : `paginacao interrompida: ${pag.negou} (${requisicoes} requisicao(oes)) -- a lista pode estar incompleta`)
      : `paginacao interrompida no teto de ${TETO} linhas -- a lista pode estar incompleta`;
  }

  const { data: consultaId, error: erroGravar } = await supa.rpc("prime_academico_registrar", {
    p_aluno_id: alunoId,
    p_cpf: cpf,
    p_registration: registration,
    p_resultado: resultado,
    p_detalhe_falha: falha,
    p_http_status: httpStatus,
    p_total_items: totalItems,
    p_vinculos: vinculos,
    p_email: email,
    p_requisicoes: requisicoes,
  });
  if (erroGravar) {
    // AS REQUISIÇÕES JÁ FORAM GASTAS. A API recebeu as chamadas mesmo que o
    // nosso INSERT tenha falhado -- e o teto do lote precisa lembrar disso,
    // senão o orçamento passa a contar menos do que a Ulbra realmente recebeu.
    // Por isso o item é fechado como FALHOU com o gasto REAL, antes de
    // devolver o erro.
    let contabilizado = false;
    let erroContingencia: string | null = null;
    if (noPiloto) {
      const { data: cont, error: erroCont } = await supa.rpc("prime_academico_piloto_registrar", {
        p_item: pilotoItem, p_consulta_id: null, p_requisicoes: requisicoes,
        p_http: httpStatus, p_erro: "gravacao da consulta falhou: " + erroGravar.message,
        p_aluno_id: alunoId, p_execucao: pilotoExec,
      });
      // AS DUAS GRAVAÇÕES PODEM FALHAR. Dizer "gasto contabilizado" sem
      // confirmar seria a pior saída: quem lê acredita que o teto está certo.
      const c = cont as { recusado?: boolean; motivo?: string } | null;
      erroContingencia = erroCont ? erroCont.message
        : (c?.recusado ? (c.motivo ?? "registro recusado") : null);
      contabilizado = erroContingencia === null;
    }
    return json({
      erro: "GRAVACAO_FALHOU", detalhe: erroGravar.message, requisicoes,
      gasto_contabilizado: contabilizado,
      ...(contabilizado
        ? { aviso: "as requisicoes gastas foram contabilizadas no lote" }
        : { aviso: "ATENCAO: o gasto NAO foi contabilizado (" + (erroContingencia ?? "?")
                   + "); as paginas autorizadas ja debitaram, mas o item nao foi fechado",
            erro_contingencia: erroContingencia }),
    }, 502);
  }

  // REGISTRO NO PILOTO. Acontece aqui, e nao no navegador, porque a RPC de
  // registro so atende service_role -- e porque so aqui se sabe quantas
  // requisicoes a consulta gastou.
  //
  // 401/403/429 interrompem o LOTE inteiro: e a propria RPC que decide isso, a
  // partir do `p_http` que vai daqui.
  let pararLote = false;
  let motivoLote: string | null = null;
  if (noPiloto) {
    const { data: reg, error: erroReg } = await supa.rpc("prime_academico_piloto_registrar", {
      p_item: pilotoItem,
      p_consulta_id: consultaId,
      p_requisicoes: requisicoes,
      p_http: httpStatus,
      p_erro: falha,
      p_aluno_id: alunoId,
      p_execucao: pilotoExec,
    });
    if (erroReg) {
      // A CONSULTA JÁ FOI GRAVADA -- e já foi paga em requisições. Seguir o
      // lote aqui faria o próximo item rodar sem que este tivesse sido
      // contabilizado, e o teto viraria ficção. Para, e diz onde parou: a
      // reconciliação fecha este item pela consulta que existe, sem chamar o
      // Prime de novo.
      return json({
        erro: "PILOTO_REGISTRO_FALHOU",
        detalhe: erroReg.message,
        consulta_id: consultaId,
        requisicoes,
        recuperavel: true,
        aviso: "a consulta FOI gravada; retomar o lote reconcilia este item sem consultar de novo",
      }, 502);
    }
    const rr = reg as { parar?: boolean; recusado?: boolean; motivo?: string } | null;
    if (rr?.recusado) {
      // Outra aba assumiu o lote enquanto esta consultava. O resultado foi
      // gravado na consulta (nao se perde), mas o item nao e fechado por uma
      // execucao que ja nao conduz nada.
      return json({ erro: "PILOTO_EXECUCAO_SUPERADA", detalhe: rr.motivo ?? "?",
                    consulta_id: consultaId, requisicoes }, 409);
    }
    pararLote = rr?.parar === true;
    motivoLote = rr?.motivo ?? null;
  }

  // Devolve o mesmo formato que a tela lê do banco, para ela não precisar de
  // dois caminhos de renderização.
  const { data: leitura } = await supa.rpc("prime_academico_ultima", { p_aluno_id: alunoId });
  return json({
    ok: true, consulta_id: consultaId, resultado, leitura,
    requisicoes,
    ...(noPiloto ? { piloto: { parar: pararLote, motivo: motivoLote } } : {}),
  });
});
