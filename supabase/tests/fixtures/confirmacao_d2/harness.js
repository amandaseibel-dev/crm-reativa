// Harness dos testes de confirmacao processada / D-2. PGlite + fixture de producao (funcoes com texto exato) + dados FICTICIOS.
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, p), "utf8");
export const lerRepo = (p) => readFileSync(resolve(AQUI, "..", "..", "..", "..", p), "utf8");
export const MIG = (n) => lerRepo(`supabase/migrations/${n}.sql`);
export const ROLL = (n) => lerRepo(`supabase/rollbacks/${n}.rollback.sql`);

export const ALUNO_A = "fc901354-19ff-4afb-b09b-37a7bd184794"; // "Aluna Teste Alfa" (ficticia)
export const ALUNO_B = "783ad39a-1282-4644-a5ba-c603ff12b9c4"; // "Aluna Teste Beta"
export const CONF_A = "34f812a1-1cea-4b9c-a60c-0d0e73b8bc1b";
export const CASO_A = "8c4c6935-4264-4fd7-9388-190af4945747";
export const GESTAO = "amanda.seibel@aelbra.com.br";
export const OP6 = "cobranca06@aelbra.com.br";
export const jwt = (email, role = "authenticated") => JSON.stringify({ email, role, sub: "52b292e4-e43e-4200-a684-b63d889d273a" });

const DIA0 = Date.UTC(2026, 8, 21);
function deslocamento() {
  const hoje = new Date();
  const h = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());
  return Math.round((h - DIA0) / 86400000);
}
function deslocar(v, d) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) + d * 86400000);
    return t.toISOString().slice(0, 10) + v.slice(10);
  }
  if (Array.isArray(v)) return v.map((x) => deslocar(x, d));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deslocar(x, d)]));
  return v;
}

export const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: { unaccent } });
export const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
export const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

// "Producao de hoje": fixture + dados (datas deslocadas para o dia da execucao: a geometria relativa se mantem).
export async function montarProd() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec("create extension if not exists unaccent;");
  await db.exec(ler("funcs.sql"));
  const dados = deslocar(JSON.parse(ler("dados.json")), deslocamento());
  for (const [tabela, linhas] of Object.entries(dados)) {
    for (const l of linhas) {
      await db.query(`insert into public.${tabela} select * from jsonb_populate_record(null::public.${tabela}, $1::jsonb)`, [JSON.stringify(l)]);
    }
  }
  await db.exec(ler("triggers.sql"));
  await db.query("insert into public.usuarios (nome, email, perfil, ativo) values ('Gestao Teste', $1, 'gestao', true), ('Operador Seis', $2, 'operador', true)", [GESTAO, OP6]);
  await db.exec("update public.fluxo_pagamentos_config set ligado = false where etapa in ('reconstruir_parcela_paga_antes','recuperar_acordo_avista')");
  await db.exec("set timezone = 'UTC'");
  return db;
}
// Estado pos-cron (12:40): amarracao + reprocessamento, como a rodada horaria.
export async function posCron(db) {
  await db.query("select set_config('reativa.fluxo_pagamentos','on',false)");
  await db.query("select public.parcelas_amarrar_boleto()");
  await db.query("select public.conciliacao_reprocessar(true,5000)");
  await db.query("select set_config('reativa.fluxo_pagamentos','',false)");
}
export const como = (db, email, role = "authenticated") => db.query("select set_config('test.jwt', $1, false)", [email ? jwt(email, role) : ""]);

const RUIDO = new Set(["atualizado_em", "caso_atualizado_em", "criado_em", "created_at", "updated_at", "conciliacao_em", "decidido_em", "origem_baixa_em", "registrado_em", "detectado_em", "confirmado_em", "gerado_em"]);
const T = {
  alunos: "select id,status_atual,status_jornada,status_acionamento,saldo_total,saldo_vencido,situacao_operacional,responsavel_atual_email,data_retorno,retorno_origem,proxima_acao,data_ultimo_acionamento from alunos order by id",
  casos: "select id,aluno_id,status_atual,status_acionamento,situacao_operacional,operador_email,saldo_total,saldo_vencido,data_retorno,status_financeiro from casos order by id",
  acordos: "select id,status,saldo,valor_total,operador_responsavel_email from acordos order by id",
  parcelas: "select id,acordo_id,numero,vencimento,valor,boleto,boleto_confiavel,status,pago_em,origem_baixa,origem_baixa_ref from parcelas order by id",
  pagamentos: "select id,aluno_id,status_conciliacao,conciliacao_motivo,valor_pago from pagamentos order by id",
  baixas_pagamento: "select id,aluno_id,parcela_id,status_baixa from baixas_pagamento order by id",
  solicitacoes: "select id,aluno_id,status,observacao_adm,confirmado_por,valor_informado from solicitacoes_confirmacao_pagamento order by id",
  vinculo: "select confirmacao_id,pagamento_id from solicitacao_confirmacao_pagamentos order by 1,2",
  log_quitacao_bloqueada: "select id,aluno_id,saldo_pendente from log_quitacao_bloqueada order by id",
  operador_agenda: "select id,aluno_id from operador_agenda order by id",
  aluno_movimentacoes: "select id,aluno_id,tipo,status_novo from aluno_movimentacoes order by id",
  auditoria: "select id,usuario,acao,registro_id from auditoria order by id",
  alertas: "select id,acordo_id,parcela_id,tipo,resolucao,responsavel_email from acordo_alertas_parcela order by id",
  retorno_acordo_auto: "select aluno_id,proximo_vencimento,data_retorno from retorno_acordo_auto order by 1,2",
};
export async function snap(db) {
  const o = {};
  for (const [k, s] of Object.entries(T)) {
    try { o[k] = (await db.query(`select to_jsonb(x) j from (${s}) x`)).rows.map((r) => r.j); } catch { o[k] = []; }
  }
  return o;
}
export function diff(a, b) {
  const out = [];
  for (const t of Object.keys(a)) {
    const chave = (r, i) => r.id ?? (r.confirmacao_id ? `${r.confirmacao_id}|${r.pagamento_id}` : r.aluno_id ? `${r.aluno_id}|${r.proximo_vencimento}` : i);
    const ka = new Map(a[t].map((r, i) => [chave(r, i), r]));
    const kb = new Map(b[t].map((r, i) => [chave(r, i), r]));
    for (const [id, rb] of kb) {
      const ra = ka.get(id);
      if (!ra) { out.push({ t, id, tipo: "NOVA", linha: rb }); continue; }
      const c = {};
      for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (RUIDO.has(k)) continue;
        if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) c[k] = { antes: ra[k] ?? null, depois: rb[k] ?? null };
      }
      if (Object.keys(c).length) out.push({ t, id, tipo: "ALT", c });
    }
    for (const [id, ra] of ka) if (!kb.has(id)) out.push({ t, id, tipo: "REMOVIDA", linha: ra });
  }
  return out;
}
export const FINANCEIRAS = ["parcelas", "baixas_pagamento", "pagamentos", "acordos"];
