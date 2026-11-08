// ===========================================================================
// RECEBIMENTO DA MENSAGERIA ULBRA — regras da tela, sem React e sem rede.
//
// A tela NÃO fala com a ULBRA. Ela lê `ulbra_conversas` e `ulbra_atendimentos`
// do nosso Postgres, que a função `ulbra-sincronizar` mantém. Por isso o
// número de operadores abertos não consome orçamento da Mensageria.
//
// `podeAssumir` aqui é o ESPELHO das recusas de `ulbra_atendimento_assumir`.
// Espelho, não substituto: quem decide é o banco, no UPDATE condicional. Isto
// existe só para a tela não oferecer um botão que vai ser recusado.
// ===========================================================================

export const PREFS_PADRAO = { som: false, visual: true };

export function normalizarEmail(valor) {
  return String(valor || "").trim().toLowerCase();
}

function chavePrefs(email) {
  return `rv_ulbra_prefs_${normalizarEmail(email).replace(/[^a-z0-9]/gi, "_") || "anon"}`;
}

/** Preferência é POR OPERADOR: o som de um não liga o do outro. */
export function lerPrefs(email) {
  try {
    const raw = localStorage.getItem(chavePrefs(email));
    return raw ? { ...PREFS_PADRAO, ...JSON.parse(raw) } : { ...PREFS_PADRAO };
  } catch {
    return { ...PREFS_PADRAO };
  }
}

export function salvarPrefs(email, prefs) {
  try {
    localStorage.setItem(chavePrefs(email), JSON.stringify(prefs));
  } catch {
    // armazenamento indisponível — preferência não persiste, a tela segue
  }
}

/**
 * Motivos de recusa, nos mesmos nomes que o banco devolve:
 *   DISPENSADO, IDENTIDADE_NAO_CONFIRMADA, E_DA_CARTEIRA_DE_OUTRO, JA_ASSUMIDO
 */
export function podeAssumir(atendimento, email, ehGestao = false) {
  const meu = normalizarEmail(email);
  if (!atendimento) return { pode: false, motivo: "NAO_ENCONTRADO" };
  if (atendimento.dispensado_em) return { pode: false, motivo: "DISPENSADO" };
  if (atendimento.responsavel_email) {
    return normalizarEmail(atendimento.responsavel_email) === meu
      ? { pode: false, motivo: "JA_E_MEU" }
      : { pode: false, motivo: "JA_ASSUMIDO" };
  }
  if (atendimento.aluno_status !== "vinculado") {
    return { pode: false, motivo: "IDENTIDADE_NAO_CONFIRMADA" };
  }
  if (
    atendimento.destino_motivo === "CARTEIRA" &&
    normalizarEmail(atendimento.destino_email) !== meu &&
    !ehGestao
  ) {
    return { pode: false, motivo: "E_DA_CARTEIRA_DE_OUTRO" };
  }
  return { pode: true, motivo: null };
}

export const RECUSA_EM_PORTUGUES = {
  DISPENSADO: "já dispensado",
  IDENTIDADE_NAO_CONFIRMADA: "identidade não confirmada — vai para conferência",
  E_DA_CARTEIRA_DE_OUTRO: "é da carteira de outro operador",
  JA_ASSUMIDO: "outro operador assumiu primeiro",
  JA_E_MEU: "já é seu",
  NAO_ENCONTRADO: "não encontrado",
  NAO_PERMITIDO_OU_JA_DISPENSADO: "não permitido ou já dispensado",
  ACESSO_NEGADO: "sem acesso",
};

/**
 * O que ESTE operador precisa ver. Gestão vê tudo; operador vê o que é dele
 * (carteira ou rodízio sugerido a ele, e o que ele já assumiu). O que está em
 * conferência aparece só para a gestão: oferecer a um operador um caso de
 * identidade não confirmada é o começo do vínculo errado.
 */
export function leadsVisiveis(atendimentos, email, ehGestao = false) {
  const meu = normalizarEmail(email);
  return (atendimentos || []).filter((a) => {
    if (a.dispensado_em) return false;
    if (ehGestao) return true;
    if (normalizarEmail(a.responsavel_email) === meu) return true;
    if (a.responsavel_email) return false;
    if (a.destino_motivo === "CONFERENCIA" || a.destino_motivo === "SEM_OPERADOR") return false;
    return normalizarEmail(a.destino_email) === meu;
  });
}

/**
 * Não lida PARA ESTE USUÁRIO: o cliente mandou algo depois do ponto até onde
 * ele leu. `leituras` é só a linha dele (ulbra_leitura_usuario), indexada pelo
 * id da conversa. Nunca se usa o marcador de outro operador.
 */
export function marcarNaoLidas(conversas, leituras) {
  const mapa = leituras instanceof Map ? leituras : new Map();
  return (conversas || []).map((c) => {
    const ultimaDoCliente = c.ultima_mensagem_cliente_em
      ? Date.parse(c.ultima_mensagem_cliente_em)
      : null;
    if (ultimaDoCliente === null) return { ...c, nao_lida: false };
    const lido = mapa.get(c.ulbra_conversa_id);
    const lidoAte = lido ? Date.parse(lido) : null;
    return { ...c, nao_lida: lidoAte === null || ultimaDoCliente > lidoAte };
  });
}

/** Conversas com resposta do aluno esperando: as do operador, ou todas na gestão. */
export function conversasVisiveis(conversas, email, ehGestao = false, alunosDoOperador = null) {
  const meu = normalizarEmail(email);
  return (conversas || []).filter((c) => {
    if (!c.nao_lida) return false;
    if (ehGestao) return true;
    if (alunosDoOperador instanceof Set) return c.aluno_id && alunosDoOperador.has(c.aluno_id);
    return normalizarEmail(c.responsavel_ulbra) === meu;
  });
}

export function contarNovidades({ conversas, atendimentos, email, ehGestao = false, alunosDoOperador = null }) {
  const respostas = conversasVisiveis(conversas, email, ehGestao, alunosDoOperador);
  const leads = leadsVisiveis(atendimentos, email, ehGestao).filter((a) => !a.responsavel_email);
  // Conta CONVERSAS com resposta pendente para este usuário, não mensagens.
  const naoLidas = respostas.length;
  return { respostas, leads, nao_lidas: naoLidas, total: naoLidas + leads.length };
}

/** Mais recente primeiro, sem empate instável: desempata pelo id. */
export function ordenarPorRecencia(linhas, campo) {
  return [...(linhas || [])].sort((a, b) => {
    const ta = a[campo] ? Date.parse(a[campo]) : 0;
    const tb = b[campo] ? Date.parse(b[campo]) : 0;
    if (ta !== tb) return tb - ta;
    return String(a.ulbra_conversa_id || a.ulbra_atendimento_id || "").localeCompare(
      String(b.ulbra_conversa_id || b.ulbra_atendimento_id || ""),
    );
  });
}
