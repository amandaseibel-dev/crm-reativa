// Decisão de VÍNCULO SEGURO entre aluno do CRM e cliente da Mensageria Ulbra.
// Pura e sem Deno de propósito: toda a regra que decide se um vínculo pode ou
// não nascer mora aqui, e é testada sem banco, sem rede e sem Deno.env.
//
// ===========================================================================
// O DEFEITO QUE ISTO FECHA (auditoria de 04/11/2026)
//
// A Etapa 1 (PR #813) gravava vínculo assim:
//
//     const escolha = escolherContato(aluno);   // PREFERE telefone
//     ... conferir_duplicidade([escolha.contato]) ...
//     insert({ ..., confianca: "alta", origem: escolha.origem })
//
// Três problemas, nessa ordem de gravidade:
//
// 1. `confianca: "alta"` era CRAVADO, qualquer que fosse a origem. Um vínculo
//    achado por telefone recebia o mesmo selo de um achado por CPF. Telefone
//    não é identidade: é contato. Telefone de mãe, de cônjuge, de irmão, de
//    recado e número reciclado por operadora casam com o cliente ERRADO e o
//    vínculo nasce "alta" sem nada ter sido provado.
//
// 2. O CPF só era usado como FALLBACK — e só quando o telefone estava ausente
//    ou malformado. Aluno com telefone válido nunca tinha o CPF consultado,
//    isto é: a única chave de identidade real do aluno (Premissa "um CPF por
//    aluno") era justamente a que não era perguntada.
//
// 3. Nada impedia que o MESMO `ulbra_cliente_id` fosse vinculado a vários
//    alunos. O índice único de produção é
//    `ulbra_vinculos_aluno_ativo_uniq (aluno_id) WHERE desvinculado_em IS NULL`
//    — um vínculo ativo por ALUNO. O lado do CLIENTE estava livre: N alunos
//    podiam apontar para o mesmo cliente da Mensageria, cada um achando que
//    era o seu.
//
// Isto não é hipótese de laboratório. A memória
// `vinculo-automatico-forte-vinculava-errado` registra o custo medido da mesma
// classe de erro em outra frente do CRM: 116 vínculos criados por casamento
// automático forte, R$ 24.460,12 deslocados, desfazer ainda EM ABERTO. Vínculo
// automático só é seguro quando a chave é identidade e a discordância bloqueia.
//
// ===========================================================================
// A REGRA, EM UMA FRASE
//
// Vínculo automático nasce SÓ quando o CPF confirma, e NÃO nasce quando as
// chaves discordam, quando o cliente já é de outro aluno, ou quando a única
// prova é o telefone. Nos casos barrados o aluno fica SEM vínculo e o motivo
// é dito — nunca se grava "alta" no escuro.
//
// Por que barrar em vez de gravar fraco: `ulbra-atendimento` (PR #814) abre
// atendimento para QUALQUER vínculo ativo, sem ler `confianca`. Um vínculo
// fraco gravado como ativo seria, uma função adiante, um atendimento aberto no
// cliente errado. Então o que não foi provado não entra na tabela.

/** Níveis de confiança aceitos em `ulbra_vinculos.confianca`. */
export const CONFIANCA = {
  /** CPF confirmou o cliente. Único nível que esta função grava sozinha. */
  ALTA_CPF: "alta_cpf",
  /** Legado: gravado pela Etapa 1 sem confirmação de CPF. Nunca mais escrito. */
  LEGADO_ALTA: "alta",
  /** Gestão marcou como duvidoso à mão. */
  AMBIGUA: "ambigua",
  /** Legado marcado para reconferência. Nunca escrito automaticamente. */
  RECONFIRMAR: "reconfirmar",
} as const;

/** Os níveis que NÃO são prova de identidade. */
export const CONFIANCA_NAO_PROVADA: string[] = [
  CONFIANCA.LEGADO_ALTA,
  CONFIANCA.AMBIGUA,
  CONFIANCA.RECONFIRMAR,
];

export interface VinculoExistente {
  ulbra_cliente_id: string;
  confianca: string;
  origem: string;
  vinculado_em?: string | null;
}

export type MotivoBloqueio =
  /** Telefone aponta um cliente, CPF aponta outro. Ninguém decide por palpite. */
  | "AMBIGUO_CHAVES_DISCORDANTES"
  /** O cliente achado já tem vínculo ativo com outro aluno do CRM. */
  | "DUPLICADO_CLIENTE_DE_OUTRO_ALUNO"
  /** Só o telefone achou. Telefone não é identidade: exige confirmação humana. */
  | "CONFIRMACAO_MANUAL_SO_TELEFONE"
  /** O aluno não tem CPF cadastrado, então não há como confirmar identidade. */
  | "CONFIRMACAO_MANUAL_SEM_CPF";

export type DecisaoVinculo =
  /** Já havia vínculo ativo: devolve o que existe, sem tocar nele. */
  | {
      acao: "manter_existente";
      ulbra_cliente_id: string;
      confianca: string;
      origem: string;
      reconfirmar_recomendado: boolean;
    }
  /** CPF confirmou: pode gravar. */
  | {
      acao: "criar";
      ulbra_cliente_id: string;
      confianca: typeof CONFIANCA.ALTA_CPF;
      origem: "cpf";
      telefone_e164: string | null;
      equipe: string | null;
      em_atendimento: boolean;
      telefone_concordou: boolean;
      /**
       * O telefone casou com alguém FORA do escopo do token, então a
       * Mensageria não devolveu o id e a comparação com o CPF é impossível.
       * O CPF continua mandando — é a chave de identidade —, mas o caso fica
       * registrado na auditoria em vez de passar como concordância.
       */
      telefone_fora_do_escopo: boolean;
    }
  /** Barrado: nada é gravado e o motivo é dito. */
  | { acao: "bloquear"; motivo: MotivoBloqueio; ulbra_cliente_id_candidato: string | null }
  /** Nenhuma chave achou cliente algum. */
  | { acao: "nao_encontrado"; motivo: "NAO_ENCONTRADO" | "FORA_DO_ESCOPO" };

/**
 * Classifica um vínculo ativo que JÁ existe. Nunca propõe apagar nem
 * sobrescrever: vínculo antigo é dado do operador, não lixo nosso
 * (memória `nao-estar-no-prime-nao-autoriza-excluir`, mesma lógica). O que
 * esta função faz é dizer, para quem for exibir, que aquele selo "alta" da
 * Etapa 1 não foi provado por CPF e merece reconferência.
 */
export function precisaReconfirmar(v: VinculoExistente): boolean {
  if (v.confianca === CONFIANCA.ALTA_CPF) return false;
  return CONFIANCA_NAO_PROVADA.includes(v.confianca) || v.origem === "telefone";
}

export interface EntradaDecisao {
  /** Vínculo ativo já gravado para este aluno, se houver. */
  existente?: VinculoExistente | null;
  /** O que o telefone devolveu. `undefined` quando não havia telefone. */
  porTelefone?: { ulbra_cliente_id: string | null; equipe: string | null; em_atendimento: boolean; fora_do_escopo: boolean };
  /** O que o CPF devolveu. `undefined` quando o aluno não tem CPF. */
  porCpf?: { ulbra_cliente_id: string | null; equipe: string | null; em_atendimento: boolean; fora_do_escopo: boolean };
  /** Telefone normalizado para registro, quando houver. */
  telefone_e164?: string | null;
  /**
   * Diz se `ulbra_cliente_id` já tem vínculo ATIVO com um aluno diferente
   * deste. Injetado porque a resposta mora no banco.
   */
  clienteJaDeOutroAluno: (ulbra_cliente_id: string) => Promise<boolean>;
}

export async function decidirVinculo(e: EntradaDecisao): Promise<DecisaoVinculo> {
  // ---------------------------------------------------------------------
  // 1. Vínculo antigo é intocável. Primeiro teste, antes de qualquer consulta
  //    ser considerada: o que já está gravado não é sobrescrito por esta
  //    função em nenhum caminho.
  // ---------------------------------------------------------------------
  if (e.existente) {
    return {
      acao: "manter_existente",
      ulbra_cliente_id: e.existente.ulbra_cliente_id,
      confianca: e.existente.confianca,
      origem: e.existente.origem,
      reconfirmar_recomendado: precisaReconfirmar(e.existente),
    };
  }

  const idTel = e.porTelefone?.ulbra_cliente_id ?? null;
  const idCpf = e.porCpf?.ulbra_cliente_id ?? null;

  // ---------------------------------------------------------------------
  // 2. Chaves discordantes BLOQUEIAM. Não existe critério de desempate
  //    honesto aqui: as duas chaves são do mesmo aluno e apontam pessoas
  //    diferentes na Mensageria. Escolher uma é adivinhar.
  // ---------------------------------------------------------------------
  if (idTel && idCpf && idTel !== idCpf) {
    return { acao: "bloquear", motivo: "AMBIGUO_CHAVES_DISCORDANTES", ulbra_cliente_id_candidato: null };
  }

  // ---------------------------------------------------------------------
  // 3. Sem CPF confirmando, não nasce vínculo.
  // ---------------------------------------------------------------------
  if (!idCpf) {
    if (idTel) {
      // O telefone achou alguém, mas o CPF não confirmou (ou não existe).
      // É exatamente o caso que a Etapa 1 gravava como "alta".
      const motivo: MotivoBloqueio = e.porCpf
        ? "CONFIRMACAO_MANUAL_SO_TELEFONE"
        : "CONFIRMACAO_MANUAL_SEM_CPF";
      return { acao: "bloquear", motivo, ulbra_cliente_id_candidato: idTel };
    }
    // Ninguém achou nada.
    const foraDoEscopo = !!e.porTelefone?.fora_do_escopo || !!e.porCpf?.fora_do_escopo;
    return { acao: "nao_encontrado", motivo: foraDoEscopo ? "FORA_DO_ESCOPO" : "NAO_ENCONTRADO" };
  }

  // ---------------------------------------------------------------------
  // 4. CPF confirmou. Último portão: o cliente não pode já ser de outro aluno.
  //    Checado ANTES do insert porque o índice único de produção cobre
  //    (aluno_id), não (ulbra_cliente_id) — sem este teste o banco aceitaria
  //    N alunos no mesmo cliente da Mensageria.
  // ---------------------------------------------------------------------
  const jaDeOutro = await e.clienteJaDeOutroAluno(idCpf).catch(() => true);
  if (jaDeOutro) {
    return { acao: "bloquear", motivo: "DUPLICADO_CLIENTE_DE_OUTRO_ALUNO", ulbra_cliente_id_candidato: idCpf };
  }

  return {
    acao: "criar",
    ulbra_cliente_id: idCpf,
    confianca: CONFIANCA.ALTA_CPF,
    origem: "cpf",
    telefone_e164: e.telefone_e164 ?? null,
    equipe: e.porCpf?.equipe ?? null,
    em_atendimento: !!e.porCpf?.em_atendimento,
    telefone_concordou: idTel === idCpf,
    telefone_fora_do_escopo: !!e.porTelefone?.fora_do_escopo,
  };
}
