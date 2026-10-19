// Leitura da F1.b por confirmacao individual. Nunca modifica banco ou executa baixa.
// A consulta exige RLS de gestao em todas as tabelas; erros ou paginação => REVISAO.
import { analisarConfirmacaoF1b } from "../utils/integracaoConfirmacaoF1b";
import { numeroCanonico } from "../utils/vinculoFinanceiroF1b";

const revisar = (motivo) => ({ situacao: "REVISAO", motivo });
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
    // Portao EXPLICITO antes de ler qualquer PII. Sem ele, a protecao dependia da
    // ORDEM das consultas (a tabela de vinculo e gestao-only e abortava antes de
    // `prime_contratos`, que qualquer logado le) -- protecao real, mas acidental:
    // bastava reordenar as consultas para vazar CPF a um operador comum.
    const { data: ehGestao, error: erroPortao } = await client.rpc("usuario_e_gestao");
    if (erroPortao) throw erroPortao;
    if (ehGestao !== true) return revisar("SEM_PERMISSAO_DE_GESTAO");

    const cs = await buscar(client.from("solicitacoes_confirmacao_pagamento")
      .select("id,aluno_id,valor_informado").eq("id", confirmacaoId), 1);
    if (cs.length !== 1) return revisar("CONFIRMACAO_INACESSIVEL");
    const confirmacao = cs[0];
    if (!confirmacao.aluno_id) return revisar("CONFIRMACAO_SEM_IDENTIDADE");
    const vinculosGravados = await buscar(client.from("solicitacao_confirmacao_pagamentos")
      .select("confirmacao_id,pagamento_id").eq("confirmacao_id", confirmacaoId));
    // A rota do legado (`CHAVE_MESMA_TRANSACAO`, de `confirmacao_pagamentos_resolver`)
    // NAO esta coberta aqui: essa funcao nao tem EXECUTE para `authenticated` e nao
    // tem portao interno, entao abrir para o navegador exige migration. Medido em
    // 19/10/2026 na fila aberta: 150 das 274 confirmacoes so se resolvem por ela.
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
