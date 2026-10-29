// FIXTURE SINTÉTICA — números inventados, nada de produção.
//
// Este arquivo é VERSIONADO, então não pode conter nada real: sem valores de
// produção (nem aproximados), sem CPF, sem nome, sem id, sem contagem real de
// aluno ou título. Os números aqui são redondos de propósito — é para bater o
// olho e reconhecer na hora que é dado de mentira.
//
// O que ele precisa provar é a INTERFACE: cinco meses, um mês sem pagamento
// nenhum, um mês sem cancelado, a composição do Pago, ficha ≠ CPF e a
// invariante fechando. Os valores em si não provam nada e não devem.
//
// Para conferir a tela com os números reais, crie `.preview/dados-efetividade
// .local.js` exportando `payload` no mesmo formato. Esse arquivo é ignorado
// pelo Git e o preview passa a preferi-lo automaticamente.
export const payload = {
  gerado_em: "2026-09-29T12:00:00+00:00",
  semestre: "2026/2",
  saldo_metodo:
    "FIXTURE SINTÉTICA. Saldo do classificador 2026/2: saldo = valor original − recebido. Nos títulos " +
    "ligados a um acordo que cobre mais de um título, o recebido vem de rateio pela proporção de parcelas " +
    "pagas do acordo. Não usa o saldo cobrável da norma.",
  atualizado_em: { prime_coletado_em: "2026-09-28", titulo_mexido_em: "2026-09-29" },
  conferencia: { meses_que_nao_fecham: 0, diferenca_total: 0 },
  pago_composicao: { atribuido: 29500, rateado: 7500 },
  total: {
    vencimento_de: "2026-04-10", vencimento_ate: "2026-08-10",
    fichas: 120, cpfs: 118,
    situacoes: {
      entrou:    { alunos: 120, titulos: 150, valor: 161000 },
      pago:      { alunos: 20,  titulos: 22,  valor: 37000 },
      negociado: { alunos: 10,  titulos: 11,  valor: 16000 },
      cancelado: { alunos: 4,   titulos: 4,   valor: 5000 },
      em_aberto: { alunos: 60,  titulos: 70,  valor: 69400 },
      pendente:  { alunos: 30,  titulos: 33,  valor: 33600 },
    },
  },
  meses: [
    { // mês sem pagamento e sem acordo: prova que a linha zerada aparece
      competencia: "2026-04-01", vencimento_de: "2026-04-10", vencimento_ate: "2026-04-10",
      datas_de_vencimento: 1,
      situacoes: {
        entrou:    { alunos: 3, titulos: 3, valor: 1000 },
        em_aberto: { alunos: 2, titulos: 2, valor: 400 },
        pendente:  { alunos: 1, titulos: 1, valor: 600 },
      },
      status: [
        { status: "Sem pagamento e sem negociação", alunos: 2, titulos: 2, valor: 400 },
        { status: "Baixa / ajuste acadêmico", alunos: 1, titulos: 1, valor: 600 },
      ],
    },
    { // mês sem cancelado
      competencia: "2026-05-01", vencimento_de: "2026-05-10", vencimento_ate: "2026-05-20",
      datas_de_vencimento: 2,
      situacoes: {
        entrou:    { alunos: 12, titulos: 14, valor: 10000 },
        pago:      { alunos: 3,  titulos: 3,  valor: 2000 },
        negociado: { alunos: 2,  titulos: 2,  valor: 1000 },
        em_aberto: { alunos: 5,  titulos: 6,  valor: 4000 },
        pendente:  { alunos: 3,  titulos: 3,  valor: 3000 },
      },
      pago_composicao: { atribuido: 1500, rateado: 500 },
      status: [
        { status: "Sem pagamento e sem negociação", alunos: 5, titulos: 6, valor: 4000 },
        { status: "Pago / Quitado", alunos: 3, titulos: 3, valor: 2500 },
        { status: "Liquidado no Prime, origem não comprovada", alunos: 2, titulos: 2, valor: 2000 },
        { status: "Negociado regular", alunos: 2, titulos: 2, valor: 1500 },
      ],
    },
    {
      competencia: "2026-06-01", vencimento_de: "2026-06-10", vencimento_ate: "2026-06-10",
      datas_de_vencimento: 1,
      situacoes: {
        entrou:    { alunos: 20, titulos: 24, valor: 20000 },
        pago:      { alunos: 4,  titulos: 4,  valor: 5000 },
        negociado: { alunos: 2,  titulos: 2,  valor: 2000 },
        cancelado: { alunos: 1,  titulos: 1,  valor: 1000 },
        em_aberto: { alunos: 9,  titulos: 12, valor: 7000 },
        pendente:  { alunos: 5,  titulos: 5,  valor: 5000 },
      },
      pago_composicao: { atribuido: 4000, rateado: 1000 },
      status: [
        { status: "Sem pagamento e sem negociação", alunos: 9, titulos: 12, valor: 7000 },
        { status: "Pago / Quitado", alunos: 4, titulos: 4, valor: 6000 },
        { status: "Em conferência", alunos: 5, titulos: 5, valor: 5000 },
        { status: "Negociado em atraso", alunos: 2, titulos: 2, valor: 3000 },
        { status: "Cobrança cancelada", alunos: 1, titulos: 1, valor: 1000 },
      ],
    },
    {
      competencia: "2026-07-01", vencimento_de: "2026-07-01", vencimento_ate: "2026-07-25",
      datas_de_vencimento: 8,
      situacoes: {
        entrou:    { alunos: 40, titulos: 48, valor: 50000 },
        pago:      { alunos: 6,  titulos: 7,  valor: 10000 },
        negociado: { alunos: 3,  titulos: 3,  valor: 5000 },
        cancelado: { alunos: 1,  titulos: 1,  valor: 2000 },
        em_aberto: { alunos: 20, titulos: 25, valor: 23000 },
        pendente:  { alunos: 10, titulos: 12, valor: 10000 },
      },
      pago_composicao: { atribuido: 9000, rateado: 1000 },
      status: [
        { status: "Sem pagamento e sem negociação", alunos: 20, titulos: 25, valor: 23000 },
        { status: "Pago / Quitado", alunos: 6, titulos: 7, valor: 12000 },
        { status: "Liquidado no Prime, origem não comprovada", alunos: 10, titulos: 12, valor: 10000 },
        { status: "Acordo quebrado", alunos: 2, titulos: 2, valor: 3000 },
        { status: "Cobrança cancelada", alunos: 1, titulos: 1, valor: 2000 },
      ],
    },
    {
      competencia: "2026-08-01", vencimento_de: "2026-08-05", vencimento_ate: "2026-08-10",
      datas_de_vencimento: 3,
      situacoes: {
        entrou:    { alunos: 60, titulos: 61, valor: 80000 },
        pago:      { alunos: 10, titulos: 11, valor: 20000 },
        negociado: { alunos: 5,  titulos: 5,  valor: 8000 },
        cancelado: { alunos: 2,  titulos: 2,  valor: 2000 },
        em_aberto: { alunos: 30, titulos: 31, valor: 35000 },
        pendente:  { alunos: 15, titulos: 15, valor: 15000 },
      },
      pago_composicao: { atribuido: 15000, rateado: 5000 },
      status: [
        { status: "Sem pagamento e sem negociação", alunos: 30, titulos: 31, valor: 35000 },
        { status: "Pago / Quitado", alunos: 10, titulos: 11, valor: 24000 },
        { status: "Em conferência", alunos: 15, titulos: 15, valor: 15000 },
        { status: "Negociado regular", alunos: 5, titulos: 5, valor: 4000 },
        { status: "Acordo cancelado", alunos: 1, titulos: 1, valor: 1000 },
        { status: "Cobrança cancelada", alunos: 2, titulos: 2, valor: 2000 },
      ],
    },
  ],
};
