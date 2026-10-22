// PENDENTE DE 1o ACIONAMENTO -- o caso ja e do operador atual e ainda nao
// recebeu uma tabulacao DELE desde que passou para a mao dele.
//
// POR QUE EXISTE (pedido da gestao, 22/10/2026). O indicador antigo da Minha
// Carteira ("Sem 1o acionamento") marcava o caso como acionado se EXISTISSE
// qualquer tabulacao, de QUALQUER operador, em QUALQUER data. Ou seja: era o
// "Novo" historico, e nunca reiniciava quando o caso trocava de mao. Medido em
// producao em 22/10/2026, sobre 6.162 casos ativos em carteira: o indicador
// antigo mostrava 294; o numero real de casos sem o primeiro acionamento do
// dono ATUAL era 2.111. Os 1.817 de diferenca sao casos que o operador
// ANTERIOR ja tinha tabulado -- no giro de 16/10, 3.566 casos trocaram de mao.
//
// Este modulo e puro: nao conhece React nem o banco. Recebe o que a tela ja
// carregou e responde quais ids estao pendentes.

// Normaliza e-mail para comparacao (a base tem maiusculas misturadas).
export function normalizarEmail(valor) {
  return String(valor || "").trim().toLowerCase();
}

function instante(valor) {
  if (!valor) return null;
  const t = new Date(valor).getTime();
  return Number.isNaN(t) ? null : t;
}

// DATA EFETIVA DA ATRIBUICAO. A referencia e o REGISTRO DE TROCA DE MAO em
// `aluno_movimentacoes` (operador_novo_email = o atual, operador_anterior
// diferente dele): e ele que prova que o caso mudou de dono, e nao so que a
// linha foi mexida.
//
// `alunos.responsavel_atual_em` entra apenas como ULTIMO RECURSO, quando nao ha
// registro de troca nenhum (34 casos em 6.038 na medicao de 22/10). Ele NAO
// pode mandar por cima da transferencia: o campo e reescrito por rotinas
// tecnicas sem troca real de responsavel, e usar o mais recente dos dois faria
// uma atualizacao tecnica reiniciar o indicador de um caso ja trabalhado --
// exatamente o que a gestao pediu para evitar.
export function dataDaAtribuicao({ transferencias = [], responsavelAtualEm = null, operador = "" } = {}) {
  const op = normalizarEmail(operador);
  let maisRecente = null;
  for (const t of transferencias) {
    if (normalizarEmail(t?.operador_novo_email) !== op) continue;
    // Mesma pessoa dos dois lados nao e troca de mao: e sincronizacao.
    if (normalizarEmail(t?.operador_anterior_email) === op) continue;
    const quando = instante(t?.registrado_em);
    if (quando === null) continue;
    if (maisRecente === null || quando > maisRecente) maisRecente = quando;
  }
  if (maisRecente !== null) return maisRecente;
  return instante(responsavelAtualEm);
}

// O caso recebeu tabulacao valida do operador ATUAL a partir da atribuicao?
//
// Duas exigencias, as duas da gestao: a tabulacao tem de ser DELE
// (`registrado_por_email`) e tem de ser DEPOIS da atribuicao. Tabulacao sem
// autor nao conta -- nao da para afirmar de quem foi, e afirmar a favor
// esconderia um caso pendente (sao 185 em todo o historico, todas antigas).
export function acionouDesdeAtribuicao({ tabulacoes = [], operador = "", atribuidoEm = null } = {}) {
  const op = normalizarEmail(operador);
  if (!op) return false;
  for (const t of tabulacoes) {
    if (normalizarEmail(t?.registrado_por_email) !== op) continue;
    // Sem data de atribuicao conhecida, qualquer tabulacao do dono atual vale:
    // e o maximo que os dados sustentam, e o conservador aqui seria acusar
    // pendencia sem prova.
    if (atribuidoEm === null) return true;
    const quando = instante(t?.registrado_em);
    if (quando !== null && quando >= atribuidoEm) return true;
  }
  return false;
}

// Ids pendentes, na ordem em que os casos chegaram.
//
// `casos` sao SO os da carteira atual -- quem monta a lista ja aplicou escopo,
// quitados e nao acionaveis. Este modulo nao amplia o universo: um id que nao
// esta em `casos` nunca sai daqui.
export function idsPendentesPrimeiroAcionamento({
  casos = [],
  tabulacoesPorAluno = new Map(),
  transferenciasPorAluno = new Map(),
} = {}) {
  const pendentes = [];
  for (const caso of casos) {
    const id = String(caso?.id ?? "");
    if (!id) continue;
    const operador = normalizarEmail(caso?.responsavel_atual_email);
    // Caso sem responsavel nao tem "primeiro acionamento do atual" a cobrar.
    if (!operador) continue;
    const atribuidoEm = dataDaAtribuicao({
      transferencias: transferenciasPorAluno.get(id) || [],
      responsavelAtualEm: caso?.responsavel_atual_em,
      operador,
    });
    const acionou = acionouDesdeAtribuicao({
      tabulacoes: tabulacoesPorAluno.get(id) || [],
      operador,
      atribuidoEm,
    });
    if (!acionou) pendentes.push(id);
  }
  return pendentes;
}

// Agrupa linhas por aluno_id (texto), preservando a ordem de chegada.
export function agruparPorAluno(linhas) {
  const mapa = new Map();
  for (const linha of linhas || []) {
    const id = String(linha?.aluno_id ?? "");
    if (!id) continue;
    const atual = mapa.get(id);
    if (atual) atual.push(linha);
    else mapa.set(id, [linha]);
  }
  return mapa;
}
