// CARTEIRA TOTAL x CARTEIRA ACIONADA -- separa posse de trabalho.
//
// POR QUE ISTO EXISTE. O indicador "Casos ativos" conta POSSE
// (`casos.operador_email`), e a base do CRM ainda soma os alunos que entram
// pela posse de ACORDO. O operador lia os dois numeros como "o que eu
// trabalhei" e reclamava de caso que nunca acionou -- com razao: em 29/09/2026,
// 191 dos 3.518 casos ativos nao tinham nenhum acionamento do dono atual, e
// 940 alunos apareciam no CRM sem caso atribuido, so por acordo.
//
// POR QUE NAO USAR `casos.ultima_tabulacao_em`: auditoria de 29/09/2026 mediu
// a coluna NULA em 18.424 de 18.424 linhas de producao. Ela esta morta; usar
// ela daria "100% sem acionamento" para todo mundo.
//
// FONTE DE VERDADE (a mesma do levantamento, toda comprovada em producao):
//   inicio da responsabilidade -> alunos.responsavel_atual_em
//        (preenchido em 4.015/4.015 casos com dono; e
//         casos.operador_email = alunos.responsavel_atual_email em 100% deles)
//   acionamento               -> aluno_movimentacoes, com
//        registrado_por_email = responsavel atual   (autor, nao o caso)
//        registrado_em       >= responsavel_atual_em (depois de receber)
//        tipo                 in TIPOS_ACIONAMENTO_INDIVIDUAL
//
// NAO ALTERA NADA: modulo de leitura. Nao mexe em posse, fidelizacao,
// distribuicao, protecao nem no teto de carteira.

import { buscarTudo } from "./paginado";

// ACIONAMENTO INDIVIDUAL REAL -- trabalho do proprio responsavel sobre aquele
// aluno. Contagens de producao em 29/09/2026 entre parenteses.
export const TIPOS_ACIONAMENTO_INDIVIDUAL = [
  "FINALIZACAO_ATENDIMENTO", // 34.081 -- tabulacao de atendimento, 99% de operador
  "EM_ATENDIMENTO", //          1.537
  "LINK_ENVIADO_AO_ALUNO", //     785
  "COMPROVANTE_ENVIADO_BAIXA", //  607
  "RETORNO_TERMO", //             381
  "BAIXA_REALIZADA", //           859
  "QUITADO_MANUAL", //          1.860
];

// FICAM FORA, DE PROPOSITO (decisao da gestao em 29/09/2026):
//   ACAO_MASSIVA_EXTERNA / _EMAIL  acao massiva -- nao e acionamento individual
//   REDISTRIBUICAO_SINCRONIZACAO   espelho casos->alunos (gatilho do sistema)
//   ASSUMIU_ATENDIMENTO            e a ENTRADA do caso, nao o trabalho nele
//   ATRIBUICAO_ACORDO,
//   ALTERACAO_RESPONSAVEL_ACORDO   posse de acordo, definida pela gestao
//   DEVOLUCAO_DONO, ALTERACAO_OPERADOR, CARTEIRA_GERAL_REMANEJAMENTO,
//   DONO_PELO_RELATORIO_BAIXA      movimentacao de posse
//   REABERTURA_DIVIDA_NOVA, CASO_CRIADO_DIVIDA, ZERADO_REAL_SEM_SALDO,
//   REATIVACAO_AUTOMATICA, CARGA_RETROATIVA, TITULO_EM_CONFIRMACAO_PRIME,
//   BAIXA_CONFERENCIA_PRIME        rotina de sistema / Prime
//   CADASTRO_NOVO_ALUNO,
//   CORRECAO_CADASTRO              cadastro, nao cobranca
//
// LIMITE CONHECIDO: `ACAO_DESFEITA` e `FINALIZACAO_ATENDIMENTO_DESFEITA`
// (29 linhas cada em 29/09/2026) desfazem uma finalizacao, e este modulo NAO
// as desconta -- um atendimento desfeito continua contando como acionado.
// Enquanto for esta ordem de grandeza nao muda nenhum numero de carteira.

export const TEXTO_APOIO =
  "Carteira total considera os casos atualmente atribuídos ao operador. " +
  "Carteira acionada considera casos efetivamente trabalhados pelo responsável " +
  "atual após receber a carteira. Alunos vinculados somente por acordo são " +
  "apresentados separadamente.";

const LOTE_IN = 200;

function emLotes(lista, tamanho = LOTE_IN) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

/**
 * Como o aluno entrou na base do CRM. Nao decide posse -- so rotula.
 *
 * @param {{casoAtivo?: boolean, acordoAtivo?: boolean}} v
 * @returns {"CASO"|"ACORDO"|"CASO_ACORDO"|null}
 */
export function classificarVinculo({ casoAtivo, acordoAtivo } = {}) {
  if (casoAtivo && acordoAtivo) return "CASO_ACORDO";
  if (casoAtivo) return "CASO";
  if (acordoAtivo) return "ACORDO";
  return null;
}

export const ROTULO_VINCULO = {
  CASO: "Caso",
  ACORDO: "Somente acordo",
  CASO_ACORDO: "Caso + acordo",
};

/**
 * Percentual inteiro-com-uma-casa, sem dividir por zero.
 * @returns {number} 0 quando nao ha carteira.
 */
export function percentual(parte, total) {
  if (!total) return 0;
  return Math.round((1000 * parte) / total) / 10;
}

/**
 * Monta os quatro indicadores do operador. Somente leitura.
 *
 * @param {object} cliente cliente supabase
 * @param {string} email e-mail do responsavel atual (o operador da visao)
 * @returns {Promise<{total:number, acionada:number, semAcionamento:number,
 *                    somenteAcordo:number, pctAcionada:number, pctSemAcionamento:number}>}
 */
export async function carregarIndicadoresCarteira(cliente, email) {
  const alvo = String(email || "").toLowerCase().trim();
  const vazio = {
    total: 0,
    acionada: 0,
    semAcionamento: 0,
    somenteAcordo: 0,
    pctAcionada: 0,
    pctSemAcionamento: 0,
  };
  if (!alvo) return vazio;

  // 1) CARTEIRA TOTAL -- casos ativos cujo responsavel atual e o operador.
  // Nao uso `contar_carteira_ativa`: aquela funcao conta VAGA no teto de 500 e
  // por isso desconta o caso que so espera a Conferencia Prime (na medicao de
  // 29/09/2026 ela dava 0 para a Olga, que tem 17 casos ativos atribuidos).
  const casos = await buscarTudo((de, ate) =>
    cliente
      .from("casos")
      .select("id,aluno_id")
      .eq("encerrado_operacional", false)
      .ilike("operador_email", alvo)
      .order("id", { ascending: true })
      .range(de, ate)
  );

  const idsCaso = [...new Set(casos.map((c) => c.aluno_id).filter(Boolean).map(String))];
  const total = casos.length;

  // 2) Inicio da responsabilidade, aluno por aluno.
  const inicioPorAluno = new Map();
  for (const lote of emLotes(idsCaso)) {
    const linhas = await buscarTudo((de, ate) =>
      cliente
        .from("alunos")
        .select("id,responsavel_atual_em")
        .in("id", lote)
        .order("id", { ascending: true })
        .range(de, ate)
    );
    for (const a of linhas) {
      if (a.responsavel_atual_em) inicioPorAluno.set(String(a.id), new Date(a.responsavel_atual_em));
    }
  }

  // 3) Acionamentos do proprio responsavel. Corta pelo inicio mais antigo da
  // carteira para nao trazer o historico inteiro do operador.
  const inicios = [...inicioPorAluno.values()];
  const maisAntigo = inicios.length
    ? new Date(Math.min(...inicios.map((d) => d.getTime())))
    : null;

  const ultimoAcionamento = new Map();
  if (maisAntigo) {
    for (const lote of emLotes(idsCaso)) {
      const movs = await buscarTudo((de, ate) =>
        cliente
          .from("aluno_movimentacoes")
          .select("aluno_id,registrado_em")
          .in("aluno_id", lote)
          .in("tipo", TIPOS_ACIONAMENTO_INDIVIDUAL)
          .ilike("registrado_por_email", alvo)
          .gte("registrado_em", maisAntigo.toISOString())
          .order("id", { ascending: true })
          .range(de, ate)
      );
      for (const m of movs) {
        const chave = String(m.aluno_id);
        const quando = new Date(m.registrado_em);
        const atual = ultimoAcionamento.get(chave);
        if (!atual || quando > atual) ultimoAcionamento.set(chave, quando);
      }
    }
  }

  // 4) CARTEIRA ACIONADA -- por CASO, nao por aluno (a unidade nao se mistura).
  let acionada = 0;
  for (const c of casos) {
    const chave = String(c.aluno_id || "");
    const inicio = inicioPorAluno.get(chave);
    const ultimo = ultimoAcionamento.get(chave);
    if (inicio && ultimo && ultimo >= inicio) acionada += 1;
  }

  // 5) SOMENTE ACORDO -- unidade ALUNO. Aluno que aparece no CRM porque o
  // acordo ativo e do operador, sem caso ativo dele para o mesmo aluno.
  const acordos = await buscarTudo((de, ate) =>
    cliente
      .from("acordos")
      .select("aluno_id")
      .eq("status", "ATIVO")
      .ilike("operador_responsavel_email", alvo)
      .order("id", { ascending: true })
      .range(de, ate)
  );
  const comCaso = new Set(idsCaso);
  const somenteAcordo = new Set(
    acordos
      .map((a) => a.aluno_id)
      .filter(Boolean)
      .map(String)
      .filter((id) => !comCaso.has(id))
  ).size;

  const semAcionamento = total - acionada;
  return {
    total,
    acionada,
    semAcionamento,
    somenteAcordo,
    pctAcionada: percentual(acionada, total),
    pctSemAcionamento: percentual(semAcionamento, total),
  };
}
