// Supabase inerte para o preview visual do Preventivo: sem rede, sem banco,
// sem login. As RESPOSTAS imitam a FORMA que as RPCs reais devolvem — o que
// aparece na tela é o componente de verdade do PR.
//
// NENHUM DADO REAL. Alunos, matrículas, títulos e telefones são inventados.
//
// TRAVA: este arquivo só entra em cena pela config exclusiva do preview
// (vite.preview-preventivo.config.js). Se algum dia ele for arrastado para um
// build de produção por engano, a aplicação quebra AQUI, alto e cedo, em vez
// de subir no ar servindo dados de mentira como se fossem do banco.
if (import.meta.env && import.meta.env.PROD) {
  throw new Error(
    "mock-supabase do preview do Preventivo foi carregado num build de produção. " +
    "Ele serve dados de exemplo e nunca pode ir ao ar."
  );
}

const hoje = new Date();
const dia = (n) => {
  const d = new Date(hoje);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const CARTEIRA = {
  id: "c0000000-0000-4000-8000-000000000001",
  nome: "Vencimentos de outubro",
  descricao: null,
  venc_de: dia(-10),
  venc_ate: dia(35),
  criada_em: new Date(Date.now() - 864e5 * 3).toISOString(),
  criada_por: "amanda.seibel@aelbra.com.br",
  encerrada_em: null,
  titulos: 6,
  alunos: 5,
  saldo_informado: 3780.5,
  com_vinculo_unico: 5,
  ultima_sinc: new Date(Date.now() - 36e5 * 5).toISOString(),
};

const T = (i, over = {}) => ({
  id: `t-${i}`,
  aluno: ["Ana Ribeiro", "Bruno Tavares", "Carla Menezes", "Diego Alves", "Elisa Prado"][i % 5],
  matricula: `202600${1000 + i}`,
  documento: `90000${10 + i}`,
  competencia: "2026/2",
  unidade: "Sede",
  vencimento: dia([-9, -4, 2, 12, 25, -2][i] ?? 5),
  dias_atraso: -([-9, -4, 2, 12, 25, -2][i] ?? 5),
  vencimento_origem: dia([-9, -34, 2, 12, 25, -2][i] ?? 5),
  saldo_informado: [620.41, 482.54, 780.0, 550.0, 900.0, 447.55][i] ?? 500,
  valor_fonte: [0, 482.54, 380.0, 550.0, null, 268.0][i] ?? 500,
  vinculo: ["UNICO", "UNICO", "UNICO", "UNICO", "AMBIGUO", "UNICO"][i] ?? "PENDENTE",
  candidatos: i === 4 ? 2 : 1,
  situacao_origem: "EM ABERTO",
  status: "ATIVO",
  portador: 95,
  portador_nome: "SANTANDER CC 13050976-6 - CONVENIO 272036",
  presente_no_extrato: true,
  sinc_em: new Date(Date.now() - 36e5 * 5).toISOString(),
  celular: ["5551999990001", "5551988887777", null, "5551977770004", "5551966660005", "5551999990001"][i] ?? null,
  email: ["ana@exemplo.com", "bruno@exemplo.com", "carla@exemplo.com", null, "elisa@exemplo.com", "ana@exemplo.com"][i] ?? null,
  lote: i < 4 ? "Remessa 01/10" : "Remessa 08/10",
  ultima_alteracao: null,
  ultima_acao: i < 3 ? { nome: "Lembrete D-3 outubro", canal: "WHATSAPP", estado: "ENVIO_CONFIRMADO", em: new Date(Date.now() - 864e5).toISOString() } : null,
  ...over,
});

const TITULOS = [
  T(0, { ultima_alteracao: { tipo: "VALOR_FONTE_ZEROU", em: new Date(Date.now() - 36e5 * 6).toISOString(), valor: 620.41 } }),
  T(1),
  T(2, { ultima_alteracao: { tipo: "VALOR_FONTE_CAIU", em: new Date(Date.now() - 36e5 * 6).toISOString(), valor: 400 } }),
  T(3),
  T(4),
  T(5, { ultima_alteracao: { tipo: "VALOR_FONTE_CAIU", em: new Date(Date.now() - 36e5 * 30).toISOString(), valor: 179.55 } }),
];

const SITUACAO = {
  em_andamento: null,
  ultima_completa: { id: "s-1", concluido_em: new Date(Date.now() - 36e5 * 5).toISOString(), alvos: 5, consultados: 5 },
  ultima_tentativa: { id: "s-1", status: "CONCLUIDA", concluido_em: new Date(Date.now() - 36e5 * 5).toISOString(), erros: 0, mensagem: null },
  titulos_nunca_sincronizados: 0,
  titulos_desatualizados: 0,
};

const RESULTADOS = {
  hoje: dia(0),
  carteira: { id: CARTEIRA.id, nome: CARTEIRA.nome, venc_de: CARTEIRA.venc_de, venc_ate: CARTEIRA.venc_ate },
  totais: {
    alunos: 5, titulos: 6, saldo_informado: 3780.5,
    sem_sinc: 0, na_janela: 6, fora_da_janela: 0,
  },
  vinculo: { UNICO: 5, AMBIGUO: 1 },
  valor_na_fonte: { titulos_com_vinculo_unico: 5, soma_atual: 1680.54 },
  alteracoes: {
    VALOR_FONTE_ZEROU: { titulos: 1, valor: 620.41 },
    VALOR_FONTE_CAIU: { titulos: 2, valor: 579.55 },
    VINCULO_AMBIGUO: { titulos: 1, valor: 0 },
  },
  recebido: {
    valor: null,
    motivo: "Não há como afirmar recebimento com a fonte autorizada de hoje. Medido em 28/09/2026 contra variável independente (o relatório de inadimplência do próprio dia): dos 101 títulos comprovadamente EM ABERTO, 101 tinham paymentDate preenchido, 19 com data posterior ao vencimento, e 61 tinham paidAmount igual ao netAmount.",
  },
  conferencia: {
    valor_na_fonte_no_primeiro_ciclo: 2880.5, queda_registrada: 1199.96,
    alta_registrada: 0, valor_na_fonte_agora: 1680.54,
  },
  por_dia: [
    { dia: dia(-2), titulos: 1, valor: 179.55 },
    { dia: dia(0), titulos: 2, valor: 1020.41 },
  ],
  alunos: { com_alguma_queda: 2, com_todos_zerados: 1, sem_alteracao: 2 },
};

const ACOES = [
  {
    id: "a-1", nome: "Lembrete D-3 outubro", canal: "WHATSAPP", estado: "ENVIO_CONFIRMADO",
    filtros: {}, criada_em: new Date(Date.now() - 864e5 * 2).toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br",
    exportada_em: new Date(Date.now() - 864e5 * 2).toISOString(),
    envio_confirmado_em: new Date(Date.now() - 864e5).toISOString(),
    cancelada_em: null,
    atualizacao_financeira: { sinc_id: "s-0", em: new Date(Date.now() - 864e5 * 2).toISOString() },
    incluidos: 3, alunos: 3,
    separados: {
      SEM_CELULAR_VALIDO: 1,
      CELULAR_AMBIGUO_NO_ARQUIVO: 1,
      OUTRO_TITULO_DO_MESMO_ALUNO_JA_NO_PUBLICO: 1,
    },
    conferencia_financeira: { UNICO: 2, AMBIGUO: 1 },
    alteracao_apos_envio: { titulos: 2, valor: 1020.41 },
  },
  {
    id: "a-2", nome: "Aviso por e-mail — vencimento 20/10", canal: "EMAIL", estado: "PREPARADA",
    filtros: {}, criada_em: new Date(Date.now() - 36e5 * 2).toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br",
    exportada_em: null, envio_confirmado_em: null, cancelada_em: null,
    atualizacao_financeira: { sinc_id: "s-1", em: SITUACAO.ultima_completa.concluido_em },
    incluidos: 4, alunos: 4,
    separados: { EMAIL_MULTIPLO_NO_ARQUIVO: 1, VALOR_NA_FONTE_ZERADO: 1 },
    conferencia_financeira: { UNICO: 4 },
    alteracao_apos_envio: { titulos: 0, valor: 0 },
  },
];

const PUBLICO_DENTRO = TITULOS.filter((t) => t.celular && t.saldo_informado > 0).slice(0, 3).map((t) => ({
  matricula: t.matricula, aluno: t.aluno, contato: t.celular, documento: t.documento,
  vencimento: t.vencimento, saldo_informado: t.saldo_informado, valor_fonte: t.valor_fonte,
  incluido: true, motivo: null,
}));
const PUBLICO_FORA = [{
  matricula: "2026001002", aluno: "Carla Menezes", contato: null, documento: null,
  vencimento: dia(2), saldo_informado: 780, valor_fonte: 380, incluido: false, motivo: "SEM_CELULAR_VALIDO",
}];

const REMESSAS = [
  {
    id: "l-2", carteira_id: CARTEIRA.id, nome: "Remessa 08/10", arquivo: "relatorio_inadimplencia.csv",
    importada_em: new Date(Date.now() - 864e5).toISOString(), importada_por: "amanda.seibel@aelbra.com.br",
    alunos: 5, titulos: 6, valor: 3780.5,
    whatsapp_disponivel: 4, email_disponivel: 3, para_revisao: 2,
    recusas: 3, recusas_por_motivo: { DUPLICADA_NO_ARQUIVO: 2, SEM_NOME: 1 },
    localizados: 5, precisam_revisao: 1, nao_consultados: 0, com_alteracao: 3,
    acoes: [{ id: "a-1", nome: "Lembrete D-3 outubro", canal: "WHATSAPP", estado: "ENVIO_CONFIRMADO" }],
    comparacao: {
      primeira_remessa: false,
      continua_em_aberto: { titulos: 4, valor: 2580.5 },
      regularizados_entre_remessas: { titulos: 2, valor: 1199.96 },
      novos_na_remessa: { titulos: 2, valor: 1200 },
    },
  },
  {
    id: "l-1", carteira_id: CARTEIRA.id, nome: "Remessa 01/10", arquivo: "relatorio_inadimplencia.csv",
    importada_em: new Date(Date.now() - 864e5 * 8).toISOString(), importada_por: "amanda.seibel@aelbra.com.br",
    alunos: 5, titulos: 6, valor: 3600.0,
    whatsapp_disponivel: 4, email_disponivel: 3, para_revisao: 2,
    recusas: 0, recusas_por_motivo: {}, acoes: [],
    localizados: 6, precisam_revisao: 0, nao_consultados: 0, com_alteracao: 0,
    comparacao: { primeira_remessa: true },
  },
];

const RESULTADO_ACAO = {
  "a-1": {
    acao: "a-1", remessa: "l-1", remessa_seguinte: "l-2",
    alunos_acionados: 3, titulos_acionados: 3, valor_acionado: 1800.41,
    continuam_em_aberto: 2, regularizados_entre_remessas: 1,
    valor_regularizado: 620.41, taxa_regularizacao: 33.3,
    aguardando_proxima_remessa: false,
    definicao: "Regularizado entre remessas = o título acionado não voltou no relatório de inadimplência seguinte. NÃO é pagamento confirmado.",
  },
  "a-2": { acao: "a-2", remessa: "l-2", remessa_seguinte: null,
           titulos_acionados: 4, valor_acionado: 2580.5, aguardando_proxima_remessa: true },
};

const LOTES = [
  { id: "l-1", nome: "Remessa 01/10", arquivo: "titulos-outubro.xlsx", status: "CONFIRMADO",
    criado_em: new Date(Date.now() - 864e5 * 3).toISOString(), criado_por: "amanda.seibel@aelbra.com.br",
    resumo: {}, titulos: 4, recusas: 2 },
  { id: "l-2", nome: "Remessa 08/10", arquivo: "titulos-outubro-2.xlsx", status: "CONFIRMADO",
    criado_em: new Date(Date.now() - 864e5).toISOString(), criado_por: "amanda.seibel@aelbra.com.br",
    resumo: {}, titulos: 2, recusas: 0 },
];

// Linhas de EXEMPLO para a tabela e os dois gráficos novos. Inclui de
// propósito um caso medido por WhatsApp, um por e-mail, um de outro contexto e
// DOIS sem régua -- um sem envio confirmado e um sem remessa seguinte -- para o
// preview mostrar o estado vazio em vez de 0%.
const POR_ACAO = [
  { id: "a-1", nome: "Lembrete D-3 outubro", canal: "WHATSAPP", contexto: "PROXIMO_VENCIMENTO",
    estado: "ENVIO_CONFIRMADO", criada_em: new Date(Date.now() - 6 * 864e5).toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br", remessa_nome: "Remessa 01/10",
    alunos_acionados: 1840, alunos_regularizados: 712, titulos_acionados: 1902,
    regularizados_entre_remessas: 735, valor_acionado: "1284300.50",
    valor_regularizado: "492118.33", taxa_regularizacao: 38.6,
    taxa_regularizacao_alunos: 38.7, taxa_regularizacao_valor: 38.3,
    aguardando_envio_confirmado: false, aguardando_proxima_remessa: false },
  { id: "a-2", nome: "Boleto vencido — 1ª cobrança", canal: "WHATSAPP", contexto: "BOLETO_VENCIDO",
    estado: "ENVIO_CONFIRMADO", criada_em: new Date(Date.now() - 4 * 864e5).toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br", remessa_nome: "Remessa 03/10",
    alunos_acionados: 2460, alunos_regularizados: 517, titulos_acionados: 2602,
    regularizados_entre_remessas: 548, valor_acionado: "2104877.10",
    valor_regularizado: "402118.44", taxa_regularizacao: 21.1,
    taxa_regularizacao_alunos: 21.0, taxa_regularizacao_valor: 19.1,
    aguardando_envio_confirmado: false, aguardando_proxima_remessa: false },
  { id: "a-3", nome: "Boleto vencido — e-mail", canal: "EMAIL", contexto: "BOLETO_VENCIDO",
    estado: "ENVIO_CONFIRMADO", criada_em: new Date(Date.now() - 3 * 864e5).toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br", remessa_nome: "Remessa 03/10",
    alunos_acionados: 724, alunos_regularizados: 88, titulos_acionados: 741,
    regularizados_entre_remessas: 90, valor_acionado: "508214.00",
    valor_regularizado: "54118.90", taxa_regularizacao: 12.1,
    taxa_regularizacao_alunos: 12.2, taxa_regularizacao_valor: 10.6,
    aguardando_envio_confirmado: false, aguardando_proxima_remessa: false },
  { id: "a-4", nome: "Mensalidade de outubro", canal: "WHATSAPP", contexto: "BOLETO_VENCIDO",
    estado: "PREPARADA", criada_em: new Date().toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br", remessa_nome: "Remessa 08/10",
    alunos_acionados: 8312, alunos_regularizados: null, titulos_acionados: 8312,
    regularizados_entre_remessas: null, valor_acionado: "14427824.20",
    valor_regularizado: null, taxa_regularizacao: null,
    taxa_regularizacao_alunos: null, taxa_regularizacao_valor: null,
    aguardando_envio_confirmado: true, aguardando_proxima_remessa: false },
  { id: "a-5", nome: "Próximo ao vencimento — e-mail", canal: "EMAIL", contexto: "PROXIMO_VENCIMENTO",
    estado: "ENVIO_CONFIRMADO", criada_em: new Date(Date.now() - 864e5).toISOString(),
    criada_por: "amanda.seibel@aelbra.com.br", remessa_nome: "Remessa 08/10",
    alunos_acionados: 611, alunos_regularizados: null, titulos_acionados: 611,
    regularizados_entre_remessas: null, valor_acionado: "402118.00",
    valor_regularizado: null, taxa_regularizacao: null,
    taxa_regularizacao_alunos: null, taxa_regularizacao_valor: null,
    aguardando_envio_confirmado: false, aguardando_proxima_remessa: true },
];

const DEFINICAO = "Apareceu na remessa = em aberto. Recebeu ação = acionado. "
  + "NÃO apareceu na PRÓXIMA REMESSA VÁLIDA depois do ENVIO CONFIRMADO = regularizado. "
  + "Regularizado NÃO é pagamento confirmado.";


// ---- PAINEL E LINHA DO TEMPO (dados INVENTADOS, só para ver a tela) ----
const PAINEL = {
  cards: {
    inicio: { titulos: 13968, saldo: 24363782.56, quando: "2026-10-02T03:00:00+00:00", precisao: "DATA" },
    saiu: { titulos: 7828, valor: 16399073.06 },
    hoje: { titulos: 6278, saldo: 8104278.12, quando: "2026-10-06T03:00:00+00:00", precisao: "DATA" },
    alunos_acionados: 14068, remessas: 4, ordem_ambigua: false,
  },
  acoes_consolidado: {
    base_titulos: 14068, base_saldo: 24483840.64, pendentes_titulos: 0, pendentes_saldo: 0,
    com_regua_titulos: 14068, reducao_titulos: 7841, reducao_valor: 16423902.38,
    reducao_pct_titulos: 55.7, reducao_pct_valor: 67.1,
    custos_por_moeda: [{ moeda: "BRL", total: 0 }, { moeda: "USD", total: 595.38 }],
    observacao: "Cada título conta uma vez só, com o saldo do primeiro acionamento.",
  },
  pontos: [
    { remessa: "l-1", nome: "F1 — 02/10", quando: "2026-10-02T03:00:00+00:00", precisao: "DATA", ordem_no_dia: 1, ordem: 1, titulos: 13968, saldo: 24363782.56 },
    { remessa: "l-2", nome: "F2 — 05/10 manhã", quando: "2026-10-05T03:00:00+00:00", precisao: "DATA", ordem_no_dia: 1, ordem: 2, titulos: 11947, saldo: 20203179.94 },
    { remessa: "l-3", nome: "F3 — 05/10 tarde", quando: "2026-10-05T03:00:00+00:00", precisao: "DATA", ordem_no_dia: 2, ordem: 3, titulos: 10759, saldo: 18137532.27 },
    { remessa: "l-4", nome: "F4 — 06/10", quando: "2026-10-06T03:00:00+00:00", precisao: "DATA", ordem_no_dia: 1, ordem: 4, titulos: 6278, saldo: 8104278.12 },
  ],
  acoes: [
    { id: "a-1", nome: "E-mail de 02/10", canal: "EMAIL", contexto: "PROXIMO_VENCIMENTO", origem: "EXTERNA", estado: "ENVIADA", publico: "remessa_inteira", quando: "2026-10-02T03:00:00+00:00", precisao: "DATA", periodo: { de_nome: "F1 — 02/10", de_quando: "2026-10-02T03:00:00+00:00", de_precisao: "DATA", ate_nome: "F2 — 05/10 manhã", ate_quando: "2026-10-05T03:00:00+00:00", ate_precisao: "DATA" }, antes: { titulos: 13968, saldo: 24363782.56, alunos: 13968 }, reducao: { titulos: 2121, valor: 4248050.67, pct_titulos: 15.2, pct_valor: 17.4 }, saiu: { titulos: 2121, valor: 4248050.67 }, custo: { informado: false, total: null, moeda: null, por_aluno: null }, entradas: { titulos: 100, valor: 87448.05 }, ajuste_saldo: 0, depois: { titulos: 11947, saldo: 20203179.94 }, sem_envio_confirmado: false, aguardando_remessa: false, sequencia_nao_comprovada: false },
    { id: "a-2", nome: "E-mail de 05/10 (manhã)", canal: "EMAIL", contexto: "PROXIMO_VENCIMENTO", origem: "EXTERNA", estado: "ENVIADA", publico: "remessa_inteira", quando: "2026-10-05T03:00:00+00:00", precisao: "DATA", periodo: { de_nome: "F2 — 05/10 manhã", de_quando: "2026-10-05T03:00:00+00:00", de_precisao: "DATA", ate_nome: "F4 — 06/10", ate_quando: "2026-10-06T03:00:00+00:00", ate_precisao: "DATA" }, antes: { titulos: 11947, saldo: 20203179.94, alunos: 11947 }, reducao: { titulos: 5720, valor: 12163612.46, pct_titulos: 47.9, pct_valor: 60.2 }, saiu: { titulos: 5720, valor: 12163612.46 }, custo: { informado: false, total: null, moeda: null, por_aluno: null }, entradas: { titulos: 51, valor: 64710.64 }, ajuste_saldo: 0, depois: { titulos: 6278, saldo: 8104278.12 }, sem_envio_confirmado: false, aguardando_remessa: false, sequencia_nao_comprovada: false },
    { id: "a-3", nome: "WhatsApp de 05/10 (tarde)", canal: "WHATSAPP", contexto: "BOLETO_VENCIDO", origem: "EXTERNA", estado: "ENVIADA", publico: "remessa_inteira", quando: "2026-10-05T03:00:00+00:00", precisao: "DATA", periodo: { de_nome: "F3 — 05/10 tarde", de_quando: "2026-10-05T03:00:00+00:00", de_precisao: "DATA", ate_nome: "F4 — 06/10", ate_quando: "2026-10-06T03:00:00+00:00", ate_precisao: "DATA" }, antes: { titulos: 10759, saldo: 18137532.27, alunos: 10759 }, reducao: { titulos: 4532, valor: 10097140.99, pct_titulos: 42.1, pct_valor: 55.7 }, saiu: { titulos: 4532, valor: 10097140.99 }, custo: { informado: true, total: 595.38, moeda: "USD", por_aluno: 0.06 }, entradas: { titulos: 51, valor: 64710.64 }, ajuste_saldo: 0, depois: { titulos: 6278, saldo: 8104278.12 }, sem_envio_confirmado: false, aguardando_remessa: false, sequencia_nao_comprovada: false },
    { id: "a-4", nome: "Mensalidade de outubro", canal: "WHATSAPP", contexto: "PROXIMO_VENCIMENTO", origem: "CRM", estado: "PREPARADA", publico: "remessa_inteira", quando: null, precisao: null, periodo: {}, antes: { titulos: 8309, saldo: 14426544.69, alunos: 8309 }, reducao: { titulos: null, valor: null, pct_titulos: null, pct_valor: null }, saiu: { titulos: null, valor: null }, custo: { informado: false, total: null, moeda: null, por_aluno: null }, entradas: { titulos: null, valor: null }, ajuste_saldo: null, depois: { titulos: null, saldo: null }, sem_envio_confirmado: true, aguardando_remessa: false, sequencia_nao_comprovada: false },
  ],
  definicao: "REDUÇÃO OBSERVADA APÓS A AÇÃO = o título estava na foto de onde o envio saiu e não está na primeira foto comprovadamente posterior. Movimento observado, NÃO pagamento confirmado. CUSTO não entra em conta nenhuma da carteira.",
};

const INTERVALOS = [
  { ordem: 1, de: PAINEL.pontos[0], ate: PAINEL.pontos[1], ordem_comprovada: true,
    antes: { titulos: 13968, saldo: 24363782.56 }, depois: { titulos: 11947, saldo: 20203179.94 },
    saiu: { titulos: 2121, valor: 4248050.67 }, entradas: { titulos: 100, valor: 87448.05 },
    ajuste: 0, liquido: -4160602.62, liquido_titulos: -2021, pct_saldo: -17.1,
    acoes: [{ id: "a-1", nome: "E-mail de 02/10", canal: "EMAIL", contexto: "PROXIMO_VENCIMENTO", quando: "2026-10-02T03:00:00+00:00", precisao: "DATA", custo_informado: false, custo_total: null, custo_moeda: null }] },
  { ordem: 2, de: PAINEL.pontos[1], ate: PAINEL.pontos[2], ordem_comprovada: true,
    antes: { titulos: 11947, saldo: 20203179.94 }, depois: { titulos: 10759, saldo: 18137532.27 },
    saiu: { titulos: 1188, valor: 2065647.67 }, entradas: { titulos: 0, valor: 0 },
    ajuste: 0, liquido: -2065647.67, liquido_titulos: -1188, pct_saldo: -10.2,
    acoes: [{ id: "a-2", nome: "E-mail de 05/10 (manhã)", canal: "EMAIL", contexto: "PROXIMO_VENCIMENTO", quando: "2026-10-05T03:00:00+00:00", precisao: "DATA", custo_informado: false, custo_total: null, custo_moeda: null }] },
  { ordem: 3, de: PAINEL.pontos[2], ate: PAINEL.pontos[3], ordem_comprovada: true,
    antes: { titulos: 10759, saldo: 18137532.27 }, depois: { titulos: 6278, saldo: 8104278.12 },
    saiu: { titulos: 4532, valor: 10097140.99 }, entradas: { titulos: 51, valor: 64710.64 },
    ajuste: -824.8, liquido: -10033254.15, liquido_titulos: -4481, pct_saldo: -55.3,
    acoes: [{ id: "a-3", nome: "WhatsApp de 05/10 (tarde)", canal: "WHATSAPP", contexto: "BOLETO_VENCIDO", quando: "2026-10-05T03:00:00+00:00", precisao: "DATA", custo_informado: true, custo_total: 595.38, custo_moeda: "USD" }] },
];

const RESPOSTAS = {
  preventivo_resultados_por_acao: () => POR_ACAO,
  preventivo_resultados_por_contexto: () => ({
    periodo: { de: null, ate: null },
    definicao: DEFINICAO,
    contextos: {
      BOLETO_VENCIDO: {
        acoes: 3, acoes_com_envio_confirmado: 2, alunos_acionados: 11496,
        titulos_acionados: 11655, valor_acionado: 17040915.3,
        regularizados_entre_remessas: 638, valor_regularizado: 456237.34,
        continuam_em_aberto: 2705, taxa_regularizacao: 19.1,
        aguardando_proxima_remessa: 0, aguardando_envio_confirmado: 1,
        canais: {
          WHATSAPP: { acoes: 2, acoes_com_envio_confirmado: 1, alunos_acionados: 10772,
            titulos_acionados: 10914, valor_acionado: 16532692.3,
            regularizados_entre_remessas: 548, valor_regularizado: 402118.44,
            continuam_em_aberto: 2054, taxa_regularizacao: 21.1,
            aguardando_proxima_remessa: 0, aguardando_envio_confirmado: 1 },
          EMAIL: { acoes: 1, acoes_com_envio_confirmado: 1, alunos_acionados: 724,
            titulos_acionados: 741, valor_acionado: 508214,
            regularizados_entre_remessas: 90, valor_regularizado: 54118.9,
            continuam_em_aberto: 651, taxa_regularizacao: 12.1,
            aguardando_proxima_remessa: 0, aguardando_envio_confirmado: 0 },
        },
      },
      PROXIMO_VENCIMENTO: {
        acoes: 2, acoes_com_envio_confirmado: 2, alunos_acionados: 2451,
        titulos_acionados: 2513, valor_acionado: 1686418.5,
        regularizados_entre_remessas: 735, valor_regularizado: 492118.33,
        continuam_em_aberto: 1167, taxa_regularizacao: 38.6,
        aguardando_proxima_remessa: 1, aguardando_envio_confirmado: 0,
        canais: {
          WHATSAPP: { acoes: 1, acoes_com_envio_confirmado: 1, alunos_acionados: 1840,
            titulos_acionados: 1902, valor_acionado: 1284300.5,
            regularizados_entre_remessas: 735, valor_regularizado: 492118.33,
            continuam_em_aberto: 1167, taxa_regularizacao: 38.6,
            aguardando_proxima_remessa: 0, aguardando_envio_confirmado: 0 },
          EMAIL: { acoes: 1, acoes_com_envio_confirmado: 1, alunos_acionados: 611,
            titulos_acionados: 611, valor_acionado: 402118,
            regularizados_entre_remessas: 0, valor_regularizado: 0,
            continuam_em_aberto: 0, taxa_regularizacao: null,
            aguardando_proxima_remessa: 1, aguardando_envio_confirmado: 0 },
        },
      },
    },
  }),

  preventivo_carteiras: () => [CARTEIRA],
  preventivo_titulos: (a) => {
    let l = TITULOS;
    if (a?.p_alteracao === "zerado") l = l.filter((t) => t.valor_fonte !== null && t.valor_fonte <= 0);
    if (a?.p_alteracao === "caiu") l = l.filter((t) => t.ultima_alteracao);
    if (a?.p_alteracao === "sem_alteracao") l = l.filter((t) => !t.ultima_alteracao);
    if (a?.p_vinculo) l = l.filter((t) => t.vinculo === a.p_vinculo);
    if (a?.p_faixa_atraso === "a_vencer") l = l.filter((t) => t.dias_atraso < 0);
    return l;
  },
  preventivo_sinc_situacao: () => SITUACAO,
  preventivo_resultados: () => RESULTADOS,
  preventivo_acoes: () => ACOES,
  preventivo_lotes: () => LOTES,
  preventivo_painel: () => PAINEL,
  preventivo_intervalos: () => INTERVALOS,
  preventivo_acao_custo_definir: (a) => ({ acao: a?.p_acao_id, custo_total: a?.p_custo, informado: a?.p_custo !== null }),
  preventivo_remessas: () => REMESSAS,
  preventivo_remessa_resumo: (a) => REMESSAS.find((r) => r.id === a?.p_lote_id) || REMESSAS[0],
  preventivo_remessa_comparar: (a) => (REMESSAS.find((r) => r.id === a?.p_lote_id) || REMESSAS[0]).comparacao,
  preventivo_acao_resultado: (a) => RESULTADO_ACAO[a?.p_acao_id] || RESULTADO_ACAO["a-2"],
  preventivo_acao_publico: (a) => (a?.p_incluidos === false ? PUBLICO_FORA : PUBLICO_DENTRO),
  preventivo_acao_resumo: () => ACOES[0],
  preventivo_carteira_criar: () => CARTEIRA.id,
  preventivo_acao_preparar: () => ACOES[1],
  preventivo_acao_marcar: () => ACOES[0],
  preventivo_lote_previa: () => ({
    linhas_lidas: 128, linhas_aceitas: 120, linhas_recusadas: 8, alunos: 97, titulos: 120,
    valor_total: 74320.18, novos: 111, atualizados: 9, fora_da_janela: 3,
    sem_celular_valido: 11, sem_email_valido: 6, celular_compartilhado: 4,
    celular_ambiguo: 9, email_multiplo: 74, sem_identificador_de_titulo: 120,
    mesmo_vencimento_no_arquivo: 2,
    recusas_por_motivo: { SEM_MATRICULA: 2, VENCIMENTO_INVALIDO: 1, FORA_DO_PERIODO: 4, DUPLICADA_NO_ARQUIVO: 1 },
    exemplos_recusa: [{ linha: 7, motivo: "SEM_MATRICULA" }, { linha: 19, motivo: "FORA_DO_PERIODO" }],
  }),
  preventivo_lote_confirmar: () => ({ lote_id: "l-2", linhas_lidas: 128, linhas_aceitas: 120, linhas_recusadas: 8 }),
};

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: { id: "preview", email: "amanda.seibel@aelbra.com.br" } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  rpc: async (nome, args) => {
    const f = RESPOSTAS[nome];
    if (!f) return { data: null, error: { message: `RPC sem dublê no preview: ${nome}` } };
    return { data: f(args), error: null };
  },
  functions: { invoke: async () => ({ data: { concluido: true, sinc_id: "s-2", status: "CONCLUIDA" }, error: null }) },
};
export default supabase;
