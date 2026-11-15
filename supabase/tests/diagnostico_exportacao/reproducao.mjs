import { readFileSync } from "node:fs";
import { novoBanco, alunos, previa } from "../fixtures/acoes_massivas_universo/bancada.js";
// Fixtures: definicoes de producao (MD5 verificados) e colunas/indices minimos usados pela cadeia.
const ler = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const FIX = "../fixtures/";
const COLUNAS = `
  alter table public.acordos add column if not exists saldo numeric default 0;
  alter table public.parcelas add column if not exists boleto text;
  alter table public.parcelas add column if not exists boleto_confiavel boolean default false;
  alter table public.parcelas add column if not exists renegociada_no_acordo_id uuid;
  alter table public.parcelas add column if not exists pago_em timestamptz;
  alter table public.acordos_titulos add column if not exists documento text;
  alter table public.prime_extrato add column if not exists cpf text;
  alter table public.prime_extrato add column if not exists boleto text;
  alter table public.prime_extrato add column if not exists liquidado_em timestamptz;
  create table if not exists public.pagamentos (aluno_id uuid, numero_parcela_completo text,
    titulo_numero text, data_pagamento timestamptz, valor_pago numeric);`;
const LUANA = "cobranca05@teste.local";
// Identidade de gestao: TEM de estar na lista fixa de usuario_e_gestao (producao). Vem do ambiente; nao fica gravada no repositorio.
const GESTORA = process.env.GESTORA_CLAIM;
if (!GESTORA) { console.error("Defina GESTORA_CLAIM com uma identidade da lista de usuario_e_gestao."); process.exit(2); }

const db = await novoBanco();
await db.exec(COLUNAS);
await db.exec(ler(FIX + "acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql"));
await db.exec(ler(FIX + "acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql"));
// dependencias de producao (verificadas por MD5)
await db.exec(ler(FIX + "producao/usuario_e_gestao_e_motivo_texto_2026-11-15.sql"));
await db.exec(ler(FIX + "producao/registrar_acao_massiva_2026-11-15.sql"));
await db.exec(ler(FIX + "acoes_massivas_exportar/prod_20261115_definicao_vigente.sql"));
// Confere que as definicoes carregadas batem com o MD5 de producao (15/11/2026). Divergencia = para.
const ESPERADO = {
  acoes_massivas_exportar: "c9cc7498d16ca250e85c4727c8bb05bd",
  registrar_acao_massiva: "6eb41bf1dd68fcfb4eb44b9022b43e44",
  usuario_e_gestao: "af3d391f4234e6a352585777897568e4",
  acoes_massivas_motivo_texto: "d12cf7a63f41fead5f25c6f15a08ae33",
  acoes_massivas_universo: "8f94a1687f0f3d13765ecf86db1d1e19",
};
for (const [nome, md5] of Object.entries(ESPERADO)) {
  const r = (await db.query("select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [nome])).rows[0];
  if (!r || r.m !== md5) { console.error("DIVERGE", nome, r?.m); process.exit(3); }
}
console.log("MD5_OK", Object.keys(ESPERADO).join(","));
// caller: authenticated, claims de gestora, timeout do papel (8s) como em producao
// colunas de producao usadas por registrar/exportar (tipos de producao; ver evidencia)
await db.exec("alter table public.casos add column if not exists data_retorno date;");
// acoes_massivas_lotes e acoes_massivas_previas: colunas e tipos de producao (listagem information_schema, 15/11)
await db.exec("alter table public.acoes_massivas_lotes add column if not exists id uuid;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists canal text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists operador_email text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists arquivo text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists aluno_ids text[];");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists total integer;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists exportado_por_email text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists exportado_em timestamptz;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists confirmado_por_email text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists confirmado_em timestamptz;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists descartado_por_email text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists descartado_em timestamptz;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists resultado jsonb;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists tipo_cobranca text;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists filtros jsonb;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists solicitado integer;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists encontrado integer;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists selecionado integer;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists previa_id uuid;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists resumo_exclusoes jsonb;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists recencia_dias integer;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists registrados integer;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists registro_automatico boolean;");
await db.exec("alter table public.acoes_massivas_lotes add column if not exists lote_origem_id uuid;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists id uuid;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists criado_em timestamptz;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists criado_por_email text;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists filtros jsonb;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists solicitado integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists universo_base integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists disponiveis integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists elegiveis integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists selecionado integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists indisponiveis integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists motivos jsonb;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists com_responsavel integer;");
await db.exec("alter table public.acoes_massivas_previas add column if not exists com_fidelizacao integer;");
await db.exec("create unique index ux_aluno_mov_lote_aluno on public.aluno_movimentacoes using btree (lote_id, aluno_id) where (lote_id is not null);");
await db.exec("alter role authenticated set statement_timeout = '8s';");
await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email: GESTORA, role: "authenticated", name: "Gestora Teste" })]);
await db.exec("set role authenticated;");
await db.exec("set statement_timeout = '8s';");
await alunos(db, 300, { ini: 1, dono: LUANA, valor: 500 });
await db.exec("analyze;");

const argsTela = {
  p_ano_vencimento: null, p_limite: 100, p_dias_minimo_sem_contato: null, p_unidade: null,
  p_matricula: null, p_curso: null, p_situacao_academica: null, p_importacao_ids: null,
  p_canal: "WHATSAPP", p_valor_min: null, p_valor_max: null,
  p_operador_email: `CASO:${LUANA}`, p_tipo_cobranca: "MENSALIDADES",
  p_acionamento: null, p_recencia_dias: 10, p_sem_telefone: false,
};
let r;
try { r = await previa(db, argsTela); console.log("PREVIA_OK elegiveis", r.elegiveis.length, "previa_id", r.previa_id); }
catch (e) { console.log("PREVIA_ERRO code", e.code ?? "-", e.message.slice(0, 160)); process.exit(0); }
const ids = r.elegiveis.map((a) => String(a.id));
try {
  const t1 = Date.now();
  const x = (await db.query("select public.acoes_massivas_exportar($1::text[], $2::text, $3::text, $4::text, $5::text, $6::uuid) as x",
    [ids, "WHATSAPP", "acao-massiva-whatsapp-teste.xlsx", `CASO:${LUANA}`, "MENSALIDADES", r.previa_id])).rows[0].x;
  console.log("EXPORTAR_OK", Date.now() - t1, "ms contatos", x.contatos.length, "registrados", x.registrados, "lote", x.lote_id ? "sim" : "nao");
} catch (e) {
  console.log("EXPORTAR_ERRO code", e.code ?? "-", e.message.slice(0, 200));
}
// 3) repeticao: mesma previa, mesmos alunos (simula clique duplicado ou resposta perdida)
try {
  const x2 = (await db.query("select public.acoes_massivas_exportar($1::text[], $2::text, $3::text, $4::text, $5::text, $6::uuid) as x",
    [ids.slice(0, 1), "WHATSAPP", "repeticao-teste.xlsx", `CASO:${LUANA}`, "MENSALIDADES", r.previa_id])).rows[0].x;
  console.log("REPETICAO_OK registrados", x2.registrados, "contatos", x2.contatos.length, "excluidos_por_motivo", JSON.stringify(x2.excluidos_por_motivo), "lote", x2.lote_id ? "novo" : "nenhum");
} catch (e) { console.log("REPETICAO_ERRO code", e.code ?? "-", e.message.slice(0, 160)); }
const cont = (await db.query("select count(*)::int n from public.aluno_movimentacoes where lote_id is not null")).rows[0].n;
console.log("MOVIMENTACOES_COM_LOTE_TOTAL", cont);

