// Edge Function: santander-importar
// -----------------------------------------------------------------------------
// ENTREGA B do caminho Santander -> CRM. É a SEGUNDA fase: recebe o mesmo
// arquivo que a gestão acabou de conferir em `santander-previa`, relê no
// servidor, confere a IMPRESSÃO DIGITAL do conteúdo normalizado e só então
// chama a RPC de importação que já existe.
//
// POR QUE SÃO DUAS FUNÇÕES, e não um modo da `santander-previa`. Esta grava
// dinheiro; aquela não grava nada e tem teste provando isso. Separadas, a
// prévia conserva a garantia (e o nome honesto), e esta é um deploy próprio --
// um interruptor próprio: apagar `santander-importar` desliga a escrita pelo
// servidor e a conferência pela tela continua funcionando. O parser é um só,
// importado da pasta vizinha; o precedente dessa forma no projeto é o
// `prime-academico`, que importa `../prime-sonda/portao.ts` e está ATIVO em
// produção.
//
// O QUE A DIGITAL RESOLVE. Entre conferir e confirmar, o arquivo pode ter sido
// trocado -- outra remessa, outro dia, ou o seletor apontando para o lugar
// errado. Sem a digital, a confirmação importaria o arquivo NOVO com a
// conferência do ANTIGO. Aqui a digital é recalculada A PARTIR DOS BYTES
// RECEBIDOS e comparada com a que veio da prévia: se não bate, nada é gravado.
//
// AS LINHAS NUNCA VÊM DO CLIENTE -- é o ponto central desta entrega.
// Hoje a tela lê o `.xls` no navegador e manda `p_linhas` pronto para a RPC:
// quem chama escolhe o que é gravado, e a planilha é só a origem alegada. Aqui
// as linhas são SEMPRE o resultado do parse do servidor. Esta função não lê
// nenhum campo de linhas da requisição, e há teste que confere isso no texto
// deste arquivo.
//
// AUTORIA E PERMISSÃO: JWT DE QUEM CONFIRMOU, nunca `service_role`.
// A RPC começa com
//     v_email := lower(auth.email());
//     IF v_email NOT IN (<allowlist de 3 e-mails>) THEN RAISE EXCEPTION ...
// ATENÇÃO ao que esse portão NÃO faz: sem claim de e-mail no token, `auth.email()`
// é NULL, `NULL NOT IN (...)` avalia para NULL -- que não é TRUE --, o IF não
// dispara e a função IMPORTA, gravando autoria nula. Medido em 22/10/2026; ver
// supabase/tests/santander_importar_idempotencia.test.js.
// Ou seja: chave de serviço NÃO é barrada pela allowlist. É exatamente por isso
// que esta função repassa o Authorization da pessoa e não usa `service_role` --
// não porque o banco obrigue, mas porque o banco NÃO obriga. Com o JWT da
// pessoa, a allowlist, a RLS e a autoria no `auditoria` valem sobre quem de fato
// confirmou.
// Consequência: o token de rotina NÃO serve aqui -- rotina não tem pessoa, e
// gravar dinheiro sem pessoa responsável não é algo que esta função faça. Quem
// quiser entrada automática precisa de identidade própria e decisão própria
// (Entrega C), não de um atalho nesta porta.
//
// NÃO ALTERA REGRA FINANCEIRA. Não decide vínculo, conciliação, baixa nem
// projeção: entrega as linhas à mesma RPC que a tela chama hoje, com os mesmos
// sete argumentos. Quem concilia continua sendo o motor, pelos gatilhos de
// `pagamentos`. A automação horária da PR #722 não é tocada.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import {
  LIMITE_BYTES,
  LIMITE_LINHAS,
  digitalConfere,
  impressaoDigital,
  normalizarPlanilha,
  validarArquivo,
} from "../santander-previa/planilha.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-arquivo-nome",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// `YYYY-MM`, do jeito que a tela e a RPC usam. Validado aqui porque o valor
// entra em `importacoes.mes_referencia` e decide a trava de duplicidade.
const MES = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

function clienteDaPessoa(autorizacao: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: autorizacao } } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "METODO_NAO_PERMITIDO" }, 405);

  // ---------------------------------------------------------------------------
  // PORTÃO. Só pessoa de gestão com JWT. Token de rotina é recusado de forma
  // explícita, para o erro dizer a verdade em vez de deixar a RPC falhar
  // depois com "sem permissão" e parecer outra coisa.
  // ---------------------------------------------------------------------------
  if (req.headers.get("x-rotina-token")) {
    return json({
      erro: "ROTINA_NAO_IMPORTA",
      detalhe: "importacao exige pessoa responsavel; token de rotina nao serve",
    }, 403);
  }

  const autorizacao = req.headers.get("Authorization") ?? "";
  if (!autorizacao.startsWith("Bearer ")) return json({ erro: "SEM_TOKEN" }, 401);

  const cliente = clienteDaPessoa(autorizacao);

  const { data: ehGestao, error: erroGestao } = await cliente.rpc("usuario_e_gestao");
  if (erroGestao || ehGestao !== true) {
    return json({ erro: "ACESSO_NEGADO", detalhe: "restrito a gestao" }, 403);
  }

  // O e-mail vem do token validado, NUNCA do corpo da requisição: é ele que vai
  // para `importacoes.usuario`, e autoria declarada pelo chamador não é autoria.
  const { data: dadosUsuario } = await cliente.auth.getUser();
  const emailDaPessoa = dadosUsuario?.user?.email ?? "";
  if (!emailDaPessoa) return json({ erro: "SESSAO_SEM_EMAIL" }, 403);

  // ---------------------------------------------------------------------------
  // ENTRADA. Multipart, porque vem arquivo junto com os parâmetros que a tela
  // decide (competência, retroativo, substituição). Nenhum deles é linha.
  // ---------------------------------------------------------------------------
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > LIMITE_BYTES * 2) {
    return json({ erro: "ARQUIVO_GRANDE", detalhe: `${declarado} bytes` }, 413);
  }

  let bytes: Uint8Array | null = null;
  let nome = req.headers.get("x-arquivo-nome") ?? "";
  let digitalRecebida = "";
  let mesReferencia = "";
  let retroativo = false;
  let substituirId: string | null = null;
  let motivo: string | null = null;

  try {
    const form = await req.formData();
    const campo = form.get("arquivo");
    if (campo instanceof File) {
      nome = nome || campo.name || "";
      bytes = new Uint8Array(await campo.arrayBuffer());
    }
    digitalRecebida = String(form.get("digital") ?? "");
    mesReferencia = String(form.get("mes_referencia") ?? "");
    retroativo = String(form.get("retroativo") ?? "") === "true";
    const sub = String(form.get("substituir_importacao_id") ?? "");
    substituirId = sub && sub !== "null" ? sub : null;
    const mot = String(form.get("motivo_substituicao") ?? "");
    motivo = mot && mot !== "null" ? mot : null;
  } catch {
    return json({ erro: "CORPO_ILEGIVEL", detalhe: "esperado multipart/form-data" }, 400);
  }

  if (!digitalRecebida) {
    return json({
      erro: "DIGITAL_AUSENTE",
      detalhe: "confirme a partir de uma previa; sem digital nada e importado",
    }, 400);
  }
  if (!MES.test(mesReferencia)) {
    return json({ erro: "MES_INVALIDO", detalhe: "esperado YYYY-MM" }, 400);
  }

  const veredito = validarArquivo(bytes, nome);
  if (!veredito.ok) {
    return json(veredito, veredito.erro === "ARQUIVO_GRANDE" ? 413 : 400);
  }

  // ---------------------------------------------------------------------------
  // LEITURA. Idêntica à da prévia -- mesmas opções, mesmo parser, mesma origem.
  // ---------------------------------------------------------------------------
  let linhasBrutas: unknown[][];
  try {
    const workbook = XLSX.read(bytes!, { type: "array", cellDates: true });
    const primeiraAba = workbook.SheetNames[0];
    if (!primeiraAba) return json({ erro: "PLANILHA_SEM_ABA" }, 400);
    linhasBrutas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], {
      header: 1,
      defval: "",
      raw: true,
    }) as unknown[][];
  } catch (e) {
    return json({ erro: "PLANILHA_ILEGIVEL", detalhe: String((e as Error)?.message ?? e).slice(0, 200) }, 400);
  }

  if (linhasBrutas.length > LIMITE_LINHAS) {
    return json({ erro: "PLANILHA_LONGA", detalhe: `${linhasBrutas.length} linhas` }, 413);
  }

  const linhas = normalizarPlanilha(linhasBrutas);
  if (linhas.length === 0) return json({ erro: "PLANILHA_SEM_PAGAMENTO" }, 400);

  // ---------------------------------------------------------------------------
  // A CONFERÊNCIA. Recalculada dos bytes recebidos; divergir é motivo para não
  // gravar nada. A digital calculada volta na resposta de propósito: ela é hash
  // de um conteúdo que o chamador já tem, e devolvê-la é o que permite à tela
  // explicar "o arquivo mudou" em vez de só dizer que falhou.
  // ---------------------------------------------------------------------------
  const digitalCalculada = await impressaoDigital(linhas);
  if (!digitalConfere(digitalRecebida, digitalCalculada)) {
    return json({
      erro: "DIGITAL_DIVERGENTE",
      detalhe: "o arquivo nao e o mesmo que foi conferido na previa; nada foi importado",
      gravou: false,
      digital_recebida: digitalRecebida,
      digital_calculada: digitalCalculada,
    }, 409);
  }

  // ---------------------------------------------------------------------------
  // A ESCRITA. Mesma RPC, mesmos sete argumentos, JWT da pessoa. `p_linhas` é o
  // parse DESTE servidor -- não há caminho para o cliente escolher as linhas.
  // ---------------------------------------------------------------------------
  const { data, error } = await cliente.rpc("projecao_importar_pagamentos", {
    p_arquivo_nome: nome,
    p_usuario: emailDaPessoa,
    p_linhas: linhas,
    p_mes_referencia: mesReferencia,
    p_retroativo: retroativo,
    p_substituir_importacao_id: substituirId,
    p_motivo_substituicao: motivo,
  });

  if (error) {
    // A RPC sinaliza duplicidade com `IMPORTACAO_DUPLICADA:<uuid>`. Devolvido
    // separado para a tela poder oferecer substituição, que é o caminho que a
    // gestão já conhece, em vez de mostrar uma mensagem crua de banco.
    const marca = /IMPORTACAO_DUPLICADA:([0-9a-f-]{36})/i.exec(error.message ?? "");
    if (marca) {
      return json({
        erro: "IMPORTACAO_DUPLICADA",
        importacao_existente_id: marca[1],
        detalhe: "esta competencia ja tem importacao concluida com este nome de arquivo",
        gravou: false,
      }, 409);
    }
    return json({ erro: "RPC_RECUSOU", detalhe: error.message ?? "", gravou: false }, 400);
  }

  const resultado = Array.isArray(data) ? data[0] : data;

  return json({
    ok: true,
    modo: "importacao",
    gravou: true,
    digital: digitalCalculada,
    usuario: emailDaPessoa,
    arquivo: { nome, bytes: bytes!.length, formato: veredito.formato },
    importacao_id: resultado?.importacao_id ?? null,
    // `linhas_gravadas` MENOR que `linhas_conferidas` é esperado e não é erro:
    // a RPC descarta duplicata exata (mesma parcela + mesmo valor) contra o que
    // já existe. Reimportar o mesmo conteúdo grava zero -- é a idempotência, e
    // ela é da RPC, não desta função.
    linhas_conferidas: linhas.length,
    linhas_gravadas: resultado?.linhas_gravadas ?? 0,
  });
});
