// F1.b: identificacao deterministica de candidatos financeiros, sem efeitos colaterais.
// Nao altera cadastro, baixa, status, fila ou acordo. Integracao com banco e etapa posterior.
// Os nomes dos alunos nunca sao utilizados como chave. Ausencia/ambiguidade => revisao humana.

const somenteDigitos = (v) => {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const texto = String(v).trim();
  // Nao transformar lixo alfanumerico em numero valido por retirar letras.
  return /^[0-9 .-]+$/.test(texto) ? texto.replace(/[^0-9]/g, "") : "";
};
// Exportada porque quem PRE-FILTRA as linhas no banco tem de canonizar igual ao
// motor: um pre-filtro que normaliza diferente esconde a linha que o motor
// consideraria igual, e o resultado vira "nao encontrado" em vez de candidato.
export const numeroCanonico = (v) => {
  const d = somenteDigitos(v);
  return d ? d.replace(/^0+(?=\d)/, "") : "";
};
const identidade = (v) => v == null ? "" : String(v).trim();
const unico = (itens) => itens.length === 1 ? itens[0] : null;
const resposta = (situacao, motivo, extra = {}) => ({ situacao, motivo, ...extra });

// Parcela que o CRM tirou da vida normal NAO vira candidato determinístico, mesmo
// com identificador exato. Medido em 19/10/2026 na fila aberta: dos 185 pagamentos
// que o motor promovia, 4 apontavam parcela fora de cobrança (3 CANCELADA, 1
// SUSPENSA), R$ 46.478,84 -- apresentados como "candidato identificado" sem que
// ninguém visse o status. O motor não escreve, mas quem lê a tela age.
// ALLOWLIST, não denylist: um status novo no catálogo cai em revisão por padrão,
// em vez de entrar como cobrável por omissão.
const STATUS_EM_COBRANCA = new Set(["PAGO", "A_VENCER", "VENCIDA"]);

// O mesmo raciocinio no nivel do ACORDO, que o portao da parcela nao alcanca: a
// parcela pode estar num status da allowlist DENTRO de um acordo cancelado. Medido
// em 19/10/2026: na fila aberta isso nao acontece hoje (0 casos), mas no universo
// todo ha 13 pagamentos nessa forma -- 12 em parcela PAGO e 1 em parcela VENCIDA,
// as duas dentro de acordo CANCELADO. Fechado antes de aparecer na fila.
// QUITADO entra: acordo pago ate o fim e destino legitimo de pagamento.
const ACORDO_EM_COBRANCA = new Set(["ATIVO", "QUITADO"]);

/**
 * Recebe registros ja obtidos de fontes autorizadas, nunca faz queries ou escritas.
 * Entrada: pagamento {aluno_id, titulo_numero, numero_parcela_completo},
 *          acordos [{id, aluno_id, numero_ulbra, status}], parcelas [{id, acordo_id, boleto, status}].
 * titulo_numero: numero do acordo no arquivo Santander, nao prova de baixa.
 * boleto: chave exata da parcela, conferida no contexto do acordo/aluno.
 */
export function identificarVinculoF1b({ pagamento, acordos = [], parcelas = [] } = {}) {
  if (!pagamento || !identidade(pagamento.aluno_id)) {
    return resposta("REVISAO", "ALUNO_NAO_IDENTIFICADO");
  }
  const aluno = identidade(pagamento.aluno_id);
  const informadoInvalido = (v) => v != null && String(v).trim() !== "" && somenteDigitos(v) === "";
  if (informadoInvalido(pagamento.titulo_numero) || informadoInvalido(pagamento.numero_parcela_completo)) {
    return resposta("REVISAO", "IDENTIFICADOR_INVALIDO");
  }
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
  const statusAcordo = String(acordo.status ?? "").trim().toUpperCase();
  // Mesma regra do portao da parcela, e pelo mesmo motivo: status nao carregado
  // reprova com motivo SEPARADO, para `select` sem a coluna ser diagnosticavel.
  if (!statusAcordo) {
    return resposta("REVISAO", "ACORDO_SEM_STATUS",
      { acordo_id: acordo.id, parcela_id: parcela?.id ?? null, status_acordo: acordo.status ?? null });
  }
  if (!ACORDO_EM_COBRANCA.has(statusAcordo)) {
    return resposta("REVISAO", "ACORDO_FORA_DE_COBRANCA",
      { acordo_id: acordo.id, parcela_id: parcela?.id ?? null, status_acordo: acordo.status });
  }
  if (parcela) {
    const status = String(parcela.status ?? "").trim().toUpperCase();
    // Status nao carregado tambem reprova: nao da para afirmar que a parcela esta
    // em cobranca sem ter lido o campo. Motivo SEPARADO para que um `select` que
    // esqueceu a coluna seja diagnosticavel, em vez de virar "fora de cobranca".
    if (!status) {
      return resposta("REVISAO", "PARCELA_SEM_STATUS",
        { acordo_id: acordo.id, parcela_id: parcela.id, status_parcela: parcela.status ?? null });
    }
    if (!STATUS_EM_COBRANCA.has(status)) {
      return resposta("REVISAO", "PARCELA_FORA_DE_COBRANCA",
        { acordo_id: acordo.id, parcela_id: parcela.id, status_parcela: parcela.status });
    }
  }
  return resposta("CANDIDATO_DETERMINISTICO", "IDENTIFICADOR_EXATO_E_ALUNO_CONFERIDO", {
    aluno_id: aluno,
    acordo_id: acordo.id,
    parcela_id: parcela?.id ?? null,
    pagamento_confirmado: false,
    baixa_confirmada: false,
  });
}
