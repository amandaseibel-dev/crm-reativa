// Portao de acesso da `prime-sonda`, isolado do Deno de proposito.
//
// POR QUE ESTE ARQUIVO EXISTE. A decisao de quem entra e a unica parte desta
// funcao que nao pode estar errada -- ela guarda a chave que da acesso a CPF e
// dados financeiros de ~400 mil pessoas. Decisao assim precisa de teste, e
// `index.ts` nao e testavel pelo vitest: tem `Deno.serve`, `Deno.env` e import
// remoto do supabase-js.
//
// Entao a decisao mora aqui, em funcoes puras, sem nenhum global de runtime:
// quem verifica token e quem verifica sessao entram como PARAMETRO. O
// `index.ts` passa as implementacoes reais (as RPCs do banco); o teste passa
// dubles. Assim o que o teste exercita e exatamente o codigo que roda em
// producao, e nao uma reimplementacao parecida.

// CAMINHOS PERMITIDOS. A sonda existe para confirmar a FORMA de rotas de
// leitura ja catalogadas -- nao para ser um proxy livre da API da Ulbra. Sem
// esta lista, `caminho` era qualquer string comecando com "/", e quem tivesse
// acesso a funcao alcancava toda a superficie da API, inclusive rotas de
// escrita que ninguem mapeou.
//
// Cada entrada corresponde a um endpoint de LEITURA de
// docs/integracoes/prime-api-catalog.json. Acrescentar rota aqui e decisao
// consciente que passa por revisao -- e por isso a lista mora no codigo
// versionado, nunca num parametro da chamada.
export const CAMINHOS_PERMITIDOS: RegExp[] = [
  /^\/carriers(\?.*)?$/,
  /^\/students\?[^/]*$/,
  /^\/students\/[A-Za-z0-9._-]+$/,
  /^\/students\/[A-Za-z0-9._-]+\/contracts(\?.*)?$/,
  /^\/students\/[A-Za-z0-9._-]+\/financial-statement(\?.*)?$/,
  /^\/students\/[A-Za-z0-9._-]+\/agreements(\?.*)?$/,
];

export const PERMITIDOS_LEGIVEL = [
  "/carriers",
  "/students?search=...",
  "/students/{registration}",
  "/students/{registration}/contracts",
  "/students/{registration}/financial-statement",
  "/students/{registration}/agreements",
];

export function caminhoPermitido(caminho: string): boolean {
  if (typeof caminho !== "string" || !caminho.startsWith("/")) return false;
  // Barra dupla e ".." sairiam do caminho pretendido mesmo casando com um
  // padrao: recusa antes de olhar a lista.
  if (caminho.includes("..") || caminho.includes("//")) return false;
  return CAMINHOS_PERMITIDOS.some((re) => re.test(caminho));
}

export type Decisao =
  | { ok: true; via: "rotina" | "gestao" }
  | { ok: false; status: number; corpo: Record<string, unknown> };

export interface EntradaPortao {
  tokenRecebido: string;
  autorizacao: string;
  /** devolve true SO se o token conferir no banco; qualquer erro -> false */
  validarToken: (t: string) => Promise<boolean>;
  /** devolve true SO se a sessao for de gestao; sessao invalida/erro -> false */
  validarGestao: (auth: string) => Promise<boolean>;
}

// A ORDEM IMPORTA: rotina primeiro, gestao depois. A rotina roda sem sessao
// nenhuma (e um cron), entao exigir Authorization dela quebraria a automacao.
export async function decidirAcesso(e: EntradaPortao): Promise<Decisao> {
  // PORTA 1 -- ROTINA. Note que NAO existe mais o `esperado &&` do portao
  // antigo: ali, com o secret ausente do ambiente, a condicao inteira virava
  // falsa e a funcao seguia adiante sem exigir token nenhum. Aqui a ausencia
  // do secret faz `validarToken` devolver false, e false FECHA a porta da
  // rotina em vez de abrir todas. Falha de verificacao nunca vira autorizacao.
  if (e.tokenRecebido) {
    if (await e.validarToken(e.tokenRecebido)) return { ok: true, via: "rotina" };
    // Token apresentado e invalido: recusa aqui mesmo. Nao cai para a porta da
    // gestao -- quem mandou token errado nao deve ganhar uma segunda chance
    // silenciosa, e a mensagem fica honesta sobre o que falhou.
    return { ok: false, status: 401, corpo: { erro: "TOKEN_INVALIDO" } };
  }

  // PORTA 2 -- GESTAO, validada no servidor pelo banco.
  if (!e.autorizacao.startsWith("Bearer ")) {
    return { ok: false, status: 401, corpo: { erro: "SEM_TOKEN" } };
  }
  if (!(await e.validarGestao(e.autorizacao))) {
    return {
      ok: false,
      status: 403,
      corpo: { erro: "ACESSO_NEGADO", detalhe: "restrito a gestao" },
    };
  }
  return { ok: true, via: "gestao" };
}
