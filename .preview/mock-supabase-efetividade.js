// Supabase inerte para conferir os QUATRO recortes da Efetividade sem login.
// O COMPONENTE é o real; só a camada de serviço é dublada.
// MATRÍCULAS E NOMES FICTÍCIOS.

const GRUPOS = {
  "2024": [["Ainda não consultados", 1979, 100]],
  "2025": [["Ainda não consultados", 2889, 100]],
  "2026/1": [["Status identificado: Trancado", 412, 16.1],
             ["Status identificado: Formado", 118, 4.6],
             ["Múltiplas situações", 260, 10.2],
             ["Informação incompleta", 301, 11.8],
             ["Sem resultado na busca", 44, 1.7],
             ["Consulta indisponível", 7, 0.3],
             ["Ainda não consultados", 1411, 55.3]],
  "2026/2": [["Informação incompleta", 9, 0.5],
             ["Ainda não consultados", 1901, 99.5]],
};
const TOTAIS = { "2024": 1979, "2025": 2889, "2026/1": 2553, "2026/2": 1910 };

const perfil = (ano, sem) => {
  const k = ano === "2026" ? ano + "/" + (sem || "1") : ano;
  return {
    recorte: k, reconstruido_em: "2026-09-29T12:30:00Z", total_alunos: TOTAIS[k],
    grupos: (GRUPOS[k] || []).map(([grupo, alunos, pct]) => ({ grupo, alunos, pct })),
    importacao: { fonte: "Relatório de inadimplência (importação)",
                  atualizado_em: "2026-08-04T00:00:00Z", situacoes: [] },
  };
};

const detalhe = (grupo) => ({
  grupo, reconstruido_em: "2026-09-29T12:30:00Z",
  alunos: [
    { aluno_id: "aa000000-0000-4000-8000-000000000001", nome: "Aluna Exemplo Um",
      cpf_mascarado: "***.111.111-**",
      situacoes: [{ curso: "ENFERMAGEM", campus: "CEULP", turno: "NOITE", status: "Trancado", matricula: "990100003" },
                  { curso: "NUTRIÇÃO", campus: "CEULP", turno: "NOITE", status: null, matricula: "990100003" }],
      fonte: "prime:students_search", consultado_em: "2026-09-29T11:44:00Z",
      situacao_importada: "Trancado", importado_em: "2026-08-04T00:00:00Z" },
    { aluno_id: "aa000000-0000-4000-8000-000000000002", nome: "Aluno Exemplo Dois",
      cpf_mascarado: "***.222.222-**", situacoes: [],
      fonte: null, consultado_em: null, situacao_importada: null, importado_em: null },
  ],
});

export const supabase = {
  auth: {
    // O e-mail precisa passar em `podeVerIndicadores`, senao a pagina mostra
    // "Em breve" e o preview nao prova nada. A sessao e inerte -- nao ha banco.
    getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } } }),
    getSession: async () => ({ data: { session: { user: { email: "amanda.seibel@aelbra.com.br" } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
  rpc: async (nome, args) => {
    if (nome === "usuario_e_gestao") return { data: true, error: null };
    if (nome === "carteira_academico_perfil") return { data: perfil(args?.p_ano, args?.p_semestre), error: null };
    if (nome === "carteira_academico_detalhe") return { data: detalhe(args?.p_grupo), error: null };
    if (nome === "prime_academico_piloto_painel") return { data: [], error: null };
    if (nome === "carteira_2026_1_indicadores")
      return { data: { total: { convertido: 11221306.5, em_aberto: 9529074.26, em_validacao: 962983.57,
                                academico: 38940.39, carteira: 21752304.72, cpfs: 5253, titulos: 14988,
                                recebido: 6330000 }, gerado_em: "2026-09-11T00:00:00Z" }, error: null };
    if (nome === "carteira_2026_2_negociacoes")
      return { data: { total: { negociado: 478097.36, recebido: 338000, cpfs: 261, acordos: 264, saldo: 141000, titulos: 287 },
                       estados: [{ estado: "Quitado", negociado: 300383.25 }] }, error: null };
    if (nome === "carteira_2026_2_contexto")
      return { data: { carteira_valor: 5130000, carteira_titulos: 2522, carteira_cpfs: 1910, remessas: 15,
                       primeira_remessa: "2026-07-06", ultima_remessa: "2026-09-09" }, error: null };
    if (nome === "carteira_saldo_historico_por_ano")
      return { data: { prime_coletado_em: "2026-09-29",
        anos: [
          { ano: "2024", aberto: { alunos: 1979, mensalidades: 6374, valor: 3900000 },
            carteira: { valor_original: 9500000, titulos: 13000, cpfs: 2528, entrada_de: "2026-07-02", entrada_ate: "2026-09-09" },
            negociado: 300000, recebido: 220000, ulbra_166: { valor: 2500000 },
            cursos: [{ curso: "Graduação Presencial", alunos: 900, mensalidades: 3000, valor: 2800000 }] },
          { ano: "2025", aberto: { alunos: 2889, mensalidades: 10487, valor: 6215900.07 },
            carteira: { valor_original: 15197210.88, titulos: 20852, cpfs: 5683, entrada_de: "2026-07-02", entrada_ate: "2026-09-09" },
            negociado: 464340.18, recebido: 374316.67, ulbra_166: { valor: 5128318.96 },
            cursos: [{ curso: "Graduação Presencial", alunos: 1316, mensalidades: 4541, valor: 4651465.74 }] },
        ], sem_semestre: { mensalidades: 450, valor: 70321.37 } }, error: null };
    return { data: null, error: null };
  },
  functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { throw new Error("a Efetividade nao escreve em tabela"); },
};
