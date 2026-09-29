// Edge Function: prime-academico
// -----------------------------------------------------------------------------
// CONSULTA A SITUAÇÃO ACADÊMICA de um aluno no Prime e GRAVA a resposta inteira,
// linha por linha. Só lê da API; a única escrita é no nosso registro de consulta.
//
// POR QUE EXISTE. A situação acadêmica vem de `students_search` →
// `items[].status`, e é **por vínculo de curso**, não da pessoa. Sondado em
// 28/09/2026 (6 alunos, 35 vínculos): `registration` repete-se idêntico em todas
// as linhas do mesmo aluno, e os status dessas linhas discordam entre si. Ver
// docs/integracoes/prime-api.md.
//
// O QUE ESTA FUNÇÃO NUNCA FAZ:
//   - não escreve em `alunos`, e não toca `alunos.situacao_academica`;
//   - não escolhe uma linha como "a" situação da pessoa;
//   - não usa `contracts[].status` (status de CONTRATO) como substituto;
//   - não mexe em saldo, cobrança ou classificação da Efetividade.
//
// ACESSO: o gateway exige JWT válido (`verify_jwt = true`, em
// supabase/config.toml) e, além disso, o portão exige token de rotina OU sessão
// de gestão. Nenhuma das duas portas dispensa o gateway -- nem a da rotina.
// O portão é o mesmo módulo testado da `prime-sonda`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decidirAcesso } from "../prime-sonda/portao.ts";
import {
  desfecho, devePedirMaisUma, formatarCpf, lerPagina, paginouAteOFim,
  registrationDoCabecalho, vinculosDaResposta,
} from "./academico.ts";

const BASE = "https://prime-api.ulbra.ai/api";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token",
};

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const autorizacao = req.headers.get("Authorization") ?? "";
  const decisao = await decidirAcesso({
    tokenRecebido: req.headers.get("x-rotina-token") ?? "",
    segredoRotina: Deno.env.get("ROTINA_TOKEN") ?? Deno.env.get("PRIME_CADASTRO_TOKEN") ?? "",
    autorizacao,
    validarGestao: async (auth) => {
      const cliente = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } },
      );
      const { data, error } = await cliente.rpc("usuario_e_gestao");
      return !error && data === true;
    },
  });
  if (!decisao.ok) return json(decisao.corpo, decisao.status);

  const corpo = await req.json().catch(() => ({}));
  const alunoId = String(corpo?.aluno_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(alunoId)) return json({ erro: "ALUNO_ID_INVALIDO" }, 400);

  // Item do piloto, quando a chamada vem do lote. A ficha nao manda -- e por
  // isso o mesmo endpoint serve aos dois sem a tela precisar saber do piloto.
  const pilotoItem = String(corpo?.piloto_item_id ?? "").trim();
  const noPiloto = /^[0-9a-f-]{36}$/i.test(pilotoItem);

  // O CPF vem DO BANCO, não do chamador. Quem manda o CPF na requisição
  // decide de quem é a consulta; quem manda o id do aluno pergunta sobre uma
  // ficha, e o CPF sai de lá. É a diferença entre consultar um aluno e
  // consultar um CPF arbitrário com a chave da Ulbra.
  const { data: aluno, error: erroAluno } = await supa
    .from("alunos").select("id, cpf").eq("id", alunoId).maybeSingle();
  if (erroAluno) return json({ erro: "BANCO_FALHOU", detalhe: erroAluno.message }, 502);
  if (!aluno) return json({ erro: "ALUNO_NAO_ENCONTRADO" }, 404);

  const cpf = formatarCpf(aluno.cpf);
  if (!cpf) return json({ erro: "CPF_INVALIDO_NA_FICHA" }, 422);

  // quem pediu -- só para carimbar o registro
  let email: string | null = null;
  if (autorizacao.startsWith("Bearer ")) {
    const cliente = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: autorizacao } } },
    );
    const { data } = await cliente.auth.getUser();
    email = data?.user?.email ?? null;
  }

  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave) {
    const { data } = await supa.rpc("prime_chave_api");
    chave = typeof data === "string" ? data : "";
  }
  if (!chave) return json({ erro: "CHAVE_INDISPONIVEL" }, 500);

  // ---------------------------------------------------------------------------
  // A CHAMADA, PAGINADA.
  //
  // `take=50` sozinho era um teto silencioso: quem tivesse 51 vínculos perdia o
  // 51º sem nenhum sinal. Numa tela que decide cobrança, perder linha em
  // silêncio é pior do que não mostrar nada.
  //
  // Três desfechos, gravados como estados distintos. Achatar falha de rede em
  // "sem informação" viraria "o aluno não tem vínculo".
  // ---------------------------------------------------------------------------
  const TAKE = 50;
  const TETO = 500; // trava de segurança: nunca girar para sempre

  let httpStatus: number | null = null;
  // PAGINACAO CONTA. Um aluno com 120 vinculos gasta 3 requisicoes, nao 1 --
  // e o teto do piloto e de requisicoes, nao de alunos.
  let requisicoes = 0;
  let falha: string | null = null;
  let paginaIlegivel = false;
  let totalItems: number | null = null;
  // Começa falso: sem nenhuma página lida, não há prova de fim nenhuma.
  let chegouAoFim = false;
  const brutos: Record<string, unknown>[] = [];

  for (let skip = 0; ; skip += TAKE) {
    let pagina;
    try {
      requisicoes += 1;
      const r = await fetch(
        `${BASE}/students?search=${encodeURIComponent(cpf)}&take=${TAKE}&skip=${skip}`,
        { method: "GET", headers: { "X-API-Key": chave } },
      );
      httpStatus = r.status;
      const texto = await r.text();
      if (!r.ok) { falha = `HTTP ${r.status}`; break; }
      let json: unknown = null;
      try { json = JSON.parse(texto); } catch { paginaIlegivel = true; break; }
      pagina = lerPagina(json);
    } catch (e) {
      // rede, DNS, timeout -- nunca vaza a chave: só a classe do erro.
      falha = `falha de rede: ${(e as Error)?.name ?? "erro"}`;
      break;
    }

    // 200 com corpo sem `items` array: não se entendeu a resposta. Não é
    // "acabaram as páginas" -- é falha, e parar como se tivesse acabado
    // gravaria uma lista incompleta como se fosse completa.
    if (pagina.items === null) { paginaIlegivel = true; break; }
    if (pagina.totalItems !== null) totalItems = pagina.totalItems;
    brutos.push(...pagina.items);
    chegouAoFim = paginouAteOFim(brutos.length, pagina.items.length, TAKE, totalItems);
    if (!devePedirMaisUma(brutos.length, pagina.items.length, TAKE, totalItems, TETO)) break;
  }

  // O FILTRO VEM ANTES DO DESFECHO. Uma busca que traga só linhas de OUTRA
  // pessoa (o `search` é substring) tem items > 0 e zero vínculos desta ficha:
  // chamar isso de COM_VINCULOS faria a tela dizer "consultei e encontrei" e
  // mostrar tabela vazia.
  const vinculos = falha || paginaIlegivel ? [] : vinculosDaResposta(brutos, aluno.cpf);
  const resultado = desfecho(falha, paginaIlegivel, vinculos, chegouAoFim);
  const registration = registrationDoCabecalho(vinculos);
  if (paginaIlegivel && !falha) falha = "resposta ilegivel (corpo sem items)";
  // O motivo fica escrito: a tela precisa dizer POR QUE a lista pode estar
  // incompleta, e "bateu no teto" é diferente de "a API caiu".
  if (resultado === "PAGINACAO_INCOMPLETA" && !falha) {
    falha = `paginacao interrompida no teto de ${TETO} linhas -- a lista pode estar incompleta`;
  }

  const { data: consultaId, error: erroGravar } = await supa.rpc("prime_academico_registrar", {
    p_aluno_id: alunoId,
    p_cpf: cpf,
    p_registration: registration,
    p_resultado: resultado,
    p_detalhe_falha: falha,
    p_http_status: httpStatus,
    p_total_items: totalItems,
    p_vinculos: vinculos,
    p_email: email,
    p_requisicoes: requisicoes,
  });
  if (erroGravar) return json({ erro: "GRAVACAO_FALHOU", detalhe: erroGravar.message }, 502);

  // REGISTRO NO PILOTO. Acontece aqui, e nao no navegador, porque a RPC de
  // registro so atende service_role -- e porque so aqui se sabe quantas
  // requisicoes a consulta gastou.
  //
  // 401/403/429 interrompem o LOTE inteiro: e a propria RPC que decide isso, a
  // partir do `p_http` que vai daqui.
  let pararLote = false;
  let motivoLote: string | null = null;
  if (noPiloto) {
    const { data: reg } = await supa.rpc("prime_academico_piloto_registrar", {
      p_item: pilotoItem,
      p_consulta_id: consultaId,
      p_requisicoes: requisicoes,
      p_http: httpStatus,
      p_erro: falha,
    });
    pararLote = (reg as { parar?: boolean } | null)?.parar === true;
    motivoLote = (reg as { motivo?: string } | null)?.motivo ?? null;
  }

  // Devolve o mesmo formato que a tela lê do banco, para ela não precisar de
  // dois caminhos de renderização.
  const { data: leitura } = await supa.rpc("prime_academico_ultima", { p_aluno_id: alunoId });
  return json({
    ok: true, consulta_id: consultaId, resultado, leitura,
    requisicoes,
    ...(noPiloto ? { piloto: { parar: pararLote, motivo: motivoLote } } : {}),
  });
});
