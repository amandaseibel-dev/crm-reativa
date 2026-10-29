// Registro do bloqueio de cadência — a parte que o 500 de 26/10/2026 derrubou.
//
// POR QUE ISTO É UM MÓDULO SEPARADO: o handler mora dentro de `Deno.serve`, em
// index.ts, e não é importável pelo vitest da raiz. Sem extrair, o defeito
// abaixo não tem teste que o prenda. Mesmo padrão de prime-sonda/portao.ts.
//
// O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR. O que `supabase.rpc()`
// devolve é um PostgrestFilterBuilder: é *thenable* (tem `then`), mas NÃO é uma
// Promise — não tem `catch`. O código anterior encadeava `.catch(() => {})`
// nele, e isso levantava `TypeError: ... .catch is not a function` ANTES de a
// RPC ser disparada. Três consequências, todas observadas em produção:
//
//   1. o erro escapava do handler e o operador recebia 500 em vez do 403 com a
//      frase legível ("você já iniciou N conversas novas hoje neste número");
//   2. como o estouro vinha antes do `then`, a RPC NUNCA era executada — e por
//      isso whatsapp_cadencia_bloqueios ficou com zero linhas desde 20/08/2026;
//   3. a tela só tinha "Edge Function returned a non-2xx status code" para
//      mostrar, porque um 500 do runtime não traz corpo `{ erro }`.
//
// A RPC entra aqui como THUNK (`() => rpc(...)`), não como valor já encadeado.
// É o que mantém a decisão de "como aguardar" dentro do código testado, em vez
// de espalhada pelo handler.

// Códigos que a cadência devolve em `DETAIL`. A lista é fechada de propósito:
// só registra o que se reconhece, para o log não virar depósito de qualquer
// mensagem de erro que passe por aqui.
//
// INTERVALO_MINIMO está FORA da lista de propósito: ele é o "espere N segundos"
// e acontece a toda hora no uso normal. Registrar cada um encheria a trilha de
// ruído, e ele já volta ao operador como 403 legível.
export const MOTIVOS_DE_BLOQUEIO = new Set([
  "MODO_PAUSADO",
  "MODO_SOMENTE_RESPOSTAS",
  "FORA_DA_JANELA",
  "LIMITE_OPERADOR",
  "LIMITE_CANAL",
]);

// `details` carrega o código de máquina; `message` continua sendo o texto que o
// operador lê. Devolve null quando não há o que registrar — e null NÃO é falha:
// é o caminho normal de INTERVALO_MINIMO e de qualquer trava de acesso.
export function motivoRegistravel(
  erroPreparo: { details?: string | null } | null | undefined,
): string | null {
  const motivo = erroPreparo?.details;
  return motivo && MOTIVOS_DE_BLOQUEIO.has(motivo) ? motivo : null;
}

export type ResultadoRegistro =
  | { registrado: true }
  | { registrado: false; porque: string };

// NUNCA levanta. Falhar o registro não pode transformar um bloqueio em erro
// diferente para o operador: o que importa é que a mensagem não saiu.
//
// Trata as DUAS formas de falha, que são diferentes:
//   - erro de banco/permissão, que o PostgREST DEVOLVE em `{ data, error }` sem
//     lançar nada (era o buraco: um `catch` sozinho não vê isso);
//   - exceção de verdade (rede, abort, contrato quebrado como o `.catch`).
export async function registrarBloqueio(
  chamarRpc: () => PromiseLike<unknown> | unknown,
): Promise<ResultadoRegistro> {
  try {
    const resposta = (await chamarRpc()) as
      | { error?: { message?: string | null } | null }
      | null
      | undefined;
    const erro = resposta?.error;
    if (erro) return { registrado: false, porque: erro.message || "erro sem mensagem" };
    return { registrado: true };
  } catch (erro) {
    return { registrado: false, porque: String((erro as Error)?.message || erro) };
  }
}
