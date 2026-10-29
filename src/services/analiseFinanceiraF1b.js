// Leitura da F1.b por confirmacao individual. Nunca modifica banco ou executa baixa.
// A consulta exige RLS de gestao em todas as tabelas; erros ou paginação => REVISAO.
//
// O conjunto de pagamentos da confirmacao vem de `confirmacao_pagamentos_resolver_gestao`
// (envelope com portao da migration 20261019120000), que repassa as DUAS rotas do
// resolver que ja existia: `VINCULO_GRAVADO` e `CHAVE_MESMA_TRANSACAO`. Nao
// reimplementamos nenhuma delas aqui -- antes este arquivo lia
// `solicitacao_confirmacao_pagamentos` direto e refazia em JS a rota 1, perdendo a 2.
import { analisarConfirmacaoF1b } from "../utils/integracaoConfirmacaoF1b";
import { numeroCanonico } from "../utils/vinculoFinanceiroF1b";

const revisar = (motivo, extra = {}) => ({ situacao: "REVISAO", motivo, ...extra });
const MAX = 500;
// Um pre-filtro `in(...)` compara contra o valor GRAVADO, enquanto o motor compara
// canonizado dos dois lados. Enviar as duas formas evita que o pre-filtro esconda
// a linha que o motor consideraria igual. Medido em 19/10/2026: hoje nenhuma das
// colunas (`acordos.numero_ulbra`, `parcelas.boleto`, `pagamentos.titulo_numero`,
// `numero_parcela_completo`, `matricula`, `prime_contratos.registration`) tem zero
// a esquerda ou caractere nao-digito, logo as duas formas coincidem -- a divergencia
// e latente, nao ativa, e esta fechada aqui antes de aparecer.
const formas = (valores) => [...new Set(valores.flatMap(v => {
  const bruto = String(v ?? "").trim();
  const canon = numeroCanonico(bruto);
  return [bruto, canon].filter(Boolean);
}))];
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
    // Portao EXPLICITO antes de ler qualquer PII. O envelope da RPC tem o seu proprio
    // (e e ele que vale no servidor); este aqui existe para a tela poder DIZER
    // "sem permissao" em vez de "leitura negada", e como segunda barreira para as
    // leituras diretas abaixo -- `prime_contratos` e legivel por qualquer logado.
    const { data: ehGestao, error: erroPortao } = await client.rpc("usuario_e_gestao");
    if (erroPortao) throw erroPortao;
    if (ehGestao !== true) return revisar("SEM_PERMISSAO_DE_GESTAO");

    const cs = await buscar(client.from("solicitacoes_confirmacao_pagamento")
      .select("id,aluno_id,valor_informado").eq("id", confirmacaoId), 1);
    if (cs.length !== 1) return revisar("CONFIRMACAO_INACESSIVEL");
    const confirmacao = cs[0];
    if (!confirmacao.aluno_id) return revisar("CONFIRMACAO_SEM_IDENTIDADE");

    const { data: resolvido, error: erroResolver } = await client
      .rpc("confirmacao_pagamentos_resolver_gestao", { p_confirmacao_id: confirmacaoId });
    if (erroResolver) throw erroResolver;
    if (!Array.isArray(resolvido) || !resolvido.length) return revisar("RESOLVER_SEM_RESPOSTA");
    // O resolver devolve uma linha com `pagamento_id` nulo quando NAO resolveu:
    // `SEM_VINCULO` (nao achou conjunto) ou `AMBIGUO` (achou mais de um, ou a soma
    // nao fecha, ou ha pagamento de outro aluno). Nos dois casos a decisao e humana,
    // e o motivo dele vai junto para a tela poder dizer POR QUE.
    const comPagamento = resolvido.filter(r => r?.pagamento_id);
    if (!comPagamento.length) {
      const linha = resolvido[0] ?? {};
      return revisar(`RESOLVER_${String(linha.prova ?? "SEM_RESPOSTA")}`,
        { motivo_resolver: linha.motivo ?? null });
    }
    const vinculos = comPagamento.map(r => ({
      confirmacao_id: String(confirmacaoId), pagamento_id: r.pagamento_id, prova: r.prova,
    }));

    const ids = vinculos.map(v => v.pagamento_id);
    if (new Set(ids).size !== ids.length) return revisar("RELACAO_DE_PAGAMENTOS_INVALIDA");
    const pagamentos = await buscar(client.from("pagamentos")
      .select("id,aluno_id,cpf,matricula,valor_pago,titulo_numero,numero_parcela_completo")
      .in("id", ids));
    if (pagamentos.length !== ids.length) return revisar("PAGAMENTO_INACESSIVEL");

    const alunoId = String(confirmacao.aluno_id);
    const alunos = await buscar(client.from("alunos").select("id,cpf").eq("id", alunoId), 1);
    if (alunos.length !== 1) return revisar("IDENTIDADE_NAO_COMPROVADA");

    // Sem NENHUMA matricula nao ha ponte Santander -> Prime -> CPF para prova alguma.
    // Com matricula faltando em PARTE dos pagamentos segue adiante: o motor reprova
    // individualmente com `CHAVE_DE_IDENTIDADE_AUSENTE`, que diz qual pagamento falhou.
    const matriculas = formas(pagamentos.map(p => p.matricula).filter(Boolean));
    if (!matriculas.length) return revisar("MATRICULA_AUSENTE");
    const primeContratos = await buscar(client.from("prime_contratos")
      .select("registration,cpf").in("registration", matriculas));

    // Recupera identificadores financeiros sem restringir ao aluno, para detectar duplicidade global.
    const numeros = formas(pagamentos.map(p => p.titulo_numero));
    const boletos = formas(pagamentos.map(p => p.numero_parcela_completo));
    // Ausencia de chave significa revisao no motor, nao assumir acordo por aluno.
    const acordos = numeros.length
      ? await buscar(client.from("acordos").select("id,aluno_id,numero_ulbra,status").in("numero_ulbra", numeros))
      : [];
    const parcelas = boletos.length
      ? await buscar(client.from("parcelas").select("id,acordo_id,boleto,status").in("boleto", boletos))
      : [];
    // Consulta também os acordos pai das parcelas (para preservar titularidade).
    const pais = [...new Set(parcelas.map(x => x.acordo_id).filter(Boolean))];
    if (pais.length) {
      const extras = await buscar(client.from("acordos").select("id,aluno_id,numero_ulbra,status").in("id", pais));
      for (const x of extras) if (!acordos.some(a => a.id === x.id)) acordos.push(x);
    }
    // A soma contra `valor_informado` e conferida DE NOVO no motor, em JS, depois de o
    // resolver ja a ter conferido em SQL. Redundancia de proposito: sao duas somas
    // independentes sobre o mesmo conjunto, e divergir entre elas e sinal de problema.
    return analisarConfirmacaoF1b({ confirmacao, vinculos, pagamentos, acordos, parcelas, alunos, primeContratos });
  } catch {
    return revisar("LEITURA_INCOMPLETA_OU_NEGADA");
  }
}
