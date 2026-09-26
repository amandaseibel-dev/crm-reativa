// ============================================================
// src/utils/carteiraGeral.js
// Regras da Carteira Geral que NÃO dependem de tela nem de banco.
// Ficam aqui para poderem ser testadas sozinhas e para a tela não
// reimplementar critério — o mesmo erro que espalhou 5 cópias do
// catálogo de tabulação pelo sistema.
// ============================================================

// Destino reservado. Não é login: não existe em auth.users e não tem senha.
// Quem opera entra com o próprio e-mail (Amanda, Fernanda, ADM).
export const CARTEIRA_GERAL_EMAIL = "carteira.geral@reativa.local";

export const DESTINOS = [
  {
    valor: "CARTEIRA_GERAL",
    rotulo: "Carteira Geral",
    ajuda:
      "Sai da mão do operador e fica sob a gestão. Nenhuma rotina automática " +
      "pega de lá e nenhum operador consegue assumir sozinho.",
  },
  {
    valor: "OPERADOR",
    rotulo: "Operador específico",
    ajuda: "Entra direto na carteira da pessoa escolhida.",
  },
  {
    valor: "FILA_LIVRE",
    rotulo: "Fila livre",
    ajuda:
      "Fica sem dono e disponível para qualquer operador assumir. É o único " +
      "destino de onde a operação pode se servir.",
  },
];

// Rótulo de por que um responsável não está trabalhando o caso.
export const CLASSE_RESPONSAVEL = {
  OPERADOR: { rotulo: "Operador ativo", alerta: false },
  CARTEIRA_GERAL: { rotulo: "Carteira Geral", alerta: false },
  SEM_OPERADOR: { rotulo: "Sem operador", alerta: true },
  INATIVO: { rotulo: "Operador inativo", alerta: true },
  DESCONHECIDO: { rotulo: "E-mail fora do cadastro", alerta: true },
  NAO_OPERADOR: { rotulo: "Responsável não é da fila", alerta: true },
};

export function rotuloClasse(classe) {
  return CLASSE_RESPONSAVEL[classe]?.rotulo || classe || "—";
}

// Um responsável "em alerta" é qualquer um que não seja operador ativo nem a
// própria Carteira Geral: ninguém da fila está tocando esses casos.
export function classeEmAlerta(classe) {
  return Boolean(CLASSE_RESPONSAVEL[classe]?.alerta);
}

export function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// O painel soma valor por ano; a CONTAGEM por ano é de alunos distintos naquele
// ano e por isso NÃO fecha com o total geral — um aluno com mensalidade de 2025
// e parcela de 2026 conta nos dois. Esta função devolve as duas leituras
// separadas para a tela poder dizer isso em vez de mostrar um total que não bate.
export function consolidarPorAno(porAno) {
  const linhas = Array.isArray(porAno) ? porAno : [];
  const mapa = new Map();

  for (const linha of linhas) {
    const ano = linha?.ano ?? null;
    if (!mapa.has(ano)) {
      mapa.set(ano, { ano, mensalidade: 0, acordo: 0, valor: 0, itens: 0, alunosPorTipo: {} });
    }
    const alvo = mapa.get(ano);
    const valor = Number(linha?.valor || 0);
    const tipo = linha?.tipo === "ACORDO" ? "acordo" : "mensalidade";
    alvo[tipo] += valor;
    alvo.valor += valor;
    alvo.itens += Number(linha?.itens || 0);
    alvo.alunosPorTipo[tipo] = Number(linha?.alunos || 0);
  }

  return [...mapa.values()].sort((a, b) => (b.ano ?? 0) - (a.ano ?? 0));
}

// Conflitos vêm como lista plana da prévia. A tela mostra agrupado, porque
// "217 retornos agendados serão limpos" é uma frase que a gestão decide, e
// 217 linhas iguais não são.
export const ROTULO_CONFLITO = {
  TITULARIDADE_DIVERGENTE: "Titularidade divergente entre caso e ficha do aluno",
  ACORDO_DE_TERCEIRO_FICA: "Acordo de terceiro que FICA (não selecionado)",
  ACORDO_DE_TERCEIRO_SELECIONADO: "Acordo de terceiro selecionado para ir junto",
  ACORDO_DO_DONO_FICA: "Acordo do próprio dono que NÃO vai junto",
  RETORNO_AGENDADO_SEGUE: "Retorno agendado que segue com o aluno",
  CASO_ENCERRADO: "Caso já encerrado operacionalmente",
  TETO_DO_OPERADOR: "Teto do operador de destino",
};

// Acordo de terceiro é decisão item a item: a tela lista um por um, com
// número, valor, status e de quem é. Nunca agregado — agregar é o que
// transformaria 155 decisões numa só.
export const TIPOS_ACORDO_TERCEIRO = ["ACORDO_DE_TERCEIRO_FICA", "ACORDO_DE_TERCEIRO_SELECIONADO"];

export function acordosDeTerceiros(conflitos) {
  return (Array.isArray(conflitos) ? conflitos : [])
    .filter((c) => TIPOS_ACORDO_TERCEIRO.includes(c?.tipo))
    .map((c) => ({
      acordo_id: c.acordo_id,
      aluno_id: c.aluno_id,
      aluno: c.nome,
      numero: c.numero,
      status: c.status,
      valor: Number(c.valor || 0),
      de_email: c.de_email,
      selecionado: c.tipo === "ACORDO_DE_TERCEIRO_SELECIONADO",
    }))
    .sort((a, b) => b.valor - a.valor);
}

export function agruparConflitos(conflitos) {
  const lista = Array.isArray(conflitos) ? conflitos : [];
  const mapa = new Map();

  for (const c of lista) {
    const tipo = c?.tipo || "OUTRO";
    if (!mapa.has(tipo)) {
      mapa.set(tipo, { tipo, rotulo: ROTULO_CONFLITO[tipo] || tipo, total: 0, exemplos: [] });
    }
    const alvo = mapa.get(tipo);
    alvo.total += 1;
    if (alvo.exemplos.length < 3) alvo.exemplos.push(c?.detalhe || c?.nome || "");
  }

  // Mais grave primeiro: o que muda dinheiro/atribuição antes do que é aviso.
  const ordem = [
    "TETO_DO_OPERADOR",
    "ACORDO_DO_DONO_FICA",
    "TITULARIDADE_DIVERGENTE",
    "ACORDO_DE_TERCEIRO_SELECIONADO",
    "ACORDO_DE_TERCEIRO_FICA",
    "RETORNO_AGENDADO_SEGUE",
    "CASO_ENCERRADO",
  ];
  return [...mapa.values()].sort(
    (a, b) => ordem.indexOf(a.tipo) - ordem.indexOf(b.tipo)
  );
}

// Trava de tela. A regra definitiva é do banco (calibragem_e_gestao +
// carteira_geral_mover); isto aqui só evita oferecer um botão que vai dar erro.
export function validarConfirmacao({ destinoTipo, destinoEmail, motivo, selecionados }) {
  if (!selecionados || selecionados.length === 0) {
    return { ok: false, erro: "Selecione pelo menos um aluno." };
  }
  if (!DESTINOS.some((d) => d.valor === destinoTipo)) {
    return { ok: false, erro: "Escolha o destino." };
  }
  if (destinoTipo === "OPERADOR" && !destinoEmail) {
    return { ok: false, erro: "Escolha o operador de destino." };
  }
  if (!String(motivo || "").trim()) {
    return { ok: false, erro: "Informe o motivo — ele fica na auditoria." };
  }
  return { ok: true };
}

// O que é custódia (muda) e o que é história (não muda). A tela mostra isto
// literalmente antes de confirmar, porque foi a dúvida que originou a regra.
export const O_QUE_MUDA = [
  "Quem trabalha o caso hoje (casos.operador_email)",
  "O responsável na ficha do aluno",
  "O responsável dos acordos do próprio dono, quando a opção estiver marcada",
  "O responsável dos acordos de terceiros que você selecionar, um a um",
];

export const O_QUE_NAO_MUDA = [
  "Quem criou e quem confirmou cada acordo",
  "O operador de cada pagamento — é ele que define honorário e comissão",
  "Baixas, parcelas, títulos, valores e status financeiro",
  "O histórico de acionamentos e movimentações já registrado",
  "O retorno agendado: data, hora e origem seguem com o aluno",
];
