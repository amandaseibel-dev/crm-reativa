// Leitura da F1.b por confirmacao individual. Nunca modifica banco ou executa baixa.
// A consulta exige RLS de gestao em todas as tabelas; erros ou paginação => REVISAO.
import { analisarConfirmacaoF1b } from "../utils/integracaoConfirmacaoF1b";

const revisar = (motivo) => ({ situacao: "REVISAO", motivo });
const MAX = 500;
const canon = v => String(v ?? "").replace(/^0+(?=\d)/, "");
async function buscar(query, limite = MAX) {
  const { data, error } = await query.limit(limite + 1);
  if (error) throw error;
  if (!Array.isArray(data) || data.length > limite) throw new Error("RESULTADO_INCOMPLETO");
  return data;
}

/**
 * Executa o motor F1.b apenas para uma confirmacao, sob sessao de gestao.
 * Falha fechado quando fonte inacessivel; nao tenta nomes, CPF aproximado ou datas.
 * A transacao/autoridade bancaria NAO e comprovada por esta analise.
 */
export async function analisarConfirmacaoF1bNoCRM(client, confirmacaoId) {
  if (!client || !confirmacaoId) return revisar("PARAMETROS_INVALIDOS");
  try {
    const cs = await buscar(client.from("solicitacoes_confirmacao_pagamento")
      .select("id,aluno_id,valor_informado").eq("id", confirmacaoId), 1);
    if (cs.length !== 1) return revisar("CONFIRMACAO_INACESSIVEL");
    const confirmacao = cs[0];
    if (!confirmacao.aluno_id) return revisar("CONFIRMACAO_SEM_IDENTIDADE");
    const vinculosGravados = await buscar(client.from("solicitacao_confirmacao_pagamentos")
      .select("confirmacao_id,pagamento_id").eq("confirmacao_id", confirmacaoId));
    if (!vinculosGravados.length) return revisar("SEM_VINCULO_GRAVADO");
    const ids = vinculosGravados.map(v => v.pagamento_id);
    if (ids.some(v => !v) || new Set(ids).size !== ids.length) return revisar("RELACAO_DE_PAGAMENTOS_INVALIDA");
    const pagamentos = await buscar(client.from("pagamentos")
      .select("id,aluno_id,cpf,matricula,valor_pago,titulo_numero,numero_parcela_completo")
      .in("id", ids));
    if (pagamentos.length !== ids.length) return revisar("PAGAMENTO_INACESSIVEL");

    const alunoId = String(confirmacao.aluno_id);
    const alunos = await buscar(client.from("alunos").select("id,cpf").eq("id", alunoId), 1);
    if (alunos.length !== 1) return revisar("IDENTIDADE_NAO_COMPROVADA");

    const matriculas = [...new Set(pagamentos.map(p => p.matricula).filter(Boolean))];
    if (matriculas.length !== pagamentos.length && !matriculas.length) return revisar("MATRICULA_AUSENTE");
    const primeContratos = matriculas.length
      ? await buscar(client.from("prime_contratos").select("registration,cpf").in("registration", matriculas))
      : [];

    // Recupera identificadores financeiros sem restringir ao aluno, para detectar duplicidade global.
    const numeros = [...new Set(pagamentos.map(p => canon(p.titulo_numero)).filter(Boolean))];
    const boletos = [...new Set(pagamentos.map(p => canon(p.numero_parcela_completo)).filter(Boolean))];
    // Ausencia de chave significa revisao no motor, nao assumir acordo por aluno.
    const acordos = numeros.length
      ? await buscar(client.from("acordos").select("id,aluno_id,numero_ulbra").in("numero_ulbra", numeros))
      : [];
    const parcelas = boletos.length
      ? await buscar(client.from("parcelas").select("id,acordo_id,boleto").in("boleto", boletos))
      : [];
    // Consulta também os acordos pai das parcelas (para preservar titularidade).
    const pais = [...new Set(parcelas.map(x => x.acordo_id).filter(Boolean))];
    if (pais.length) {
      const extras = await buscar(client.from("acordos").select("id,aluno_id,numero_ulbra").in("id", pais));
      for (const x of extras) if (!acordos.some(a => a.id === x.id)) acordos.push(x);
    }
    return analisarConfirmacaoF1b({ confirmacao, vinculosGravados, pagamentos, acordos, parcelas, alunos, primeContratos });
  } catch {
    return revisar("LEITURA_INCOMPLETA_OU_NEGADA");
  }
}
