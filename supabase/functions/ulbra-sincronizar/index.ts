// Edge Function: ulbra-sincronizar
// ---------------------------------------------------------------------------
// O ÚNICO relógio da integração com a Mensageria ULBRA. Roda por cron, com
// chave própria, e NÃO atende a tela de ninguém.
//
// SÓ LÊ da ULBRA: `listar_conversas`, `ler_conversa` e `listar_atendimentos`
// são de leitura. Nenhuma mensagem é enviada, nenhum atendimento é assumido,
// transferido ou encerrado, nenhum cadastro é tocado.
//
// Escreve só no NOSSO banco, por uma RPC só (`ulbra_sync_gravar`).
//
// ORÇAMENTO: cada chamada passa pelo portão `Orcamento` ANTES de sair. O saldo
// do dia nunca passa de TETO_DIARIO_SYNC (500 - reserva das fichas). Isso é
// limite controlado pelo código. O consumo previsto é outra coisa.
//
// ACESSO: `x-sync-chave` == segredo `ULBRA_SYNC_CHAVE`. `verify_jwt = false`
// porque quem chama é o cron. Sem a chave, 403 e nenhuma chamada à ULBRA.
//
// FALHA FECHADO: erro em listar/atendimentos grava FALHOU e não move a janela.
// Erro em ler_conversa conta como falha da conversa (retentativa), não do ciclo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ACCEPT_MCP,
  CADENCIA_PADRAO,
  DETALHE_TENTATIVAS_MAX,
  MCP_URL,
  TETO_DIARIO_SYNC,
  Orcamento,
  cargaAtendimentos,
  cargaConversas,
  cargaDetalhe,
  candidatasDaColheita,
  colherConversas,
  decidirDestino,
  cargaMeuAcesso,
  decidirDetalhe,
  saldoDoMeuAcesso,
  identificar,
  lerAtendimentos,
  lerCorpoMcp,
  novaJanela,
  portaoSync,
  resultadoDoEnvelope,
  selecionarDetalhes,
  type AtendimentoLido,
  type Colheita,
  type ConversaLida,
  type FilaDetalhe,
  type Janela,
  type OperadorRodizio,
  type VinculoAtivo,
} from "./sincronizar.ts";

/**
 * Leituras de detalhe (`ler_conversa`) por ciclo. Cada uma custa 1 chamada.
 * Prova de convergência e orçamento: sincronizar.test.ts ("fila de detalhes")
 * e docs/integracoes/ulbra-etapa1-pacote-aprovacao.md, seção 4.
 */
export const DETALHE_POR_CICLO = 1;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-chave",
};

const json = (corpo: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// O portão (`portaoSync`) mora em `sincronizar.ts`, fora do `Deno.serve`, para
// ser provado sem rede e sem gastar chamada da Mensageria — ver
// `sincronizar.test.ts`, "portão da chave".

async function chamarMcp(token: string, carga: unknown): Promise<unknown> {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: ACCEPT_MCP,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(carga),
  });
  if (!resp.ok) {
    throw new Error(resp.status === 429 ? "ULBRA_LIMITE" : `ULBRA_HTTP_${resp.status}`);
  }
  return resultadoDoEnvelope(lerCorpoMcp(resp.headers.get("content-type"), await resp.text()));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const segredo = Deno.env.get("ULBRA_SYNC_CHAVE");
  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  const urlBanco = Deno.env.get("SUPABASE_URL");
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!segredo || !token || !urlBanco || !servico) {
    console.error("ulbra-sincronizar: ambiente incompleto");
    return json({ erro: "CONFIG_AUSENTE" }, 500);
  }
  const portao = portaoSync(req.headers.get("x-sync-chave"), segredo);
  if (!portao.ok) return json(portao.corpo, portao.status);

  const sb = createClient(urlBanco, servico, { auth: { persistSession: false } });

  // ---------------------------------------------------------------- estado
  const { data: estado } = await sb
    .from("ulbra_sync_estado")
    .select("cursor_mensagem, piso_pendente, topo_processado, chamadas_dia, dia, ciclos_desde_atendimentos, saldo_api_restam, saldo_api_em")
    .eq("id", true)
    .maybeSingle();

  const janela: Janela = {
    cursor: estado?.cursor_mensagem ?? null,
    pendente: estado?.piso_pendente ?? null,
    topo: estado?.topo_processado ?? null,
  };
  const hoje = new Date().toISOString().slice(0, 10);
  const chamadasAntes: number = estado?.dia === hoje ? (estado?.chamadas_dia ?? 0) : 0;
  const ciclosDesde: number = estado?.ciclos_desde_atendimentos ?? 999;

  const orcamento = new Orcamento(TETO_DIARIO_SYNC - chamadasAntes);
  // Saldo DIÁRIO da pessoa do token (meu_acesso, limites.pessoaPorDia.restam).
  // Consultado no máximo a cada 60 min; o valor em cache limita o orçamento
  // enquanto estiver fresco. Ele inclui OAuth e fichas: é o limite real.
  const SALDO_VALIDO_MS = 60 * 60 * 1000;
  let saldoApiNovo: { restam: number; em: string } | null = null;
  const saldoEmMs = estado?.saldo_api_em ? Date.parse(estado.saldo_api_em) : 0;
  const saldoCacheFresco = Date.now() - saldoEmMs < SALDO_VALIDO_MS;
  if (saldoCacheFresco && estado?.saldo_api_restam != null) {
    orcamento.ajustarAoSaldoDaApi(estado.saldo_api_restam);
  }
  if (!orcamento.pode()) {
    await sb.rpc("ulbra_sync_gravar", {
      p_payload: { ciclo: "PULADO_ORCAMENTO", chamadas: 0, dia: hoje, erro: "ORCAMENTO_DO_DIA" },
    });
    return json({ ciclo: "PULADO_ORCAMENTO", chamadas_dia: chamadasAntes, teto: TETO_DIARIO_SYNC });
  }

  // Toda chamada à ULBRA passa por aqui: o saldo é gasto ANTES de sair.
  let chamadas = 0;
  const chamar = async (carga: unknown) => {
    orcamento.gastar();
    chamadas++;
    return chamarMcp(token, carga);
  };
  const pode = () => orcamento.pode();

  // ------------------------------------------------- referências do CRM
  const [{ data: vinculosBrutos }, { data: filaBruta }, { data: detalhesFila }] = await Promise.all([
    sb.from("ulbra_vinculos").select("ulbra_cliente_id, aluno_id, confianca").is("desvinculado_em", null),
    sb.from("fila_receptivo").select("email, atendimentos_hoje, ultimo_atendimento, em_pausa, online_em"),
    sb
      .from("ulbra_detalhe_fila")
      .select("ulbra_conversa_id, ulbra_cliente_id, na_lista_em, tentativas, antes_de, paginas_lidas")
      .order("na_lista_em", { ascending: true })
      .limit(1000),
  ]);

  const vinculos = new Map<string, VinculoAtivo>(
    (vinculosBrutos ?? []).map((v) => [v.ulbra_cliente_id as string, v as VinculoAtivo]),
  );
  const fila = (filaBruta ?? []) as OperadorRodizio[];
  const agoraMs = Date.now();

  // Saldo real: 1 chamada de meu_acesso quando o cache venceu. Falha aqui não
  // derruba o ciclo: segue só com o controle local, e isso é registrado.
  if (!saldoCacheFresco && pode()) {
    try {
      const restam = saldoDoMeuAcesso(await chamar(cargaMeuAcesso()));
      if (restam !== null) {
        orcamento.ajustarAoSaldoDaApi(restam);
        saldoApiNovo = { restam, em: new Date().toISOString() };
      }
    } catch (e) {
      console.error("ulbra-sincronizar: meu_acesso falhou", (e as Error).message);
    }
  }

  // ------------------------------------------------------------- leitura
  let atendimentos: AtendimentoLido[] = [];
  let atendimentosLidos = false;
  let colheita: Colheita;
  const lerAtendimentosAgora =
    ciclosDesde >=
    Math.max(
      1,
      Math.round(CADENCIA_PADRAO.cadencia_atendimentos_min / CADENCIA_PADRAO.cadencia_conversas_min),
    );

  // Resultados do detalhe, aplicados na gravação.
  const concluidas: Array<{ ulbra_conversa_id: string; ultima_mensagem_cliente_em: string | null }> = [];
  const falhas: string[] = [];
  const continuar: Array<{ ulbra_conversa_id: string; antes_de: string; paginas_lidas: number }> = [];
  const pendenciasAlcance: Array<{
    ulbra_conversa_id: string; ulbra_cliente_id: string; na_lista_em: string; antes_de: string | null;
  }> = [];
  let desistidas: FilaDetalhe[] = [];
  let novas: FilaDetalhe[] = [];

  try {
    colheita = await colherConversas((pagina) => chamar(cargaConversas(pagina, pagina)), janela, { pode });

    // Fila: mantém o que já estava (com suas tentativas) e acrescenta o novo.
    novas = candidatasDaColheita(colheita.conversas);
    const mapa = new Map<string, FilaDetalhe>(
      (detalhesFila ?? []).map((f) => [f.ulbra_conversa_id as string, f as FilaDetalhe]),
    );
    for (const n of novas) if (!mapa.has(n.ulbra_conversa_id)) mapa.set(n.ulbra_conversa_id, n);

    const sel = selecionarDetalhes([...mapa.values()], DETALHE_POR_CICLO);
    desistidas = sel.desistidas;

    for (const f of sel.escolhidas) {
      if (!pode()) break; // sem saldo: as que sobraram seguem na fila
      try {
        const resposta = await chamar(cargaDetalhe(f.ulbra_conversa_id, f.antes_de ?? null));
        const paginasLidas = f.paginas_lidas ?? 0;
        const passo = decidirDetalhe(resposta, paginasLidas);
        if (passo.acao === "CONCLUIR") {
          concluidas.push({ ulbra_conversa_id: f.ulbra_conversa_id, ultima_mensagem_cliente_em: passo.ultima_cliente });
        } else if (passo.acao === "CONTINUAR") {
          // Não é falha: a conversa segue na fila, retomando em `antes_de`.
          continuar.push({ ulbra_conversa_id: f.ulbra_conversa_id, antes_de: passo.antes_de, paginas_lidas: paginasLidas + 1 });
        } else {
          // Alcance esgotado: pendência VISÍVEL, com ponto de retomada. Nunca "sem resposta".
          pendenciasAlcance.push({
            ulbra_conversa_id: f.ulbra_conversa_id,
            ulbra_cliente_id: f.ulbra_cliente_id,
            na_lista_em: f.na_lista_em,
            antes_de: passo.antes_de || null,
          });
        }
      } catch (e) {
        console.error("ulbra-sincronizar: detalhe falhou", (e as Error).message);
        falhas.push(f.ulbra_conversa_id);
      }
    }

    if (lerAtendimentosAgora && pode()) {
      atendimentos = lerAtendimentos(await chamar(cargaAtendimentos(99)));
      atendimentosLidos = true;
    }
  } catch (e) {
    const motivo = (e as Error).message;
    console.error("ulbra-sincronizar: ciclo falhou", motivo);
    // FALHOU não grava janela nem espelho: o próximo ciclo refaz a mesma coleta.
    await sb.rpc("ulbra_sync_gravar", {
      p_payload: { ciclo: "FALHOU", chamadas, dia: hoje, erro: motivo },
    });
    return json({ ciclo: "FALHOU", erro: motivo, chamadas }, 502);
  }

  const proxima = novaJanela(janela, colheita);

  // ------------------------------------------------------------- decisão
  const clientes = [...new Set(atendimentos.map((a) => a.ulbra_cliente_id))];
  const alunosDosClientes = clientes
    .map((c) => identificar(c, vinculos))
    .filter((i) => i.aluno_id)
    .map((i) => i.aluno_id as string);

  const donoPorAluno = new Map<string, string | null>();
  if (alunosDosClientes.length > 0) {
    const { data: casos } = await sb
      .from("casos")
      .select("aluno_id, operador_email")
      .in("aluno_id", alunosDosClientes);
    for (const c of casos ?? []) {
      const anterior = donoPorAluno.get(c.aluno_id as string) ?? null;
      donoPorAluno.set(c.aluno_id as string, anterior ?? (c.operador_email as string | null));
    }
  }

  const linhasConversas = colheita.conversas.map((c: ConversaLida) => {
    const identidade = identificar(c.ulbra_cliente_id, vinculos);
    // Data do cliente: a da lista quando a última é do cliente; a do detalhe, se lido.
    const doDetalhe = concluidas.find((x) => x.ulbra_conversa_id === c.ulbra_conversa_id);
    return {
      ...c,
      ultima_mensagem_cliente_em: c.ultima_mensagem_cliente_em ?? doDetalhe?.ultima_mensagem_cliente_em ?? null,
      ...identidade,
    };
  });

  const linhasAtendimentos = atendimentos.map((a) => {
    const identidade = identificar(a.ulbra_cliente_id, vinculos);
    const dono = identidade.aluno_id ? (donoPorAluno.get(identidade.aluno_id) ?? null) : null;
    const destino = decidirDestino({ identidade, caso: { operador_email: dono }, fila }, agoraMs);
    return { ...a, ...identidade, ...destino };
  });

  // -------------------------------------------------------------- gravação
  const { data: gravado, error } = await sb.rpc("ulbra_sync_gravar", {
    p_payload: {
      // INCOMPLETO grava o que foi lido e guarda a janela (ver novaJanela).
      ciclo: colheita.truncado ? "INCOMPLETO" : "OK",
      erro: colheita.truncado ? "BACKLOG_OU_ORCAMENTO" : undefined,
      chamadas,
      dia: hoje,
      cursor: proxima.cursor,
      piso_pendente: proxima.pendente,
      topo_processado: proxima.topo,
      atendimentos_lidos: atendimentosLidos,
      conversas: linhasConversas,
      atendimentos: linhasAtendimentos,
      detalhe_enfileirar: novas.map((f) => ({
        ulbra_conversa_id: f.ulbra_conversa_id,
        ulbra_cliente_id: f.ulbra_cliente_id,
        na_lista_em: f.na_lista_em,
      })),
      detalhe_concluidas: concluidas,
      saldo_api: saldoApiNovo,
      detalhe_continuar: continuar,
      detalhe_falhas: falhas,
      // Nada é descartado: cada pendência tem motivo e, quando couber, ponto de retomada.
      detalhe_pendencias: [
        ...desistidas.map((f) => ({
          ulbra_conversa_id: f.ulbra_conversa_id,
          ulbra_cliente_id: f.ulbra_cliente_id,
          na_lista_em: f.na_lista_em,
          motivo: "FALHAS_ESGOTADAS",
          antes_de: null,
        })),
        ...pendenciasAlcance.map((p) => ({ ...p, motivo: "ALCANCE_ESGOTADO" })),
      ],
    },
  });
  if (error) {
    console.error("ulbra-sincronizar: gravação falhou", error.message);
    return json({ ciclo: "FALHOU", erro: "GRAVACAO", detalhe: error.message }, 500);
  }

  return json({
    ciclo: colheita.truncado ? "INCOMPLETO" : "OK",
    ciclo_completo: !colheita.truncado,
    chamadas,
    chamadas_dia: chamadasAntes + chamadas,
    teto_dia: TETO_DIARIO_SYNC,
    leituras: colheita.leituras,
    conversas_novas: linhasConversas.length,
    detalhes_lidos: concluidas.length,
    detalhes_falharam: falhas.length,
    detalhes_pendencias_novas: desistidas.length + pendenciasAlcance.length,
    atendimentos_em_espera: atendimentosLidos ? linhasAtendimentos.length : null,
    gravado,
  });
});
