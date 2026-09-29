// Supabase inerte para o preview da situação acadêmica: sem rede, sem banco,
// sem login. O COMPONENTE é o real (src/components/SituacaoAcademicaPrime.jsx).
//
// O dublê se comporta como a camada real, não como atalho:
//   - `prime_academico_ultima` devolve `null` para quem nunca foi consultado, que
//     é o que a RPC faz -- e é esse `null` que dispara a consulta automática;
//   - devolve OBJETO NOVO a cada chamada (structuredClone), porque a RPC também
//     devolve. Reaproveitar a mesma referência faria a tela parecer que não
//     atualiza, e o "defeito" não existiria em produção;
//   - `functions.invoke` demora 1s de propósito, senão o estado "Consultando…"
//     passa rápido demais para ser conferido.

import { CASOS } from "./dados-academico.js";

const porAluno = new Map(CASOS.map((c) => [c.alunoId, c]));

// O que a Edge Function devolveria: aqui, o caso mais difícil da amostra.
const RESPOSTA_DA_FUNCAO = CASOS.find((c) => c.alunoId === "aluno-222007757").leitura;

const novo = (o) => (o == null ? null : structuredClone(o));

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  rpc: async (nome, args) => {
    if (nome !== "prime_academico_ultima") return { data: null, error: null };
    const caso = porAluno.get(args?.p_aluno_id);
    return { data: novo(caso?.leitura ?? null), error: null };
  },
  functions: {
    invoke: async (nome, { body } = {}) => {
      await new Promise((r) => setTimeout(r, 1000));
      if (nome !== "prime-academico") return { data: null, error: new Error("função desconhecida") };
      // O caso "falha" continua falhando quando se aperta Atualizar: é assim que
      // se confere que a mensagem de falha não vira sucesso por insistência.
      if (body?.aluno_id === "aluno-falha") {
        return { data: { ok: true, resultado: "FALHA_COMUNICACAO", leitura: novo(porAluno.get("aluno-falha").leitura) }, error: null };
      }
      return { data: { ok: true, resultado: "COM_VINCULOS", leitura: novo(RESPOSTA_DA_FUNCAO) }, error: null };
    },
  },
  // Se a tela tentar escrever em tabela, o preview estoura na hora em vez de
  // fingir que deu certo -- este bloco não deve escrever em nada.
  from: () => { throw new Error("o bloco de situação acadêmica não escreve em tabela nenhuma"); },
};
