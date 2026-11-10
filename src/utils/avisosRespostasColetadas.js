// Avisos de RESPOSTAS JÁ COLETADAS da Mensageria, para o operador responsável.
//
// Regras:
//  - Só a RESPOSTA DO ALUNO conta: ultima_mensagem_quem === 'cliente'. Mensagem
//    do operador ou do bot nunca gera aviso.
//  - Destinatário: quem é responsável pelo caso NO REATIVA (carteira/responsabilidade
//    interna). Gestão não recebe aviso individual; acompanha pendências da equipe.
//  - Leitura por usuário: cada pessoa tem o seu `lido_ate`. A gestão ler não apaga o
//    aviso do operador.
//  - Aviso só para resposta NOVA desde a última vez que o usuário viu a fila
//    (`visto_ate`). Carga inicial não alerta. Corrigir vínculo não gera aviso: a data
//    da mensagem não muda, então ela já está antes de `visto_ate`.
//  - Não altera nenhuma data de mensagem. Não chama a ULBRA.

/** Respostas do aluno em conversas com identidade confirmada. Um aviso por conversa. */
export function respostasDoAluno(conversas) {
  return (conversas || []).filter(
    (c) => c && c.ultima_mensagem_quem === "cliente" && c.ultima_mensagem_cliente_em && c.aluno_id,
  );
}

/** Quem é o responsável interno do aluno (carteira/responsabilidade do ReATIVA). */
export function responsavelDoAluno(carteira, alunoId) {
  const linha = (carteira || []).find((c) => c.aluno_id === alunoId && c.responsavel_email);
  return linha ? String(linha.responsavel_email).toLowerCase() : null;
}

/**
 * Avisos para UM usuário.
 * @param {object} p
 * @param {Array} p.conversas  espelho (ultima_mensagem_quem, ultima_mensagem_cliente_em, aluno_id, ulbra_conversa_id)
 * @param {Array} p.carteira   {aluno_id, responsavel_email} pelas permissões internas
 * @param {string} p.email     usuário que vê
 * @param {boolean} p.ehGestao gestão não recebe aviso individual
 * @param {Object<string,string>} p.lidoAte  {ulbra_conversa_id: ISO} do PRÓPRIO usuário
 * @param {string|null} p.vistoAte  ISO da última vez que o usuário viu a fila (null = primeira carga)
 */
export function avisosParaUsuario({ conversas, carteira, email, ehGestao = false, lidoAte = {}, vistoAte = null }) {
  if (ehGestao) return { avisos: [], novos: [] };
  const eu = String(email || "").toLowerCase();
  const avisos = [];
  for (const c of respostasDoAluno(conversas)) {
    if (responsavelDoAluno(carteira, c.aluno_id) !== eu) continue;
    const em = Date.parse(c.ultima_mensagem_cliente_em);
    const lido = lidoAte[c.ulbra_conversa_id] ? Date.parse(lidoAte[c.ulbra_conversa_id]) : -Infinity;
    if (lido >= em) continue; // este usuário já leu esta resposta
    avisos.push({ ulbra_conversa_id: c.ulbra_conversa_id, aluno_id: c.aluno_id, em: c.ultima_mensagem_cliente_em });
  }
  avisos.sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : a.ulbra_conversa_id < b.ulbra_conversa_id ? -1 : 1));
  // Carga inicial: mostra o que está pendente, mas NÃO conta como novidade (sem som).
  const novos = vistoAte === null ? [] : avisos.filter((a) => Date.parse(a.em) > Date.parse(vistoAte));
  return { avisos, novos };
}

/** Pendências da equipe para a GESTÃO (sem aviso individual). */
export function pendenciasDaEquipe({ conversas, carteira }) {
  return respostasDoAluno(conversas).map((c) => ({
    ulbra_conversa_id: c.ulbra_conversa_id,
    aluno_id: c.aluno_id,
    responsavel: responsavelDoAluno(carteira, c.aluno_id),
    em: c.ultima_mensagem_cliente_em,
  })).sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : a.ulbra_conversa_id < b.ulbra_conversa_id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Integração com o sino: a função do servidor devolve SÓ as pendências do
// operador. Aqui elas viram o formato que o sino já usa.
// ---------------------------------------------------------------------------

/** Converte a resposta de ulbra_avisos_operador(). */
export function avisosDoServidor(avisos) {
  const linhas = Array.isArray(avisos) ? avisos : [];
  const conversas = linhas.map((a) => ({
    ulbra_conversa_id: a.ulbra_conversa_id,
    aluno_id: a.aluno_id,
    aluno_status: "vinculado",
    cliente_nome: a.nome,
    ultima_mensagem_quem: "cliente",
    ultima_mensagem_em: a.ultima_mensagem_cliente_em,
    ultima_mensagem_cliente_em: a.ultima_mensagem_cliente_em,
  }));
  // `lida` do servidor = este usuário já leu esta resposta; o sino usa o instante da mensagem.
  const leituras = new Map(linhas.filter((a) => a.lida).map((a) => [a.ulbra_conversa_id, a.ultima_mensagem_cliente_em]));
  const alunos = new Set(linhas.map((a) => a.aluno_id).filter(Boolean));
  return { conversas, leituras, alunos };
}

/** Erro de função inexistente (migration não aplicada). */
export function ehRpcAusente(error) {
  if (!error) return false;
  return error.code === "42883" || error.code === "PGRST202" || /ulbra_avisos_operador/.test(error.message || "");
}

const CHAVE_TOQUE = "ulbra_sino_ultimo_toque:";

/**
 * Som sem duplicar entre abas: só toca se este total ainda não foi tocado por
 * outra aba para o mesmo usuário. Sem armazenamento, toca (melhor tocar que calar).
 */
export function deveTocar(email, total) {
  try {
    const feito = Number(localStorage.getItem(CHAVE_TOQUE + email)) || 0;
    return total > feito;
  } catch {
    return true;
  }
}

export function marcarTocado(email, total) {
  try {
    localStorage.setItem(CHAVE_TOQUE + email, String(total));
  } catch {
    // armazenamento indisponível: o som pode repetir entre abas, sem perda de dado
  }
}
