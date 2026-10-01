// Leitura da resposta de `students_search`, isolada do Deno para poder ser
// testada. `index.ts` não é testável pelo vitest (Deno.serve, Deno.env, import
// remoto), e a classificação dos desfechos é justamente a parte que não pode
// estar errada.

const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// O `search` SÓ ENCONTRA CPF FORMATADO. Em dígitos puros a API devolve
// `totalItems: 0` sem nenhum sinal de erro -- falha silenciosa, documentada em
// docs/integracoes/prime-api.md. Mandar sem pontuação produziria "aluno não
// encontrado" para gente que está lá.
export function formatarCpf(bruto: unknown): string | null {
  const d = digitos(bruto);
  if (d.length !== 11) return null;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export type Resultado =
  | "COM_VINCULOS" | "SEM_RESULTADO" | "PAGINACAO_INCOMPLETA" | "FALHA_COMUNICACAO";

export interface Pagina {
  items: Record<string, unknown>[] | null; // null = corpo ilegível
  totalItems: number | null;
}

// Lê UMA página. `items` volta `null` quando o corpo não tem array -- e isso é
// diferente de lista vazia: "não entendi a resposta" não é "não tem nada".
export function lerPagina(dados: unknown): Pagina {
  const d = dados as { items?: unknown; totalItems?: unknown } | null;
  const items = Array.isArray(d?.items) ? (d!.items as Record<string, unknown>[]) : null;
  const totalItems = typeof d?.totalItems === "number" ? (d!.totalItems as number) : null;
  return { items, totalItems };
}

// QUANDO PARAR DE PAGINAR.
//
// A primeira versão desta função pedia `take=50` e ficava com o que viesse. Se
// a pessoa tivesse 51 vínculos, o 51º sumia -- e sumia em silêncio, que é o
// pior jeito de perder dado numa tela que decide cobrança.
//
// Para quando: a página veio vazia (acabou), veio menor que o tamanho pedido
// (era a última), ou já se juntou `totalItems`. Essas três são PROVA de fim.
//
// O teto é outra coisa: é desistir, não terminar. Por isso `paginouAteOFim`
// existe separado -- bater no teto não pode virar "COM_VINCULOS", que afirma
// uma lista completa que ninguém mediu.
export function devePedirMaisUma(
  juntadas: number, ultimaPagina: number, take: number, totalItems: number | null, teto: number,
): boolean {
  if (paginouAteOFim(juntadas, ultimaPagina, take, totalItems)) return false;
  return juntadas < teto;
}

// Houve PROVA de que a lista acabou?
export function paginouAteOFim(
  juntadas: number, ultimaPagina: number, take: number, totalItems: number | null,
): boolean {
  if (ultimaPagina === 0) return true;
  if (ultimaPagina < take) return true;
  if (totalItems !== null && juntadas >= totalItems) return true;
  return false;
}

// Devolve as linhas NA ORDEM, filtrando por CPF exato e removendo os campos
// pessoais que este registro não precisa guardar de novo (nome).
//
// POR QUE FILTRAR POR CPF: o `search` é substring, então pedir um CPF pode
// trazer linhas de OUTRA pessoa cujo CPF contenha o trecho. Guardar essas linhas
// colaria o vínculo de um terceiro na ficha.
//
// A MATRÍCULA FICA EM CADA LINHA. Na amostra de 28/09/2026 ela se repetiu
// idêntica dentro de cada aluno, mas seis alunos não autorizam tratar isso como
// regra -- e se um dia vierem matrículas diferentes na mesma resposta, guardar
// uma só no cabeçalho perderia a informação de qual vínculo é de qual.
//
// A ORDEM É PRESERVADA e vira a coluna `ordem` no banco: é o único
// discriminador de vínculos com curso, campus e turno idênticos -- e eles
// existem, medidos e registrados em
// docs/integracoes/prime-mapa-identificadores.md.
export function vinculosDaResposta(itens: Record<string, unknown>[], cpfDaFicha: unknown) {
  const alvo = digitos(cpfDaFicha);
  return itens
    .filter((i) => !alvo || digitos(i?.cpf) === alvo)
    .map((i) => ({
      registration: i?.registration == null ? null : String(i.registration),
      course: i?.course ?? null,
      campus: i?.campus ?? null,
      shift: i?.shift ?? null,
      status: i?.status ?? null,
      admissionYear: i?.admissionYear ?? null,
      graduated: i?.graduated ?? null,
    }));
}

// O DESFECHO É CALCULADO DEPOIS DO FILTRO POR CPF, e a ordem importa.
//
// A versão anterior olhava `items.length` antes de filtrar: uma busca que
// trouxesse só linhas de OUTRA pessoa (o `search` é substring) virava
// "COM_VINCULOS" com zero vínculos gravados -- a tela diria que consultou e
// encontrou, e mostraria uma tabela vazia.
//
//   FALHA_COMUNICACAO  não se sabe nada (4xx/5xx/timeout/corpo ilegível)
//   SEM_RESULTADO      respondeu, e não há linha DESTA pessoa
//   COM_VINCULOS       respondeu, e há pelo menos uma linha desta pessoa
export function desfecho(
  falha: string | null,
  paginaIlegivel: boolean,
  vinculos: unknown[],
  chegouAoFim = true,
): Resultado {
  if (falha || paginaIlegivel) return "FALHA_COMUNICACAO";
  if (vinculos.length === 0) return "SEM_RESULTADO";
  // Sem prova de fim, o que se tem é uma lista PARCIAL. Dizer COM_VINCULOS
  // aqui seria afirmar um total que não foi medido.
  return chegouAoFim ? "COM_VINCULOS" : "PAGINACAO_INCOMPLETA";
}

// Matrícula do CABEÇALHO: só quando todas as linhas concordam. Divergindo, fica
// nula -- a informação por linha é que manda, e escolher uma aqui daria a
// impressão de que a pessoa "tem" aquela matrícula.
export function registrationDoCabecalho(vinculos: { registration: string | null }[]): string | null {
  const regs = [...new Set(vinculos.map((v) => v.registration).filter(Boolean))];
  return regs.length === 1 ? (regs[0] as string) : null;
}
