// Supabase inerte para o preview visual: sem rede, sem banco, sem login.
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
  rpc: async () => ({ data: [], error: null }),
  functions: { invoke: async () => ({ data: {}, error: null }) },
};
export default supabase;
