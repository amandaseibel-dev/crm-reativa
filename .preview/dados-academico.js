// Respostas REAIS das seis consultas feitas ao Prime em 28/09/2026, mais os dois
// desfechos que a amostra não produziu e que a tela precisa saber mostrar.
//
// SÃO DADOS REAIS, e por isso o que está aqui é só matrícula, curso, campus,
// turno e situação — informação institucional. **Nenhum nome e nenhum CPF.**
// Quem quiser conferir a pessoa abre a ficha no CRM.
//
// Por que dado real e não inventado: o que esta tela precisa provar é que ela
// aguenta o formato que a API realmente devolve — três vínculos indistinguíveis
// com status diferentes, acentuação dividindo o mesmo curso, metade das linhas
// sem situação. Dado inventado sempre sai mais limpo do que a realidade, e um
// preview limpo não prova nada.

const F = "prime:students_search";

// A ordem das linhas é a ordem em que a API devolveu. Não reordenar: `ordem` é o
// único discriminador de vínculos com curso, campus e turno idênticos.
function consulta(registration, vinculos, quando = "2026-09-28T23:45:00Z") {
  return {
    consulta_id: `consulta-${registration}`,
    resultado: "COM_VINCULOS",
    detalhe_falha: null,
    http_status: 200,
    registration,
    fonte: F,
    consultado_em: quando,
    consultado_por: "amanda.seibel@aelbra.com.br",
    vinculos: vinculos.map((v, i) => ({
      linha_id: `${registration}-${i + 1}`,
      ordem: i + 1,
      curso: v[0], campus: v[1], turno: v[2],
      status: v[3], graduated: v[4], admission_year: v[5],
    })),
  };
}

const CANOAS = "Universidade Luterana do Brasil - Campus Canoas";
const GUAIBA = "Universidade Luterana do Brasil - Campus Guaíba";
const GRAVATAI = "Universidade Luterana do Brasil - Campus Gravataí";
const POP = "Universidade Luterana do Brasil - POP";
const EAD = "Universidade Luterana do Brasil - EAD";
const CEULP = "Centro Universitário Luterano de Palmas - CEULP";
const MED_PALMAS = "ULBRA MEDICINA - PALMAS";
const AD = "ENSINO A DISTANCIA";

export const CASOS = [
  {
    rotulo: "Formado no CRM — e formado em UM curso, entre cinco",
    alunoId: "aluno-201008325",
    situacaoNoCrm: "Formado",
    nota: "As duas linhas de bacharelado diferem só por acento e têm situações diferentes — uma delas com Formado? sim. Normalizar o acento fundiria as duas e apagaria um status.",
    leitura: consulta("201008325", [
      ["EDUCACAO FISICA", null, null, "Reopção de Curso", false, 2020],
      ["EDUCACAO FISICA - BACHARELADO", GUAIBA, "NOITE", "Reopção de Curso", false, 2021],
      ["EDUCAÇÃO FÍSICA - BACHARELADO", CANOAS, "NOITE", "Mudança de Campus", true, 2023],
      ["CIÊNCIAS DO EXERCÍCIO: FISIOLOGIA E TREINAMENTO FÍSICO", POP, AD, "Formado", true, null],
      ["EDUCAÇÃO FÍSICA - LICENCIATURA", CANOAS, "NOITE", null, false, null],
      ["Disciplinas Isoladas", null, null, null, false, 2000],
    ]),
  },
  {
    rotulo: "Formado no CRM — com Desistente e Desvinculado ao lado",
    alunoId: "aluno-202007063",
    situacaoNoCrm: "Formado",
    nota: "Duas linhas têm o curso “EDUCACAO FISICA” literalmente igual, com situações diferentes (Desistente e Desvinculado).",
    leitura: consulta("202007063", [
      ["EDUCACAO FISICA", null, null, "Desistente", false, 2020],
      ["EDUCACAO FISICA - BACHARELADO", GRAVATAI, "NOITE", "Mudança de Campus", false, null],
      ["EDUCACAO FISICA", GRAVATAI, "NOITE", "Desvinculado", false, 2022],
      ["EDUCAÇÃO FÍSICA - BACHARELADO", CANOAS, "NOITE", "Formado", true, 2024],
      ["Disciplinas Isoladas", null, null, null, false, 2000],
    ]),
  },
  {
    rotulo: "Trancado no CRM — trancado em dois cursos, reaberto num deles",
    alunoId: "aluno-221005273",
    situacaoNoCrm: "Trancado",
    nota: "Três vínculos em ENFERMAGEM, com três situações diferentes. O turno de um vem sujo: “NOITE...”, com os pontos literais.",
    leitura: consulta("221005273", [
      ["ENFERMAGEM", null, null, "TRANSFERENCIA DE CURRICULOS", false, 2022],
      ["ENFERMAGEM", CEULP, "NOITE", "Trancado", false, 2023],
      ["ENFERMAGEM", CEULP, "NOITE...", "Entrada via Reabertura", false, null],
      ["NUTRIÇÃO", CEULP, "NOITE", "Trancado", false, null],
      ["MEDICINA", MED_PALMAS, "Integral", null, false, null],
      ["Disciplinas Isoladas", null, null, null, false, 2000],
    ]),
  },
  {
    rotulo: "Trancado no CRM — o caso que prova a ambiguidade",
    alunoId: "aluno-222007757",
    situacaoNoCrm: "Trancado",
    nota: "Três vínculos em COMÉRCIO EXTERIOR com curso, campus e turno IDÊNTICOS, e status Reopção de Curso, Cancelado e nulo. Nenhum campo disponível os distingue — é por isso que a correspondência não pode ser confirmada.",
    leitura: consulta("222007757", [
      ["SUPERIOR DE TECNOLOGIA EM PROCESSOS GERENCIAIS", null, null, "Reopção de Curso", false, 2023],
      ["SUPERIOR DE TECNOLOGIA EM COMÉRCIO EXTERIOR", EAD, AD, "Reopção de Curso", false, 2025],
      ["SUPERIOR DE TECNOLOGIA EM COMÉRCIO EXTERIOR", POP, AD, "Cancelado", false, 2025],
      ["GEOGRAFIA - LICENCIATURA", EAD, AD, "Reopção de Curso", false, 2022],
      ["HISTÓRIA - LICENCIATURA", EAD, AD, "Trancado", false, null],
      ["SUPERIOR DE TECNOLOGIA EM COMÉRCIO EXTERIOR", EAD, AD, null, false, null],
      ["GEOGRAFIA - LICENCIATURA", EAD, AD, null, false, null],
      ["Disciplinas Isoladas", null, null, null, false, 2000],
    ]),
  },
  {
    rotulo: "Cancelado no CRM — e o Prime não tem nenhum “Cancelado”",
    alunoId: "aluno-221016167",
    situacaoNoCrm: "Cancelado",
    nota: "Divergência: nenhum vínculo do Prime tem status “Cancelado”. Os CONTRATOS desta pessoa têm — mas contrato não é situação acadêmica, e a tela não usa um no lugar do outro. 4 dos 7 vínculos vêm sem situação.",
    leitura: consulta("221016167", [
      ["MEDICINA VETERINÁRIA", null, null, "TRANSFERENCIA DE CURRICULOS", false, 2022],
      ["DIREITO DIURNO", CEULP, "MANHA", "Reopção de Curso", false, 2023],
      ["PSICOLOGIA", CEULP, "MANHA", "Entrada via Reabertura", false, null],
      ["ADMINISTRAÇÃO (EAD)", POP, AD, null, false, null],
      ["MEDICINA", MED_PALMAS, "Integral", null, false, null],
      ["PSICOLOGIA", CEULP, "MANHA", null, false, null],
      ["Disciplinas Isoladas", null, null, null, false, 2000],
    ]),
  },
  {
    rotulo: "Cancelado no CRM — e o Prime diz Matriculado Curso Normal",
    alunoId: "aluno-232005998",
    situacaoNoCrm: "Cancelado",
    nota: "Divergência no sentido contrário: o CRM diz que saiu, e a única situação que o Prime informa é “Matriculado Curso Normal”.",
    leitura: consulta("232005998", [
      ["ALFABETIZAÇÃO E LETRAMENTO", EAD, AD, "Matriculado Curso Normal", false, 2023],
      ["GESTÃO PEDAGÓGICA E ADMINISTRATIVA EM AMBIENTES EDUCATIVOS", POP, AD, null, false, null],
      ["CURSO SUPERIOR DE TECNOLOGIA EM GESTÃO FINANCEIRA", EAD, AD, null, false, null],
    ]),
  },

  // ------------------------------------------------------------------------
  // Os dois desfechos que a amostra de seis NÃO produziu. Entram porque são
  // justamente os que se confundem na pressa -- e confundir "a API caiu" com
  // "o aluno não tem vínculo" é o erro que faz alguém parar de cobrar quem deve.
  // ------------------------------------------------------------------------
  {
    rotulo: "Consulta sem resultado (desfecho construído, não veio da amostra)",
    alunoId: "aluno-sem-resultado",
    situacaoNoCrm: "Término do Contrato",
    nota: "A API respondeu 200 e não trouxe linha nenhuma. A tela diz que isso NÃO é “o aluno não tem vínculo”: a busca é por CPF e pode não encontrar o cadastro.",
    leitura: {
      consulta_id: "consulta-sem-resultado", resultado: "SEM_RESULTADO",
      detalhe_falha: null, http_status: 200, registration: null, fonte: F,
      consultado_em: "2026-09-28T23:46:00Z", consultado_por: "amanda.seibel@aelbra.com.br",
      vinculos: [],
    },
  },
  {
    rotulo: "Falha de comunicação (desfecho construído, não veio da amostra)",
    alunoId: "aluno-falha",
    situacaoNoCrm: "Aguardando Matrícula",
    nota: "Não se sabe nada. A tela precisa dizer isso com todas as letras, nunca “sem vínculo”, e oferecer tentar de novo.",
    leitura: {
      consulta_id: "consulta-falha", resultado: "FALHA_COMUNICACAO",
      detalhe_falha: "HTTP 503", http_status: 503, registration: null, fonte: F,
      consultado_em: "2026-09-28T23:47:00Z", consultado_por: "amanda.seibel@aelbra.com.br",
      vinculos: [],
    },
  },
  {
    rotulo: "Nunca consultado — a tela consulta a API sozinha",
    alunoId: "aluno-nunca-consultado",
    situacaoNoCrm: null,
    nota: "Não há dado local. O bloco chama a Edge Function por conta própria, sem ninguém clicar. Aqui a chamada é dublada e devolve o caso da 222007757 depois de um segundo, para dar para ver o “Consultando…”.",
    leitura: null,
  },
];
