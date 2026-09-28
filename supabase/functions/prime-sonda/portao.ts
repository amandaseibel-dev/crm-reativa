// Portao de acesso da `prime-sonda`, isolado do Deno de proposito.
//
// POR QUE ESTE ARQUIVO EXISTE. A decisao de quem entra e a unica parte desta
// funcao que nao pode estar errada -- ela guarda a chave que da acesso a CPF e
// dados financeiros de ~400 mil pessoas. Decisao assim precisa de teste, e
// `index.ts` nao e testavel pelo vitest: tem `Deno.serve`, `Deno.env` e import
// remoto do supabase-js.
//
// Entao a decisao mora aqui, em funcoes puras, sem nenhum global de runtime: o
// segredo da rotina entra como PARAMETRO (lido de `Deno.env` em index.ts) e o
// verificador de sessao entra como FUNCAO. O teste passa valores e dubles;
// producao passa o ambiente e a RPC. O codigo exercitado e o mesmo.
//
// -----------------------------------------------------------------------------
// AUTENTICACAO DO GATEWAY VEM ANTES DE TUDO ISTO
// -----------------------------------------------------------------------------
// A funcao esta implantada com `verify_jwt = true` (registrado explicitamente
// em supabase/config.toml). Isso significa que o gateway do Supabase exige um
// JWT valido no header `Authorization` ANTES de executar uma linha sequer deste
// arquivo.
//
// A consequencia pratica precisa estar escrita, porque nao e obvia: NAO BASTA
// mandar `x-rotina-token`. Uma chamada que traga so o token de rotina, sem
// `Authorization`, e recusada pelo gateway com 401 e nunca chega aqui. Quem
// chamar pela porta da rotina tem de apresentar TAMBEM um JWT aceito pelo
// gateway (a anon key serve) -- o token de rotina e uma segunda tranca, nunca
// a unica.
//
// Os testes deste arquivo exercitam o portao da aplicacao. Eles NAO exercitam o
// gateway: isso e camada de infraestrutura, verificada na configuracao
// implantada, nao em teste unitario.

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

// Comparacao que nao entrega o segredo pelo tempo de resposta. `!==` sai no
// primeiro caractere diferente, e a diferenca de tempo entre "errou o 1o
// caractere" e "errou o ultimo" e mensuravel. Aqui o laco percorre o tamanho
// inteiro sempre, acumulando as diferencas em OR.
function comparaSemVazarTempo(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

// TOKEN DA ROTINA -- validado pelo SEGREDO DE AMBIENTE, como sempre foi.
//
// Decisao da gestao em 28/09/2026: esta entrega NAO troca a validacao por
// ambiente pela do Vault. A troca mudaria, numa mesma alteracao, quem valida E
// contra o que se valida -- e o token de ambiente e o que esta em uso hoje.
//
// O QUE MUDA E SO O CASO DO SEGREDO AUSENTE. O portao antigo era:
//     if (esperado && recebido !== esperado) { 401 }
// Repare no `esperado &&`: com o segredo ausente do ambiente, `esperado` e
// string vazia, a condicao inteira e falsa, e a funcao seguia adiante sem
// exigir token nenhum. Agora segredo ausente RECUSA.
export function tokenDaRotinaConfere(recebido: string, esperado: string): boolean {
  if (!esperado) return false; // segredo ausente FECHA a porta, nunca abre
  if (!recebido) return false;
  return comparaSemVazarTempo(recebido, esperado);
}

export type Decisao =
  | { ok: true; via: "rotina" | "gestao" }
  | { ok: false; status: number; corpo: Record<string, unknown> };

export interface EntradaPortao {
  /** header `x-rotina-token` da chamada */
  tokenRecebido: string;
  /** segredo de ambiente (ROTINA_TOKEN ?? PRIME_CADASTRO_TOKEN); "" se ausente */
  segredoRotina: string;
  /** header `Authorization` -- ja validado pelo gateway antes de chegar aqui */
  autorizacao: string;
  /** true SO se a sessao for de gestao; sessao invalida/erro de RPC -> false */
  validarGestao: (auth: string) => Promise<boolean>;
}

// A ORDEM IMPORTA: rotina primeiro, gestao depois. Quem traz `x-rotina-token`
// esta dizendo qual porta quer usar, e a resposta de erro fica honesta sobre o
// que falhou.
export async function decidirAcesso(e: EntradaPortao): Promise<Decisao> {
  // PORTA 1 -- ROTINA (segredo de ambiente). Lembrando que o gateway ja exigiu
  // um JWT valido para a chamada chegar ate aqui: o token de rotina e a
  // segunda tranca, nao a unica.
  if (e.tokenRecebido) {
    if (tokenDaRotinaConfere(e.tokenRecebido, e.segredoRotina)) {
      return { ok: true, via: "rotina" };
    }
    // Token apresentado e invalido (ou segredo ausente): recusa aqui mesmo.
    // Nao cai para a porta da gestao -- quem mandou token errado nao ganha uma
    // segunda chance silenciosa.
    return { ok: false, status: 401, corpo: { erro: "TOKEN_INVALIDO" } };
  }

  // PORTA 2 -- GESTAO, validada NO SERVIDOR pelo banco.
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
