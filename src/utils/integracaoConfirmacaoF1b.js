// F1.b: integra o conjunto de pagamentos da confirmação com o classificador determinístico.
// Função pura. Quem a chamar deve obter as linhas com permissões de gestão.
// NENHUMA associação por aluno/nome/data/valor é feita AQUI para descobrir pagamentos.
//
// A PROVENIÊNCIA do conjunto é um FATO DE ENTRADA, não uma conclusão desta função:
// vem em `prova` por vínculo, igual ao que `confirmacao_pagamentos_resolver` devolve
// (`VINCULO_GRAVADO` ou `CHAVE_MESMA_TRANSACAO`). As duas rotas do resolver ancoram
// identidade no NOME normalizado do aluno -- é o que elas têm. Então nenhuma delas é
// prova de identidade por si: quem prova é `comprovarIdentidadeF1b`, pela ponte
// Santander -> Prime -> CPF -> aluno, aplicada aqui por cima, pagamento por pagamento.
// A `prova` é carregada até o retorno para que a tela NUNCA trate as duas como iguais.
import { identificarVinculoF1b } from "./vinculoFinanceiroF1b";
import { comprovarIdentidadeF1b } from "./comprovarIdentidadeF1b";

const rev = (motivo, extra = {}) => ({ situacao: "REVISAO", motivo, ...extra });
const PROVA_NAO_DECLARADA = "NAO_DECLARADA";

export function analisarConfirmacaoF1b({
  confirmacao,
  vinculos,
  vinculosGravados = [],
  pagamentos = [],
  acordos = [],
  parcelas = [],
  alunos = [],
  primeContratos = [],
} = {}) {
  if (!confirmacao?.id || !confirmacao?.aluno_id) return rev("CONFIRMACAO_SEM_IDENTIDADE");
  const alunosDaConfirmacao = alunos.filter(a => String(a.id) === String(confirmacao.aluno_id));
  if (alunosDaConfirmacao.length !== 1) return rev("IDENTIDADE_NAO_COMPROVADA");
  const id = String(confirmacao.id);
  const entrada = Array.isArray(vinculos) ? vinculos : vinculosGravados;
  const doConjunto = entrada.filter(v => String(v.confirmacao_id) === id);
  if (!doConjunto.length) return rev("SEM_VINCULO_GRAVADO");

  const ids = doConjunto.map(v => String(v.pagamento_id ?? ""));
  if (ids.some(v => !v) || new Set(ids).size !== ids.length) {
    return rev("RELACAO_DE_PAGAMENTOS_INVALIDA");
  }
  // Conjunto com proveniências diferentes não é um conjunto: metade veio do vínculo
  // gravado e metade de reconstrução por transação significa que ninguém sabe qual
  // das duas vale para a soma. Vai para revisão em vez de eleger uma.
  const provas = [...new Set(doConjunto.map(v => String(v.prova ?? PROVA_NAO_DECLARADA)))];
  if (provas.length !== 1) return rev("PROVAS_MISTURADAS", { provas });
  const prova_do_conjunto = provas[0];

  const resultados = [];
  for (const pagamentoId of ids) {
    const candidatos = pagamentos.filter(p => String(p.id) === pagamentoId);
    if (candidatos.length !== 1) return rev("PAGAMENTO_AUSENTE_OU_DUPLICADO", { prova_do_conjunto });
    const pagamento = candidatos[0];
    if (String(pagamento.aluno_id ?? "") !== String(confirmacao.aluno_id)) {
      return rev("IDENTIDADE_DIVERGENTE", { prova_do_conjunto });
    }
    const provaIdentidade = comprovarIdentidadeF1b({ pagamento, aluno: alunosDaConfirmacao[0], primeContratos });
    if (!provaIdentidade.comprovada) {
      return rev("IDENTIDADE_NAO_COMPROVADA", { motivo_identidade: provaIdentidade.motivo, prova_do_conjunto });
    }
    const resultado = identificarVinculoF1b({ pagamento, acordos, parcelas });
    resultados.push({ pagamento_id: pagamentoId, prova: prova_do_conjunto, ...resultado });
  }
  if (resultados.some(r => r.situacao !== "CANDIDATO_DETERMINISTICO")) {
    return rev("CONJUNTO_COM_EXCECAO", { resultados, prova_do_conjunto });
  }
  const soma = ids.reduce((v, pagamentoId) => {
    const p = pagamentos.find(x => String(x.id) === pagamentoId);
    return v + Number(p?.valor_pago ?? NaN);
  }, 0);
  if (!Number.isFinite(soma) || !Number.isFinite(Number(confirmacao.valor_informado)) ||
      Math.abs(Math.round(soma * 100) - Math.round(Number(confirmacao.valor_informado) * 100)) > 1) {
    return rev("VALORES_NAO_CONFEREM", { resultados, prova_do_conjunto });
  }
  return {
    situacao: "CANDIDATOS_IDENTIFICADOS",
    motivo: "CONJUNTO_RESOLVIDO_IDENTIFICADORES_VALIDOS",
    confirmacao_id: id,
    prova_do_conjunto,
    resultados,
    pagamento_confirmado: false,
    baixa_confirmada: false,
  };
}
