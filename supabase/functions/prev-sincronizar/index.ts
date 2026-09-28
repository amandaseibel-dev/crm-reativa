// Edge Function: prev-sincronizar
// -----------------------------------------------------------------------------
// Atualiza a situação financeira dos títulos de uma CARTEIRA PREVENTIVA lendo a
// API do Prime. SÓ LÊ. Não dá baixa, não cria acordo, não toca em caso, fila,
// saldo operacional nem em qualquer tabela da cobrança — tudo que ela escreve
// passa por `preventivo_sinc_gravar`, que só mexe em tabelas `prev_`.
//
// POR QUE UMA FUNÇÃO PRÓPRIA, E NÃO `prime-extrato`:
//   `prime-extrato` varre os ~17,7 mil alunos da base inteira e é drenada pelo
//   mutirão de sábado (cron `prime_extrato_mutirao`, `*/2 2-23 * * 6`). O
//   Preventivo precisa de atualização diária de um subconjunto pequeno. Entrar
//   naquela fila significaria esperar até sábado E empurrar a operação da
//   cobrança para dentro de uma varredura diária que ela não pediu.
//
// GRANULARIDADE: uma chamada POR ALUNO, não por título. A API não tem rota em
// lote, e `GET /students/{registration}` já devolve o extrato inteiro sem
// paginar — é o caminho mais barato que existe (ver
// docs/integracoes/prime-api.md, `student_composite`).
//
// O QUE NÃO SE INVENTA AQUI:
//   - `paymentDate` é copiado cru e NUNCA lido como pagamento (vem preenchido
//     em 100% das linhas, inclusive em título a vencer);
//   - `paidAmount` é copiado cru e NUNCA somado como caixa (é valor de tabela);
//   - resposta com forma inesperada é ERRO, nunca "extrato vazio" — concluir
//     ausência a partir de falha técnica é o erro que esta função não comete;
//   - falha de um aluno não conclui o ciclo: o ciclo termina como FALHOU e a
//     tela mostra "desatualizado", com o dado anterior de pé.
//
// ACESSO: exige JWT de usuário e `preventivo_e_gestao()` verdadeiro no banco.
// A chave da Prime sai do Vault pela RPC `prime_chave_api` e nunca sai daqui.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://prime-api.ulbra.ai/api";
const LIMITE_MS = 110_000;      // teto de 150s da Edge, com folga
const CONCORRENCIA = 8;         // metade do usado em prime-extrato: carteira
                                // preventiva é pequena e não vale disputar
                                // banda com a operação da cobrança
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function primeGet(caminho: string, chave: string) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
      if (r.status === 503) { await new Promise((s) => setTimeout(s, 1200 * (t + 1))); continue; }
      if (!r.ok) return { ok: false as const, status: r.status };
      return { ok: true as const, dados: await r.json() };
    } catch { await new Promise((s) => setTimeout(s, 900 * (t + 1))); }
  }
  return { ok: false as const, status: 0 };
}

const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return isFinite(n) ? String(n) : null;
};
const dia = (v: unknown) => { const s = String(v ?? ""); return s.length >= 10 ? s.slice(0, 10) : null; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const inicio = Date.now();

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const autorizacao = req.headers.get("Authorization") ?? "";

  // 1. Quem está chamando? A resposta vem do BANCO, não de uma lista aqui.
  if (!autorizacao) return json({ erro: "sem credencial" }, 401);
  const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: autorizacao } } });
  const { data: ehGestao, error: erroGate } = await comoUsuario.rpc("preventivo_e_gestao");
  if (erroGate) return json({ erro: "nao foi possivel conferir o acesso" }, 401);
  if (ehGestao !== true) return json({ erro: "Preventivo: acesso restrito a gestao" }, 403);

  const supa = createClient(url, servico);
  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave) { const { data } = await supa.rpc("prime_chave_api"); chave = String(data ?? ""); }
  if (!chave) return json({ erro: "chave do Prime nao encontrada" }, 500);

  const corpo = await req.json().catch(() => ({}));
  const carteiraId = String(corpo?.carteira_id ?? "").trim();
  const origem = corpo?.origem === "cron" ? "cron" : "manual";
  let sincId = String(corpo?.sinc_id ?? "").trim();

  // 2. Abre o ciclo (ou continua um já aberto). A trava contra execução
  //    simultânea mora em `preventivo_sinc_abrir`, no banco.
  if (!sincId) {
    if (!carteiraId) return json({ erro: "informe carteira_id" }, 400);
    const { data, error } = await supa.rpc("preventivo_sinc_abrir",
      { p_carteira_id: carteiraId, p_origem: origem });
    if (error) return json({ erro: error.message }, 409);
    sincId = String(data);
  }

  const { data: alvos, error: erroAlvos } = await supa.rpc("preventivo_sinc_alvos",
    { p_sinc_id: sincId, p_limite: 300 });
  if (erroAlvos) return json({ erro: erroAlvos.message }, 500);

  const fila: string[] = (alvos ?? []).map((a: unknown) =>
    typeof a === "string" ? a : String((a as Record<string, unknown>)?.preventivo_sinc_alvos ?? ""));

  let consultados = 0, erros = 0, parou = false;

  async function umAluno(matricula: string) {
    const r = await primeGet(`/students/${encodeURIComponent(matricula)}`, chave);
    if (!r.ok) {
      erros++;
      await supa.rpc("preventivo_sinc_falhou",
        { p_sinc_id: sincId, p_matricula: matricula, p_erro: "prime " + r.status });
      return;
    }
    const d = r.dados as Record<string, unknown>;
    const fin = d?.financialStatement;
    if (!Array.isArray(fin)) {
      // 200 com forma diferente NÃO é extrato vazio. Ver prime-api.md,
      // "Erros e comportamento de rede".
      erros++;
      await supa.rpc("preventivo_sinc_falhou",
        { p_sinc_id: sincId, p_matricula: matricula, p_erro: "forma inesperada do extrato" });
      return;
    }

    // UMA entrada por linha do extrato, com os DOIS identificadores que a
    // Prime dá (boleto de 7 dígitos e documentNumber de 13) na mesma entrada.
    //
    // Isto é crítico: o casamento do título conta CANDIDATOS por vencimento.
    // Se a mesma linha entrasse duas vezes, uma por identificador, todo título
    // teria dois candidatos e a carteira inteira ficaria marcada como ambígua.
    // O casamento no banco é por igualdade exata — nunca por nome, nunca por
    // valor, nunca por proximidade de data.
    const vistos = new Set<string>();
    const linhas: Record<string, string | null>[] = [];
    for (const l of fin as Record<string, unknown>[]) {
      const c = (l.carrier ?? {}) as Record<string, unknown>;
      const boleto = String(l.boleto ?? "").trim();
      const interno = String(l.documentNumber ?? "").trim();
      const doc = boleto || interno;
      if (!doc || vistos.has(doc)) continue;
      vistos.add(doc);
      linhas.push({
        documento: doc,
        documento_alt: interno && interno !== doc ? interno : null,
        vencimento: dia(l.dueDate),
        valor_liquido: num(l.netAmount),
        valor_bruto: num(l.grossAmount),
        valor_corrigido: num(l.paidAmount),
        liquidado_em: dia(l.paymentDate),
        portador: c.id ? String(c.id) : null,
        portador_nome: c.name ? String(c.name).slice(0, 120) : null,
      });
    }

    const { error } = await supa.rpc("preventivo_sinc_gravar",
      { p_sinc_id: sincId, p_matricula: matricula, p_extrato: linhas });
    if (error) {
      erros++;
      await supa.rpc("preventivo_sinc_falhou",
        { p_sinc_id: sincId, p_matricula: matricula, p_erro: error.message.slice(0, 180) });
      return;
    }
    consultados++;
  }

  for (let i = 0; i < fila.length; i += CONCORRENCIA) {
    if (Date.now() - inicio > LIMITE_MS) { parou = true; break; }
    await Promise.all(fila.slice(i, i + CONCORRENCIA).map((m) => umAluno(m)));
  }

  const { data: restam } = await supa.rpc("preventivo_sinc_alvos", { p_sinc_id: sincId, p_limite: 500 });
  const faltam = (restam ?? []).length;

  // Só conclui quando não falta ninguém. Chamar de novo com o mesmo `sinc_id`
  // continua de onde parou — nada é reconsultado à toa e nada é duplicado (a
  // idempotência do movimento é garantida no banco, por `prev_evento.chave`).
  let status = "EM_ANDAMENTO";
  if (faltam === 0) {
    const { data: fim } = await supa.rpc("preventivo_sinc_concluir",
      { p_sinc_id: sincId, p_mensagem: erros > 0 ? `${erros} aluno(s) com falha de consulta` : null });
    status = (fim as Record<string, unknown>)?.status as string ?? "CONCLUIDA";
  }

  return json({
    sinc_id: sincId, consultados, erros, faltam, parou_no_tempo: parou,
    status, concluido: faltam === 0,
    segundos: Math.round((Date.now() - inicio) / 1000),
  });
});
