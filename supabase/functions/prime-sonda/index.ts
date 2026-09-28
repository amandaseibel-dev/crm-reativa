// Edge Function: prime-sonda
// -----------------------------------------------------------------------------
// SONDA DE ROTA. Consulta uma rota de LEITURA ja catalogada da API do Prime e
// devolve a FORMA do que chega -- nomes de campo, tipos e um exemplo curto por
// campo. A lista de rotas permitidas esta em ./portao.ts; ate 28/09/2026 o
// caminho era arbitrario, e passou a ser fechado nesta alteracao.
//
// Existe porque a conclusao "o Prime nao tem a composicao do acordo" foi tirada
// de UM endpoint (/students/{matricula}), e isso nao prova nada sobre a API
// inteira. Amanda, 01/09: "voce nao esta indo a fundo no prime".
//
// SO LE. Nao grava nada, e por padrao NAO devolve dado pessoal -- devolve a
// estrutura. `cru:true` devolve o conteudo, e existe para conferir um caso
// concreto quando a estrutura ja e conhecida.
//
// A chave da Ulbra da acesso a CPF e dados financeiros de ~400 mil pessoas:
// vive so no Vault, nunca no navegador, nunca no repositorio. O acesso a esta
// funcao exige o token de rotina OU uma sessao de gestao (ver portao abaixo).
//
// VERSIONADA em 2026-09-22 a partir de produção (versão 4) -- existia só em
// produção até esta data. É o instrumento recomendado para qualquer sondagem
// futura de endpoint novo -- ver docs/integracoes/prime-api.md, seção "Como
// confirmar um endpoint novo, com segurança".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { caminhoPermitido, decidirAcesso, PERMITIDOS_LEGIVEL } from "./portao.ts";

const BASE = "https://prime-api.ulbra.ai/api";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token",
};

function forma(v: unknown, prof = 0): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    return { _lista: v.length, _item: v.length ? forma(v[0], prof + 1) : null };
  }
  if (typeof v === "object") {
    if (prof > 4) return "{...}";
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = forma(val, prof + 1);
    return o;
  }
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // PORTAO DE ACESSO -- duas portas, as mesmas duas que `prime-cadastro` ja
  // usa. Nada aqui afrouxa o que existia: a porta da rotina continua igual, e a
  // porta nova exige sessao de gestao validada NO SERVIDOR, pelo banco.
  //
  // POR QUE PRECISOU MUDAR. A sonda e o instrumento oficial para confirmar um
  // endpoint novo (README de docs/integracoes). So que ela aceitava unicamente
  // o token da rotina -- e o token vive no Vault. Na pratica, toda sondagem
  // exigia alguem tirando segredo do Vault e colando numa tela ou num chat,
  // que e exatamente o que o desenho tenta evitar.
  //
  // E FECHA UM FALHA-ABERTO. O portao antigo era:
  //     if (esperado && recebido !== esperado) { 401 }
  // Repare no `esperado &&`. Com o secret AUSENTE do ambiente, `esperado` e
  // string vazia, a condicao inteira e falsa, e a funcao seguia adiante sem
  // exigir token nenhum. Em producao o estrago era contido pelo
  // `verify_jwt: true` do gateway (confirmado na versao 4 implantada), que
  // barra quem nao tem sessao -- mas QUALQUER usuario logado, operador comum
  // inclusive, atravessava e ficava com a chave da Ulbra trabalhando para ele.
  // Agora a ausencia do secret FECHA a porta da rotina, em vez de abrir todas.
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // A decisao vive em ./portao.ts, testada em portao.test.js. Aqui so entram as
  // duas verificacoes REAIS -- ambas resolvidas pelo banco, nunca por
  // comparacao local de string.
  const decisao = await decidirAcesso({
    tokenRecebido: req.headers.get("x-rotina-token") ?? "",
    autorizacao: req.headers.get("Authorization") ?? "",
    // Mesma RPC que `prime-cadastro` usa: a comparacao acontece dentro do
    // banco, com digest (nao vaza o segredo pelo tempo de resposta), e o
    // segredo continua vivendo num lugar so -- o Vault. Erro na RPC devolve
    // false: falha de verificacao nunca vira autorizacao.
    validarToken: async (t) => {
      const { data, error } = await supa.rpc("prime_cadastro_token_valido", { p_token: t });
      return !error && data === true;
    },
    // Quem decide e o banco, pela mesma funcao que as politicas de RLS usam.
    // Sessao invalida ou expirada faz a RPC devolver erro -> false -> 403.
    validarGestao: async (auth) => {
      const supaChamador = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } },
      );
      const { data, error } = await supaChamador.rpc("usuario_e_gestao");
      return !error && data === true;
    },
  });

  if (!decisao.ok) {
    return new Response(JSON.stringify(decisao.corpo),
      { status: decisao.status, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // O CAMINHO E CONFERIDO ANTES DA CHAVE. Pedido fora da lista e recusado sem
  // que a chave da Ulbra chegue a sair do Vault -- nao ha motivo para buscar
  // credencial para uma chamada que nunca vai acontecer.
  const corpo = await req.json().catch(() => ({}));
  const caminho = String(corpo?.caminho ?? "").trim();
  const cru = corpo?.cru === true;
  if (!caminho.startsWith("/")) {
    return new Response(JSON.stringify({ erro: "informe o caminho, comecando com /" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!caminhoPermitido(caminho)) {
    return new Response(JSON.stringify({
      erro: "CAMINHO_NAO_PERMITIDO",
      detalhe: "a sonda so consulta rotas de leitura ja catalogadas",
      permitidos: PERMITIDOS_LEGIVEL,
    }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // a chave sai do Vault pela RPC, que so atende service_role. Ela NUNCA entra
  // na resposta nem em log -- so viaja no header da chamada a Ulbra, abaixo.
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave && url && srv) {
    const r = await fetch(url + "/rest/v1/rpc/prime_chave_api", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: srv, Authorization: "Bearer " + srv },
      body: "{}",
    });
    if (r.ok) chave = (await r.json()) as string;
  }
  if (!chave) {
    return new Response(JSON.stringify({ erro: "chave do Prime indisponivel" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // GET explicito: a sonda so le. Nunca houve outro metodo aqui, e deixar o
  // verbo escrito impede que alguem "so acrescente" um POST sem perceber.
  const r = await fetch(BASE + caminho, { method: "GET", headers: { "X-API-Key": chave } });
  const texto = await r.text();
  let dados: unknown = null;
  try { dados = JSON.parse(texto); } catch { /* nem sempre e JSON */ }

  return new Response(JSON.stringify({
    caminho,
    status: r.status,
    tipo: r.headers.get("content-type"),
    tamanho: texto.length,
    forma: dados === null ? texto.slice(0, 500) : forma(dados),
    ...(cru ? { cru: dados ?? texto.slice(0, 4000) } : {}),
  }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
});
