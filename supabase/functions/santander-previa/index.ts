// Edge Function: santander-previa
// -----------------------------------------------------------------------------
// ENTREGA A do caminho Santander -> CRM. Recebe a planilha do extrato, devolve
// as LINHAS NORMALIZADAS e para aí.
//
// NÃO ESCREVE NADA. Não chama `projecao_importar_pagamentos`, não insere em
// `pagamentos`, não cria importação, não agenda nada e não toca na automação
// horária da PR #722. Há teste que confere, no texto deste arquivo, que o nome
// da RPC de importação não aparece -- é mais barato garantir por teste do que
// confiar em revisão.
//
// POR QUE EXISTE. O `.xls` é lido hoje NO NAVEGADOR e alguém sobe à mão: 484
// importações desde 07/07/2026, 4,5/dia nos últimos 30 dias, 9 só em 21/10,
// mais 226 substituições (refazer). A normalização rodando no servidor é o que
// permite, depois e com autorização própria, ligar a entrada a um canal
// automático. Esta entrega NÃO liga nada.
//
// ACESSO, duas trancas. O gateway exige JWT válido (`verify_jwt = true` em
// supabase/config.toml) e recusa com 401 antes de executar uma linha daqui.
// Além dele, o portão interno exige token de rotina OU sessão de GESTÃO,
// validada no servidor pelo banco -- a planilha traz nome de aluno, matrícula e
// valor pago, então não é material de operador.
//
// LIMITES. Tamanho, nome e número de linhas vivem em ./planilha.ts, junto da
// validação por ASSINATURA de arquivo (bytes), não por extensão.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import {
  LIMITE_BYTES,
  LIMITE_LINHAS,
  impressaoDigital,
  normalizarPlanilha,
  validarArquivo,
} from "./planilha.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token, x-arquivo-nome",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Comparação de token que não vaza tempo: mesmo custo para qualquer entrada.
function comparaSemVazarTempo(a: string, b: string): boolean {
  const A = new TextEncoder().encode(a);
  const B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  let diferenca = 0;
  for (let i = 0; i < A.length; i++) diferenca |= A[i] ^ B[i];
  return diferenca === 0;
}

// Segredo ausente FECHA a porta, nunca abre -- é a correção que o portão do
// prime-sonda já carrega, repetida aqui de propósito.
function tokenDaRotinaConfere(recebido: string, esperado: string): boolean {
  if (!esperado) return false;
  if (!recebido) return false;
  return comparaSemVazarTempo(recebido, esperado);
}

async function sessaoEhGestao(autorizacao: string): Promise<boolean> {
  try {
    const cliente = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: autorizacao } } },
    );
    // `usuario_e_gestao()` é SECURITY DEFINER e lê `auth.jwt()` da sessão: a
    // decisão é do banco, não desta função.
    const { data, error } = await cliente.rpc("usuario_e_gestao");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "METODO_NAO_PERMITIDO" }, 405);

  // ---------------------------------------------------------------------------
  // PORTÃO. Rotina primeiro, gestão depois: quem manda `x-rotina-token` está
  // dizendo qual porta quer, e o erro fica honesto sobre o que falhou.
  // ---------------------------------------------------------------------------
  const tokenRecebido = req.headers.get("x-rotina-token") ?? "";
  const segredoRotina = Deno.env.get("ROTINA_TOKEN") ?? "";
  const autorizacao = req.headers.get("Authorization") ?? "";

  let via: "rotina" | "gestao";
  if (tokenRecebido) {
    if (!tokenDaRotinaConfere(tokenRecebido, segredoRotina)) {
      return json({ erro: "TOKEN_INVALIDO" }, 401);
    }
    via = "rotina";
  } else {
    if (!autorizacao.startsWith("Bearer ")) return json({ erro: "SEM_TOKEN" }, 401);
    if (!(await sessaoEhGestao(autorizacao))) {
      return json({ erro: "ACESSO_NEGADO", detalhe: "restrito a gestao" }, 403);
    }
    via = "gestao";
  }

  // ---------------------------------------------------------------------------
  // O ARQUIVO. Aceita multipart (campo `arquivo`) ou corpo cru com o nome no
  // header `x-arquivo-nome` -- a primeira forma serve ao navegador, a segunda a
  // um chamador automático.
  // ---------------------------------------------------------------------------
  let bytes: Uint8Array | null = null;
  let nome = req.headers.get("x-arquivo-nome") ?? "";

  // Corta antes de ler o corpo quando o remetente declara o tamanho.
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > LIMITE_BYTES) {
    return json({ erro: "ARQUIVO_GRANDE", detalhe: `${declarado} bytes; limite ${LIMITE_BYTES}` }, 413);
  }

  try {
    const tipo = req.headers.get("content-type") ?? "";
    if (tipo.includes("multipart/form-data")) {
      const form = await req.formData();
      const campo = form.get("arquivo");
      if (campo instanceof File) {
        nome = nome || campo.name || "";
        bytes = new Uint8Array(await campo.arrayBuffer());
      }
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
    }
  } catch {
    return json({ erro: "CORPO_ILEGIVEL" }, 400);
  }

  const veredito = validarArquivo(bytes, nome);
  if (!veredito.ok) {
    return json(veredito, veredito.erro === "ARQUIVO_GRANDE" ? 413 : 400);
  }

  // ---------------------------------------------------------------------------
  // LEITURA E NORMALIZAÇÃO. Mesmas opções do navegador: primeira aba, sem
  // cabeçalho (header: 1), `cellDates` ligado e `raw` ligado.
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
    return json({ erro: "PLANILHA_LONGA", detalhe: `${linhasBrutas.length} linhas; limite ${LIMITE_LINHAS}` }, 413);
  }

  const linhas = normalizarPlanilha(linhasBrutas);

  // Resumo que permite conferir a prévia sem ler linha por linha. `sem_operador`
  // e `sem_matricula` são os dois que a gestão olha: operador ausente tira o
  // pagamento do ranking, matrícula ausente tira o vínculo com o aluno.
  const soma = (f: (l: typeof linhas[number]) => number) =>
    Math.round(linhas.reduce((t, l) => t + (f(l) || 0), 0) * 100) / 100;

  // ENTREGA B: a digital do conteúdo normalizado viaja com a prévia para que a
  // confirmação possa provar que importa EXATAMENTE o que foi conferido aqui.
  // Calcular não escreve nada -- esta função continua sem gravar.
  const digital = await impressaoDigital(linhas);

  return json({
    ok: true,
    modo: "previa",
    gravou: false,
    via,
    digital,
    arquivo: { nome, bytes: bytes!.length, formato: veredito.formato },
    resumo: {
      linhas_na_planilha: linhasBrutas.length,
      linhas_de_pagamento: linhas.length,
      descartadas: linhasBrutas.length - linhas.length,
      valor_pago: soma((l) => l.valor_pago),
      valor_honorario: soma((l) => l.valor_honorario),
      sem_operador: linhas.filter((l) => !l.operador_email).length,
      sem_matricula: linhas.filter((l) => !l.matricula).length,
      sem_boleto: linhas.filter((l) => !l.numero_parcela_completo).length,
    },
    linhas,
  });
});
