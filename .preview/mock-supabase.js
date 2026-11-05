// Supabase inerte para o preview visual: sem rede, sem banco, sem login.

// PDF de uma pagina, o menor que o Chrome abre. Existe so para o preview poder
// mostrar o anexo abrindo de verdade em aba nova.
const PDF_EXEMPLO =
  "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBv" +
  "Ymo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlw" +
  "ZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgOTkgOTldPj5lbmRvYmoKdHJhaWxlcjw8" +
  "L1Jvb3QgMSAwIFI+Pg==";


// ---------------------------------------------------------------------------
// Fila do receptivo de mentira (nomes inventados, numeros inventados).
// O operador logado no preview ("operador@aelbra.com.br") entra na fila como
// "Você", em terceiro, para dar pra ver o destaque e os botoes de quem
// participa. Clicar em "Marcar" nos primeiros faz a vez andar ate voce.
// ---------------------------------------------------------------------------
const RECEPTIVOS = [
  { id: "u1", email: "bianca@aelbra.com.br",  apelido: "Bianca"  },
  { id: "u2", email: "rodrigo@aelbra.com.br", apelido: "Rodrigo" },
  { id: "u3", email: "operador@aelbra.com.br", apelido: "Marina" },
  { id: "u4", email: "tatiane@aelbra.com.br", apelido: "Tatiane" },
  { id: "u5", email: "jeferson@aelbra.com.br", apelido: "Jeferson" },
  { id: "u6", email: "camila@aelbra.com.br",  apelido: "Camila"  },
  { id: "u7", email: "marcos@aelbra.com.br",  apelido: "Marcos"  },
  { id: "u8", email: "pri@aelbra.com.br",     apelido: "Pri"     },
  // Em pausa: some da barra, como em producao.
  { id: "u9", email: "lucas@aelbra.com.br",   apelido: "Lucas"   },
  { id: "u10", email: "ana@aelbra.com.br",    apelido: "Ana"     },
  { id: "u11", email: "duda@aelbra.com.br",   apelido: "Duda"    },
  { id: "u12", email: "renan@aelbra.com.br",  apelido: "Renan"   },
];

const minutosAtras = (m) => new Date(Date.now() - m * 60000).toISOString();

const FILA = [
  { email: "bianca@aelbra.com.br",  nome: "Bianca Souza",     atendimentos_hoje: 2, ultimo_atendimento: minutosAtras(95), em_pausa: false },
  { email: "rodrigo@aelbra.com.br", nome: "Rodrigo Lima",     atendimentos_hoje: 2, ultimo_atendimento: minutosAtras(40), em_pausa: false },
  { email: "operador@aelbra.com.br", nome: "Marina Alves",     atendimentos_hoje: 3, ultimo_atendimento: minutosAtras(22), em_pausa: false },
  { email: "tatiane@aelbra.com.br", nome: "Tatiane Rocha",    atendimentos_hoje: 4, ultimo_atendimento: minutosAtras(12), em_pausa: false },
  { email: "jeferson@aelbra.com.br", nome: "Jeferson Alves",  atendimentos_hoje: 5, ultimo_atendimento: minutosAtras(31), em_pausa: false },
  { email: "camila@aelbra.com.br",  nome: "Camila Prado",     atendimentos_hoje: 6, ultimo_atendimento: minutosAtras(8),  em_pausa: false },
  { email: "marcos@aelbra.com.br",  nome: "Marcos Vieira",    atendimentos_hoje: 7, ultimo_atendimento: minutosAtras(3),  em_pausa: false },
  { email: "pri@aelbra.com.br",     nome: "Priscila Nunes",   atendimentos_hoje: 9, ultimo_atendimento: minutosAtras(1),  em_pausa: false },
  { email: "lucas@aelbra.com.br",   nome: "Lucas Teixeira",   atendimentos_hoje: 1, ultimo_atendimento: minutosAtras(70), em_pausa: true  },
  { email: "ana@aelbra.com.br",     nome: "Ana Beatriz",      atendimentos_hoje: 3, ultimo_atendimento: minutosAtras(55), em_pausa: false },
  { email: "duda@aelbra.com.br",    nome: "Eduarda Martins",  atendimentos_hoje: 5, ultimo_atendimento: minutosAtras(17), em_pausa: false },
  { email: "renan@aelbra.com.br",   nome: "Renan Fogaca",     atendimentos_hoje: 8, ultimo_atendimento: minutosAtras(5),  em_pausa: false },
];

const TABELAS = {
  usuarios: () => RECEPTIVOS.map((u) => ({ ...u, receptivo: true })),
  // `online_em` e sempre "agora": a tela derruba quem passa de 90s sem bater o
  // heartbeat, e no preview nao ha heartbeat nenhum rodando.
  fila_receptivo: () => FILA.map((l) => ({ ...l, online_em: new Date().toISOString() })),
};

// Construtor de consulta minimo: encadeia como o supabase-js e e "awaitable".
function consulta(linhas) {
  const estado = { linhas };
  const api = {
    select: () => api,
    eq: (coluna, valor) => {
      estado.linhas = estado.linhas.filter((l) => l[coluna] === valor);
      return api;
    },
    in: (coluna, valores) => {
      estado.linhas = estado.linhas.filter((l) => valores.includes(l[coluna]));
      return api;
    },
    order: () => api,
    limit: () => api,
    maybeSingle: async () => ({ data: estado.linhas[0] || null, error: null }),
    single: async () => ({ data: estado.linhas[0] || null, error: null }),
    then: (resolver) => resolver({ data: estado.linhas, error: null }),
  };
  return api;
}

const sessaoFalsa = {
  user: { id: "preview", email: "operador@aelbra.com.br",
          user_metadata: { nome: "Operador Preview" } },
};
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: sessaoFalsa }, error: null }),
    getUser: async () => ({ data: { user: sessaoFalsa.user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
  // A barra do receptivo le `usuarios` e `fila_receptivo` e escreve pelos dois
  // RPCs. Aqui isso vira memoria: clicar "Marcar" realmente soma 1 e manda o
  // operador para o fim da fila, que e o que se quer conferir no preview.
  from: (tabela) => consulta(TABELAS[tabela] ? TABELAS[tabela]() : []),
  // O anexo pede uma URL assinada ao Storage no momento em que aparece. Sem
  // isto o preview quebrava a tela inteira (`storage` indefinido) assim que uma
  // mensagem com arquivo entrava na conversa.
  storage: {
    from: () => ({
      createSignedUrl: async (caminho) => ({
        // data: URL de um PDF minimo -- clicar abre um PDF de verdade em aba
        // nova, que e justamente o comportamento que se quer conferir.
        data: { signedUrl: `data:application/pdf;base64,${PDF_EXEMPLO}#${caminho}` },
        error: null,
      }),
    }),
  },
  rpc: async (nome, args) => {
    if (nome === "fila_receptivo_marcar_atendido") {
      const linha = FILA.find((l) => l.email === args?.p_email);
      if (linha) {
        // Soma; NAO zera. O contador do dia e do banco, igual a producao.
        linha.atendimentos_hoje += 1;
        linha.ultimo_atendimento = new Date().toISOString();
      }
      return { data: null, error: null };
    }
    if (nome === "fila_receptivo_heartbeat") {
      const linha = FILA.find((l) => l.email === args?.p_email);
      if (linha && args?.p_em_pausa !== undefined) linha.em_pausa = Boolean(args.p_em_pausa);
      return { data: null, error: null };
    }
    return { data: [], error: null };
  },
  functions: { invoke: async () => ({ data: {}, error: null }) },
};
export default supabase;
