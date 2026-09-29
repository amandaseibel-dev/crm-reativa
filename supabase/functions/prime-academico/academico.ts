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
//   FALHA_COMUNICACAO    não se sabe nada (4xx/5xx/timeout/corpo ilegível)
//   PAGINACAO_INCOMPLETA a busca não terminou (teto, ou autorização negada)
//   SEM_RESULTADO        a busca TERMINOU, e não há linha DESTA pessoa
//   COM_VINCULOS         a busca terminou, e há pelo menos uma linha dela
//
// A ORDEM DAS PERGUNTAS É O CUIDADO PRINCIPAL, e já esteve errada aqui.
// Perguntar "a lista está vazia?" antes de "a busca terminou?" transformava
// toda interrupção sem vínculos em SEM_RESULTADO -- inclusive a autorização
// negada na PRIMEIRA página, que não chega a consultar a Ulbra. O registro
// dizia "consultei e este aluno não tem vínculo" sobre uma consulta que nunca
// aconteceu, e, por ser um desfecho completo, ainda substituía a última
// consulta boa da ficha. Lista vazia só é resposta depois que a busca acabou.
export function desfecho(
  falha: string | null,
  paginaIlegivel: boolean,
  vinculos: unknown[],
  chegouAoFim = true,
): Resultado {
  if (falha || paginaIlegivel) return "FALHA_COMUNICACAO";
  // Sem prova de fim, o que se tem é um PEDAÇO -- tenha ele linhas ou não.
  if (!chegouAoFim) return "PAGINACAO_INCOMPLETA";
  if (vinculos.length === 0) return "SEM_RESULTADO";
  return "COM_VINCULOS";
}

// Matrícula do CABEÇALHO: só quando todas as linhas concordam. Divergindo, fica
// nula -- a informação por linha é que manda, e escolher uma aqui daria a
// impressão de que a pessoa "tem" aquela matrícula.
export function registrationDoCabecalho(vinculos: { registration: string | null }[]): string | null {
  const regs = [...new Set(vinculos.map((v) => v.registration).filter(Boolean))];
  return regs.length === 1 ? (regs[0] as string) : null;
}

// ---------------------------------------------------------------------------
// O LAÇO DE PAGINAÇÃO, isolado para poder ser testado
// ---------------------------------------------------------------------------
// `index.ts` não é testável pelo vitest (Deno.serve, Deno.env, import remoto),
// e este laço é onde mora a decisão mais cara: quando parar, e se o que se tem
// é lista completa ou pedaço.
//
// AUTORIZAR VEM ANTES DE BUSCAR, sempre. A autorização é o débito da página no
// banco; negada, a chamada ao Prime não acontece. Foi assim que se fechou o
// buraco de uma paginação longa passar por cima do teto do lote.
export interface ResultadoPaginacao {
  brutos: Record<string, unknown>[];
  requisicoes: number;
  httpStatus: number | null;
  falha: string | null;
  paginaIlegivel: boolean;
  chegouAoFim: boolean;
  /** por que a autorização negou, quando negou */
  negou: string | null;
  /** `totalItems` da última página que o trouxe; null se a API nunca mandou */
  totalItems: number | null;
}

export async function paginarComAutorizacao(opts: {
  take: number;
  teto: number;
  /** null quando não há piloto: sem lote, ninguém autoriza nada */
  autorizar: (() => Promise<{ ok: boolean; motivo?: string }>) | null;
  buscar: (skip: number) => Promise<
    { http: number; ok: boolean; texto: string } | { erro: string }>;
}): Promise<ResultadoPaginacao> {
  const r: ResultadoPaginacao = {
    brutos: [], requisicoes: 0, httpStatus: null,
    falha: null, paginaIlegivel: false, chegouAoFim: false, negou: null,
    totalItems: null,
  };

  for (let skip = 0; ; skip += opts.take) {
    if (opts.autorizar) {
      const a = await opts.autorizar();
      if (!a.ok) { r.negou = a.motivo ?? "negado"; break; }
    }
    // Conta ANTES de buscar: a requisição foi autorizada e debitada, e vai
    // sair. Contar depois perderia a chamada se a rede morresse no meio.
    r.requisicoes += 1;

    const resp = await opts.buscar(skip);
    if ("erro" in resp) { r.falha = resp.erro; break; }
    r.httpStatus = resp.http;
    if (!resp.ok) { r.falha = `HTTP ${resp.http}`; break; }

    let dados: unknown = null;
    try { dados = JSON.parse(resp.texto); } catch { r.paginaIlegivel = true; break; }
    const pagina = lerPagina(dados);
    if (pagina.items === null) { r.paginaIlegivel = true; break; }
    if (pagina.totalItems !== null) r.totalItems = pagina.totalItems;

    r.brutos.push(...pagina.items);
    r.chegouAoFim = paginouAteOFim(r.brutos.length, pagina.items.length, opts.take, r.totalItems);
    if (!devePedirMaisUma(r.brutos.length, pagina.items.length, opts.take, r.totalItems, opts.teto)) break;
  }
  return r;
}
