// Supabase inerte para o preview da situação acadêmica: sem rede, sem banco,
// sem login. O COMPONENTE é o real (src/components/SituacaoAcademicaPrime.jsx).
//
// O dublê se comporta como a camada real, não como atalho:
//   - `usuario_e_gestao` responde conforme o papel escolhido na barra do topo.
//     É ele que decide se o botão aparece e se a consulta automática roda;
//   - `prime_academico_ultima` devolve `null` para quem nunca foi consultado, e
//     devolve ERRO (não `null`) no caso de erro de leitura -- os dois são
//     estados diferentes, e o preview existe para mostrar a diferença;
//   - devolve OBJETO NOVO a cada chamada (structuredClone), porque a RPC também
//     devolve. Reaproveitar a mesma referência faria a tela parecer que não
//     atualiza, e o "defeito" não existiria em produção;
//   - `functions.invoke` demora 1s de propósito, senão o estado "Consultando…"
//     passa rápido demais para ser conferido.

import { CASOS } from "./dados-academico.js";

const porAluno = new Map(CASOS.map((c) => [c.alunoId, c]));

// Papel escolhido na barra do preview. Objeto exportado (e não valor solto)
// para a barra conseguir trocar sem recarregar o módulo.
export const cenario = { gestao: true };

// O que a Edge Function devolveria: aqui, o caso mais difícil (três vínculos
// indistinguíveis com status diferentes).
//
// Resolvido NA HORA DA CHAMADA, não no carregamento do módulo: assim o dublê
// não depende da ordem em que o bundler avalia os módulos. Amarrado ao topo,
// isto quebrava com "Cannot read properties of undefined" a cada recarga do
// HMR -- um defeito do preview que parece defeito do componente.
const respostaDaFuncao = () =>
  CASOS.find((c) => c.alunoId === "aluno-990100004")?.leitura ?? null;

const novo = (o) => (o == null ? null : structuredClone(o));

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: { email: "gestao@exemplo.test" } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  rpc: async (nome, args) => {
    if (nome === "usuario_e_gestao") return { data: cenario.gestao, error: null };
    if (nome === "prime_academico_ultima") {
      const caso = porAluno.get(args?.p_aluno_id);
      // Erro de leitura é ERRO, nunca `data: null` -- se virasse null, a tela
      // diria "nunca consultado" e o preview esconderia justamente o caso.
      if (caso?.erroLeitura) return { data: null, error: { message: caso.erroLeitura } };
      return { data: novo(caso?.leitura ?? null), error: null };
    }
    return { data: null, error: null };
  },
  functions: {
    invoke: async (nome, { body } = {}) => {
      await new Promise((r) => setTimeout(r, 1000));
      if (nome !== "prime-academico") return { data: null, error: new Error("função desconhecida") };
      // O caso "falha" continua falhando quando se aperta Atualizar: é assim que
      // se confere que a mensagem de falha não vira sucesso por insistência.
      if (body?.aluno_id === "aluno-falha") {
        return { data: { ok: true, leitura: novo(porAluno.get("aluno-falha").leitura) }, error: null };
      }
      // Erro de REDE ao chamar a função: a tela precisa manter a última consulta
      // boa visível e avisar que a tentativa de agora não foi.
      if (body?.aluno_id === "aluno-990100001") {
        throw new Error("Failed to fetch");
      }
      return { data: { ok: true, leitura: novo(respostaDaFuncao()) }, error: null };
    },
  },
  // Se a tela tentar escrever em tabela, o preview estoura na hora em vez de
  // fingir que deu certo -- este bloco não deve escrever em nada.
  from: () => { throw new Error("o bloco de situação acadêmica não escreve em tabela nenhuma"); },
};
