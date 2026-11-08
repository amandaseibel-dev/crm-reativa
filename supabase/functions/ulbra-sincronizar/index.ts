// Edge Function: ulbra-sincronizar
// ---------------------------------------------------------------------------
// O ÚNICO relógio da integração com a Mensageria ULBRA. Roda por cron, com
// chave própria, e NÃO atende a tela de ninguém: é por isso que o custo não
// se multiplica pelo número de operadores abertos.
//
// SÓ LÊ da ULBRA. As duas ferramentas usadas — `listar_conversas` e
// `listar_atendimentos` — são de leitura e o próprio catálogo diz que não
// alteram nada. Nenhuma mensagem é enviada aqui, nenhum atendimento é
// assumido, transferido ou encerrado, nenhum cadastro é tocado.
//
// O que ela escreve, escreve no NOSSO banco, por uma RPC só
// (`ulbra_sync_gravar`): espelho das conversas da equipe Reativa, fila de
// atendimentos em espera e o estado do ciclo (cursor, contador de chamadas do
// dia, último erro). A decisão de QUEM atende é sugestão — a posse nasce de
// `ulbra_atendimento_assumir`, que é um UPDATE condicional.
//
// ACESSO: exige o cabeçalho `x-sync-chave` igual ao segredo `ULBRA_SYNC_CHAVE`.
// JWT de operador não serve, de propósito. `verify_jwt = false` no
// config.toml porque quem chama é o cron, não uma sessão — o portão é a chave.
//
// FALHA FECHADO: erro de rede, 406, 429 ou envelope torto terminam o ciclo
// como FALHOU, com o cursor ANTERIOR intacto. Nada é marcado como visto sem
// ter sido lido, e o ciclo seguinte repete a janela.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ACCEPT_MCP,
  CADENCIA_PADRAO,
  MAX_PAGINAS,
  MCP_URL,
  cargaAtendimentos,
  cargaConversas,
  decidirDestino,
  identificar,
  lerAtendimentos,
  lerCorpoMcp,
  lerPaginaConversas,
  novoCursor,
  resultadoDoEnvelope,
  type AtendimentoLido,
  colherConversas,
  type Colheita,
  type OperadorRodizio,
  type VinculoAtivo,
} from "./sincronizar.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-chave",
};

const json = (corpo: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/** Comparação de tamanho fixo: não vaza o tamanho da chave pelo tempo. */
function chaveConfere(recebida: string, esperada: string): boolean {
  if (recebida.length !== esperada.length) return false;
  let diferenca = 0;
  for (let i = 0; i < recebida.length; i++) {
    diferenca |= recebida.charCodeAt(i) ^ esperada.charCodeAt(i);
  }
  return diferenca === 0;
}

async function chamarMcp(token: string, carga: unknown): Promise<unknown> {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: ACCEPT_MCP,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(carga),
  });
  if (!resp.ok) {
    throw new Error(resp.status === 429 ? "ULBRA_LIMITE" : `ULBRA_HTTP_${resp.status}`);
  }
  return resultadoDoEnvelope(lerCorpoMcp(resp.headers.get("content-type"), await resp.text()));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const segredo = Deno.env.get("ULBRA_SYNC_CHAVE");
  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  const urlBanco = Deno.env.get("SUPABASE_URL");
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!segredo || !token || !urlBanco || !servico) {
    console.error("ulbra-sincronizar: ambiente incompleto");
    return json({ erro: "CONFIG_AUSENTE" }, 500);
  }
  if (!chaveConfere(req.headers.get("x-sync-chave") ?? "", segredo)) {
    return json({ erro: "ACESSO_NEGADO" }, 403);
  }

  const sb = createClient(urlBanco, servico, { auth: { persistSession: false } });

  // ---------------------------------------------------------------- estado
  const { data: estado } = await sb
    .from("ulbra_sync_estado")
    .select("cursor_mensagem, chamadas_dia, dia, ciclos_desde_atendimentos")
    .eq("id", true)
    .maybeSingle();

  const cursor: string | null = estado?.cursor_mensagem ?? null;
  const hoje = new Date().toISOString().slice(0, 10);
  const chamadasAntes: number = estado?.dia === hoje ? (estado?.chamadas_dia ?? 0) : 0;
  const ciclosDesde: number = estado?.ciclos_desde_atendimentos ?? 999;

  // Freio de orçamento do próprio dia: antes de gastar, confere se há saldo.
  // 12 é a folga reservada para a abertura de fichas pelos operadores.
  if (chamadasAntes >= 500 - 12) {
    await sb.rpc("ulbra_sync_gravar", {
      p_payload: {
        ciclo: "PULADO_ORCAMENTO",
        chamadas: 0,
        dia: hoje,
        erro: "ORCAMENTO_DO_DIA",
      },
    });
    return json({ ciclo: "PULADO_ORCAMENTO", chamadas_dia: chamadasAntes });
  }

  // ------------------------------------------------- referências do CRM
  const [{ data: vinculosBrutos }, { data: filaBruta }] = await Promise.all([
    sb
      .from("ulbra_vinculos")
      .select("ulbra_cliente_id, aluno_id, confianca")
      .is("desvinculado_em", null),
    sb
      .from("fila_receptivo")
      .select("email, atendimentos_hoje, ultimo_atendimento, em_pausa, online_em"),
  ]);

  const vinculos = new Map<string, VinculoAtivo>(
    (vinculosBrutos ?? []).map((v) => [v.ulbra_cliente_id as string, v as VinculoAtivo]),
  );
  const fila = (filaBruta ?? []) as OperadorRodizio[];
  const agoraMs = Date.now();

  // ------------------------------------------------------------- leitura
  let chamadas = 0;
  let atendimentos: AtendimentoLido[] = [];
  let colheita: Colheita;
  const lerAtendimentosAgora =
    ciclosDesde >=
    Math.max(
      1,
      Math.round(
        CADENCIA_PADRAO.cadencia_atendimentos_min / CADENCIA_PADRAO.cadencia_conversas_min,
      ),
    );

  try {
    colheita = await colherConversas(async (pagina) => {
      chamadas++;
      return chamarMcp(token, cargaConversas(pagina, pagina));
    }, cursor, MAX_PAGINAS);

    if (lerAtendimentosAgora) {
      atendimentos = lerAtendimentos(await chamarMcp(token, cargaAtendimentos(99)));
      chamadas++;
    }
  } catch (e) {
    const motivo = (e as Error).message;
    console.error("ulbra-sincronizar: ciclo falhou", motivo);
    await sb.rpc("ulbra_sync_gravar", {
      p_payload: { ciclo: "FALHOU", chamadas, dia: hoje, erro: motivo },
    });
    return json({ ciclo: "FALHOU", erro: motivo, chamadas }, 502);
  }

  // ------------------------------------------------------------- decisão
  const clientes = [...new Set(atendimentos.map((a) => a.ulbra_cliente_id))];
  const alunosDosClientes = clientes
    .map((c) => identificar(c, vinculos))
    .filter((i) => i.aluno_id)
    .map((i) => i.aluno_id as string);

  const donoPorAluno = new Map<string, string | null>();
  if (alunosDosClientes.length > 0) {
    const { data: casos } = await sb
      .from("casos")
      .select("aluno_id, operador_email")
      .in("aluno_id", alunosDosClientes);
    for (const c of casos ?? []) {
      const anterior = donoPorAluno.get(c.aluno_id as string) ?? null;
      donoPorAluno.set(c.aluno_id as string, anterior ?? (c.operador_email as string | null));
    }
  }

  const linhasConversas = colheita.conversas.map((c) => ({ ...c, ...identificar(c.ulbra_cliente_id, vinculos) }));

  const linhasAtendimentos = atendimentos.map((a) => {
    const identidade = identificar(a.ulbra_cliente_id, vinculos);
    const dono = identidade.aluno_id ? (donoPorAluno.get(identidade.aluno_id) ?? null) : null;
    const destino = decidirDestino(
      { identidade, caso: { operador_email: dono }, fila },
      agoraMs,
    );
    return { ...a, ...identidade, ...destino };
  });

  // -------------------------------------------------------------- gravação
  const { data: gravado, error } = await sb.rpc("ulbra_sync_gravar", {
    p_payload: {
      // INCOMPLETO grava os dados lidos, mas NAO avanca o cursor (ver novoCursor).
      ciclo: colheita.truncado ? "INCOMPLETO" : "OK",
      erro: colheita.truncado ? "BACKLOG_ACIMA_DO_TETO_DE_PAGINAS" : undefined,
      chamadas,
      dia: hoje,
      cursor: novoCursor(cursor, colheita),
      atendimentos_lidos: lerAtendimentosAgora,
      conversas: linhasConversas,
      atendimentos: linhasAtendimentos,
    },
  });
  if (error) {
    console.error("ulbra-sincronizar: gravação falhou", error.message);
    return json({ ciclo: "FALHOU", erro: "GRAVACAO", detalhe: error.message }, 500);
  }

  return json({
    ciclo: "OK",
    chamadas,
    chamadas_dia: chamadasAntes + chamadas,
    ciclo_completo: !colheita.truncado,
    conversas_novas: linhasConversas.length,
    respostas_de_cliente: linhasConversas.filter((c) => c.resposta_do_cliente).length,
    atendimentos_em_espera: lerAtendimentosAgora ? linhasAtendimentos.length : null,
    gravado,
  });
});
