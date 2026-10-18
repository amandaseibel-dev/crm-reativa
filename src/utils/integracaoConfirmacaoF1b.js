// F1.b: integra o vínculo já gravado na origem com o classificador determinístico.
// Função pura. Quem a chamar deve obter as linhas com permissões de gestão.
// NENHUMA associação por aluno/nome/data/valor é usada para descobrir pagamentos.
import { identificarVinculoF1b } from "./vinculoFinanceiroF1b";

const rev = (motivo, extra = {}) => ({ situacao: "REVISAO", motivo, ...extra });

export function analisarConfirmacaoF1b({
  confirmacao,
  vinculosGravados = [],
  pagamentos = [],
  acordos = [],
  parcelas = [],
} = {}) {
  if (!confirmacao?.id || !confirmacao?.aluno_id) return rev("CONFIRMACAO_SEM_IDENTIDADE");
  const id = String(confirmacao.id);
  const vinculos = vinculosGravados.filter(v => String(v.confirmacao_id) === id);
  if (!vinculos.length) return rev("SEM_VINCULO_GRAVADO");

  const ids = vinculos.map(v => String(v.pagamento_id ?? ""));
  if (ids.some(v => !v) || new Set(ids).size !== ids.length) {
    return rev("RELACAO_DE_PAGAMENTOS_INVALIDA");
  }
  const resultados = [];
  for (const pagamentoId of ids) {
    const candidatos = pagamentos.filter(p => String(p.id) === pagamentoId);
    if (candidatos.length !== 1) return rev("PAGAMENTO_AUSENTE_OU_DUPLICADO");
    const pagamento = candidatos[0];
    if (String(pagamento.aluno_id ?? "") !== String(confirmacao.aluno_id)) {
      return rev("IDENTIDADE_DIVERGENTE");
    }
    const resultado = identificarVinculoF1b({ pagamento, acordos, parcelas });
    resultados.push({ pagamento_id: pagamentoId, ...resultado });
  }
  if (resultados.some(r => r.situacao !== "CANDIDATO_DETERMINISTICO")) {
    return rev("CONJUNTO_COM_EXCECAO", { resultados });
  }
  const soma = ids.reduce((v, pagamentoId) => {
    const p = pagamentos.find(x => String(x.id) === pagamentoId);
    return v + Number(p?.valor_pago ?? NaN);
  }, 0);
  if (!Number.isFinite(soma) || !Number.isFinite(Number(confirmacao.valor_informado)) ||
      Math.abs(Math.round(soma * 100) - Math.round(Number(confirmacao.valor_informado) * 100)) > 1) {
    return rev("VALORES_NAO_CONFEREM", { resultados });
  }
  return {
    situacao: "CANDIDATOS_IDENTIFICADOS",
    motivo: "VINCULOS_GRAVADOS_IDENTIFICADORES_VALIDOS",
    confirmacao_id: id,
    resultados,
    pagamento_confirmado: false,
    baixa_confirmada: false,
  };
}
