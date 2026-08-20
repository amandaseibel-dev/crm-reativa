// Supabase inerte para o preview visual: sem rede, sem banco, sem login.

// PDF de uma pagina, o menor que o Chrome abre. Existe so para o preview poder
// mostrar o anexo abrindo de verdade em aba nova.
const PDF_EXEMPLO =
  "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBv" +
  "Ymo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlw" +
  "ZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgOTkgOTldPj5lbmRvYmoKdHJhaWxlcjw8" +
  "L1Jvb3QgMSAwIFI+Pg==";

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
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
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
  rpc: async () => ({ data: [], error: null }),
  functions: { invoke: async () => ({ data: {}, error: null }) },
};
export default supabase;
