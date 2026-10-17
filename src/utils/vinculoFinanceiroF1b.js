// F1.b: identificacao deterministica de candidatos financeiros, sem efeitos colaterais.
// Nao altera cadastro, baixa, status, fila ou acordo. Integracao com banco e etapa posterior.
// Os nomes dos alunos nunca sao utilizados como chave. Ausencia/ambiguidade => revisao humana.

const somenteDigitos = (v) => {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const texto = String(v).trim();
  // Nao transformar lixo alfanumerico em numero valido por retirar letras.
  return /^[0-9 .-]+$/.test(texto) ? texto.replace(/[^0-9]/g, "") : "";
};
const numeroCanonico = (v) => {
  const d = somenteDigitos(v);
  return d ? d.replace(/^0+(?=\d)/, "") : "";
};
const identidade = (v) => v == null ? "" : String(v).trim();
const unico = (itens) => itens.length === 1 ? itens[0] : null;
const resposta = (situacao, motivo, extra = {}) => ({ situacao, motivo, ...extra });

/**
 * Recebe registros ja obtidos de fontes autorizadas, nunca faz queries ou escritas.
 * Entrada: pagamento {aluno_id, titulo_numero, numero_parcela_completo},
 *          acordos [{id, aluno_id, numero_ulbra}], parcelas [{id, acordo_id, boleto}].
 * titulo_numero: numero do acordo no arquivo Santander, nao prova de baixa.
 * boleto: chave exata da parcela, conferida no contexto do acordo/aluno.
 */
export function identificarVinculoF1b({ pagamento, acordos = [], parcelas = [] } = {}) {
  if (!pagamento || !identidade(pagamento.aluno_id)) {
    return resposta("REVISAO", "ALUNO_NAO_IDENTIFICADO");
  }
  const aluno = identidade(pagamento.aluno_id);
  const numeroAcordo = numeroCanonico(pagamento.titulo_numero);
  const boleto = numeroCanonico(pagamento.numero_parcela_completo);
  if (!numeroAcordo && !boleto) return resposta("REVISAO", "SEM_IDENTIFICADOR_FINANCEIRO");

  // Nao aceita duas linhas do cadastro que reivindiquem o mesmo identificador.
  const acordosDoAluno = acordos.filter(a => identidade(a.aluno_id) === aluno);
  const porNumero = numeroAcordo
    ? acordos.filter(a => numeroCanonico(a.numero_ulbra) === numeroAcordo)
    : [];
  if (numeroAcordo && porNumero.length !== 1) {
    return resposta("REVISAO", porNumero.length ? "ACORDO_AMBIGUO" : "ACORDO_NAO_ENCONTRADO");
  }
  const acordoPorNumero = unico(porNumero);
  if (acordoPorNumero && identidade(acordoPorNumero.aluno_id) !== aluno) {
    return resposta("REVISAO", "IDENTIDADE_DIVERGENTE");
  }

  const porBoleto = boleto
    ? parcelas.filter(p => numeroCanonico(p.boleto) === boleto)
    : [];
  if (boleto && porBoleto.length !== 1) {
    return resposta("REVISAO", porBoleto.length ? "BOLETO_AMBIGUO" : "BOLETO_NAO_ENCONTRADO",
      acordoPorNumero ? { acordo_id: acordoPorNumero.id } : {});
  }
  const parcela = unico(porBoleto);
  const acordoDaParcela = parcela
    ? acordosDoAluno.find(a => identidade(a.id) === identidade(parcela.acordo_id))
    : null;
  if (parcela && !acordoDaParcela) return resposta("REVISAO", "PARCELA_FORA_DO_ALUNO");
  if (acordoPorNumero && acordoDaParcela &&
      identidade(acordoPorNumero.id) !== identidade(acordoDaParcela.id)) {
    return resposta("REVISAO", "IDENTIFICADORES_CONTRADITORIOS");
  }
  const acordo = acordoPorNumero || acordoDaParcela;
  if (!acordo) return resposta("REVISAO", "ACORDO_NAO_PROVADO");
  return resposta("CANDIDATO_DETERMINISTICO", "IDENTIFICADOR_EXATO_E_ALUNO_CONFERIDO", {
    aluno_id: aluno,
    acordo_id: acordo.id,
    parcela_id: parcela?.id ?? null,
    pagamento_confirmado: false,
    baixa_confirmada: false,
  });
}
