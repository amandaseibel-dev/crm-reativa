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
import { formatarCpf, resultadoDaResposta, vinculosDaResposta } from "./academico.ts";

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
  // A CHAMADA. Três desfechos, e os três são gravados como estados distintos.
  // Achatar falha de rede em "sem informação" é exatamente o que não pode
  // acontecer: viraria "o aluno não tem vínculo".
  // ---------------------------------------------------------------------------
  let httpStatus: number | null = null;
  let dados: unknown = null;
  let falha: string | null = null;
  try {
    const r = await fetch(
      `${BASE}/students?search=${encodeURIComponent(cpf)}&take=50`,
      { method: "GET", headers: { "X-API-Key": chave } },
    );
    httpStatus = r.status;
    const texto = await r.text();
    if (!r.ok) {
      falha = `HTTP ${r.status}`;
    } else {
      try { dados = JSON.parse(texto); } catch { falha = "resposta ilegivel (JSON invalido)"; }
    }
  } catch (e) {
    // rede, DNS, timeout -- nunca vaza a chave: só a classe do erro.
    falha = `falha de rede: ${(e as Error)?.name ?? "erro"}`;
  }

  const { resultado, totalItems, registration } = resultadoDaResposta(dados, falha);
  const vinculos = vinculosDaResposta(dados, aluno.cpf);

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
  });
  if (erroGravar) return json({ erro: "GRAVACAO_FALHOU", detalhe: erroGravar.message }, 502);

  // Devolve o mesmo formato que a tela lê do banco, para ela não precisar de
  // dois caminhos de renderização.
  const { data: leitura } = await supa.rpc("prime_academico_ultima", { p_aluno_id: alunoId });
  return json({ ok: true, consulta_id: consultaId, resultado, leitura });
});
