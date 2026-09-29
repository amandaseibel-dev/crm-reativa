// Casos do preview. **Nenhum dado real.**
//
// CORREÇÃO DE UMA AFIRMAÇÃO MINHA QUE ESTAVA ERRADA. A primeira versão deste
// arquivo usava as matrículas reais dos seis alunos consultados e dizia que
// eram "informação institucional, nenhum dado pessoal". Não é verdade: a
// matrícula identifica uma pessoa, e matrícula + curso + campus + turno +
// situação acadêmica de alguém que está sendo cobrado é dado pessoal, ainda que
// sem nome e sem CPF. Colocar isso num arquivo versionado do repositório é
// espalhar dado pessoal para um lugar onde ele não precisa estar.
//
// As matrículas abaixo são FICTÍCIAS -- nove dígitos, mesmo formato das reais,
// começando por 99 (que não corresponde a ano de ingresso nenhum, então não
// colide com matrícula de verdade).
//
// O QUE FOI PRESERVADO, e é o que importa: a ESTRUTURA observada na consulta de
// 28/09/2026. Os casos difíceis continuam todos aqui -- três vínculos com
// curso, campus e turno idênticos e status diferentes; acentuação dividindo o
// mesmo curso; o mesmo curso literal com duas situações; metade das linhas sem
// situação; e as duas divergências contra o CRM. Dado inventado costuma sair
// mais limpo do que a realidade, e preview limpo não prova nada -- por isso a
// forma foi mantida fiel, mesmo trocando os identificadores.

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
      // A matrícula vive EM CADA LINHA. Aqui ela se repete, como se repetiu na
      // consulta real -- o caso de matrículas diferentes tem uma entrada só
      // para ele, no fim do arquivo.
      registration: v[6] ?? registration,
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
    alunoId: "aluno-990100001",
    situacaoNoCrm: "Formado",
    nota: "As duas linhas de bacharelado diferem só por acento e têm situações diferentes — uma delas com Formado? sim. Normalizar o acento fundiria as duas e apagaria um status.",
    leitura: consulta("990100001", [
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
    alunoId: "aluno-990100002",
    situacaoNoCrm: "Formado",
    nota: "Duas linhas têm o curso “EDUCACAO FISICA” literalmente igual, com situações diferentes (Desistente e Desvinculado).",
    leitura: consulta("990100002", [
      ["EDUCACAO FISICA", null, null, "Desistente", false, 2020],
      ["EDUCACAO FISICA - BACHARELADO", GRAVATAI, "NOITE", "Mudança de Campus", false, null],
      ["EDUCACAO FISICA", GRAVATAI, "NOITE", "Desvinculado", false, 2022],
      ["EDUCAÇÃO FÍSICA - BACHARELADO", CANOAS, "NOITE", "Formado", true, 2024],
      ["Disciplinas Isoladas", null, null, null, false, 2000],
    ]),
  },
  {
    rotulo: "Trancado no CRM — trancado em dois cursos, reaberto num deles",
    alunoId: "aluno-990100003",
    situacaoNoCrm: "Trancado",
    nota: "Três vínculos em ENFERMAGEM, com três situações diferentes. O turno de um vem sujo: “NOITE...”, com os pontos literais.",
    leitura: consulta("990100003", [
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
    alunoId: "aluno-990100004",
    situacaoNoCrm: "Trancado",
    nota: "Três vínculos em COMÉRCIO EXTERIOR com curso, campus e turno IDÊNTICOS, e status Reopção de Curso, Cancelado e nulo. Nenhum campo disponível os distingue — é por isso que a correspondência não pode ser confirmada.",
    leitura: consulta("990100004", [
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
    alunoId: "aluno-990100005",
    situacaoNoCrm: "Cancelado",
    nota: "Divergência: nenhum vínculo do Prime tem status “Cancelado”. Os CONTRATOS desta pessoa têm — mas contrato não é situação acadêmica, e a tela não usa um no lugar do outro. 4 dos 7 vínculos vêm sem situação.",
    leitura: consulta("990100005", [
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
    alunoId: "aluno-990100006",
    situacaoNoCrm: "Cancelado",
    nota: "Divergência no sentido contrário: o CRM diz que saiu, e a única situação que o Prime informa é “Matriculado Curso Normal”.",
    leitura: consulta("990100006", [
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
    rotulo: "Matrículas diferentes na mesma resposta (desfecho construído)",
    alunoId: "aluno-matriculas-diferentes",
    situacaoNoCrm: "Trancado",
    nota: "A amostra de seis não produziu este caso — nela a matrícula se repetiu dentro de cada aluno. Entra porque seis alunos não provam regra: se um dia vierem matrículas diferentes, a matrícula precisa aparecer LINHA A LINHA, e o cabeçalho fica sem matrícula em vez de escolher uma.",
    leitura: {
      consulta_id: "consulta-matriculas-diferentes", resultado: "COM_VINCULOS",
      detalhe_falha: null, http_status: 200,
      registration: null, // divergem: o cabeçalho não escolhe uma
      fonte: F, consultado_em: "2026-09-28T23:48:00Z", consultado_por: "gestao@exemplo.test",
      vinculos: [
        { linha_id: "md-1", ordem: 1, registration: "990100007", curso: "ENFERMAGEM", campus: CEULP, turno: "NOITE", status: "Trancado", graduated: false, admission_year: 2022 },
        { linha_id: "md-2", ordem: 2, registration: "990100008", curso: "NUTRIÇÃO", campus: CEULP, turno: "NOITE", status: "Matriculado Curso Normal", graduated: false, admission_year: 2024 },
        { linha_id: "md-3", ordem: 3, registration: "990100008", curso: "NUTRIÇÃO", campus: CEULP, turno: "NOITE", status: null, graduated: false, admission_year: null },
      ],
    },
  },
  {
    rotulo: "Erro ao ler o que está gravado (desfecho construído)",
    alunoId: "aluno-erro-leitura",
    situacaoNoCrm: "Formado",
    nota: "Não se conseguiu LER o registro local. Isto NÃO é “nunca consultado”: dizer isso mandaria consultar de novo um dado que talvez já exista. A tela diz que não conseguiu olhar, e não dispara consulta nova.",
    leitura: null,
    erroLeitura: "permission denied for function prime_academico_ultima",
  },
  {
    rotulo: "Paginação incompleta (desfecho construído)",
    alunoId: "aluno-paginacao-incompleta",
    situacaoNoCrm: "Trancado",
    nota: "A consulta bateu no teto de páginas sem provar que acabou. Há dado, e ele NÃO pode ser apresentado como lista completa — dizer “sucesso” afirmaria um total que ninguém mediu. Os vínculos aparecem, com a ressalva.",
    leitura: {
      consulta_id: "consulta-parcial", resultado: "PAGINACAO_INCOMPLETA",
      detalhe_falha: "paginacao interrompida no teto de 500 linhas -- a lista pode estar incompleta",
      http_status: 200, registration: "990100009", fonte: F,
      consultado_em: "2026-09-29T09:10:00Z", consultado_por: "gestao@exemplo.test",
      vinculos: [
        { linha_id: "pi-1", ordem: 1, registration: "990100009", curso: "DIREITO", campus: CEULP, turno: "MANHA", status: "Trancado", graduated: false, admission_year: 2021 },
        { linha_id: "pi-2", ordem: 2, registration: "990100009", curso: "DIREITO", campus: CEULP, turno: "MANHA", status: "Entrada via Reabertura", graduated: false, admission_year: null },
      ],
    },
  },
  {
    rotulo: "Falhou agora, mas a consulta boa anterior continua na tela",
    alunoId: "aluno-falha-com-boa",
    situacaoNoCrm: "Cancelado",
    nota: "A tentativa de agora falhou. A última consulta que deu certo vem DO BANCO junto com a falha — então o dado continua visível mesmo depois de recarregar a página ou fechar e reabrir a ficha. Sem isso, uma falha apagava de vez o que já se sabia.",
    leitura: {
      consulta_id: "consulta-falha-2", resultado: "FALHA_COMUNICACAO",
      detalhe_falha: "HTTP 503", http_status: 503, registration: null, fonte: F,
      consultado_em: "2026-09-29T09:20:00Z", consultado_por: "gestao@exemplo.test",
      vinculos: [],
      ultima_boa: {
        consulta_id: "consulta-boa", resultado: "COM_VINCULOS",
        registration: "990100010", consultado_em: "2026-09-28T23:45:00Z",
        consultado_por: "gestao@exemplo.test",
        vinculos: [
          { linha_id: "ub-1", ordem: 1, registration: "990100010", curso: "ADMINISTRAÇÃO (EAD)", campus: POP, turno: AD, status: "Desvinculado", graduated: false, admission_year: 2022 },
          { linha_id: "ub-2", ordem: 2, registration: "990100010", curso: "ADMINISTRAÇÃO (EAD)", campus: POP, turno: AD, status: null, graduated: false, admission_year: null },
        ],
      },
    },
  },
  {
    rotulo: "Nunca consultado — a tela consulta a API sozinha",
    alunoId: "aluno-nunca-consultado",
    situacaoNoCrm: null,
    nota: "Não há dado local. O bloco chama a Edge Function por conta própria, sem ninguém clicar. Aqui a chamada é dublada e devolve o caso da 990100004 depois de um segundo, para dar para ver o “Consultando…”.",
    leitura: null,
  },
];
