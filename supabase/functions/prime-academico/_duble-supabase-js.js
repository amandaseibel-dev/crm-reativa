// Dublê do cliente remoto `https://esm.sh/@supabase/supabase-js@2`.
//
// POR QUE EXISTE. `index.ts` só é exercitável de ponta a ponta se o import
// remoto resolver. O vitest não busca URL, então `vitest.config.js` aponta
// aquele especificador para cá. Nada aqui vai para produção: a Edge continua
// importando o pacote real.
//
// Este arquivo não decide nada -- cada teste programa o cliente que quer.
let fabrica = null;

/** Instala a fábrica que responderá aos `createClient` do próximo teste. */
export function programarCliente(fn) {
  fabrica = fn;
}

export function createClient(url, chave, opts) {
  if (!fabrica) throw new Error("dublê do supabase-js usado sem programarCliente()");
  return fabrica(url, chave, opts);
}
