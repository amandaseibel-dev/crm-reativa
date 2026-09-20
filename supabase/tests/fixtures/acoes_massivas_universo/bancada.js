// BANCADA PGlite -- fonte unica das Acoes Massivas (universo, cobertura, registro).
//
// PostgreSQL real com o estado de PRODUCAO de 20/09/2026 como ponto de partida
// (o rollback 20260920120000 restaura exatamente as definicoes vivas de
// gatilho, registrar, exportar e concluir) e, por cima, as tres migrations novas.
// "antes" = producao hoje; "depois" = producao + migrations.
//
// Dubles minimos do resto do banco; os corpos abaixo que sao reais foram lidos
// de producao (pg_get_functiondef). NENHUM DADO REAL: tudo inventado.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..", "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

export const MIG1 = ler("supabase/migrations/20260920100000_acoes_massivas_cobertura_estrutura.sql");
export const MIG2 = ler("supabase/migrations/20260920110000_acoes_massivas_universo.sql");
export const MIG3 = ler("supabase/migrations/20260920120000_acoes_massivas_registro_sem_fidelizacao.sql");
export const RB1 = ler("supabase/rollbacks/20260920100000_acoes_massivas_cobertura_estrutura.rollback.sql");
export const RB2 = ler("supabase/rollbacks/20260920110000_acoes_massivas_universo.rollback.sql");
export const RB3 = ler("supabase/rollbacks/20260920120000_acoes_massivas_registro_sem_fidelizacao.rollback.sql");
export const BACKFILL = ler("supabase/aguardando_aprovacao/20260920130000_acoes_massivas_backfill_lote_id.sql");

export const GESTAO = "gestao@teste.local";
export const OP_A = "op.a@teste.local";
export const OP_B = "op.b@teste.local";
export const OP_C = "op.c@teste.local";

export const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ESQUEMA = `
  create role anon; create role authenticated; create role service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
  create function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;

  create table public.usuarios (email text, nome text, perfil text, ativo boolean);
  create table public.alunos (
    id uuid primary key, nome text, telefone text, email text, cpf text,
    data_ultimo_acionamento timestamptz, situacao_academica text, curso text, unidade text,
    situacao_operacional text, responsavel_atual_email text, responsavel_atual_em timestamptz,
    data_retorno date, status_jornada text, status_atual text, status_acionamento text, retorno_origem text);
  create table public.casos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid, operador_email text, operador_nome text,
    total_em_aberto numeric, data_ultimo_acionamento date, cpf_limpo text, status_acionamento text,
    nao_acionar boolean, status_financeiro text, valor_pago numeric, quitado_em date, valor_quitado numeric,
    status_atual text, status_jornada text);
  create table public.solicitacoes_confirmacao_pagamento (aluno_id text, status text);
  create table public.prime_contratos (cpf text, valid_from date, status text);
  create table public.prime_extrato (coletado_em timestamptz);
  create table public.acordos (aluno_id uuid, status text, id uuid primary key default gen_random_uuid());
  create table public.acordos_titulos (
    aluno_id uuid, situacao text, vencimento date, importacao_id uuid,
    id uuid primary key default gen_random_uuid(), status text default 'em_aberto', tipo_boleto text,
    valor_cobranca_ajustado numeric, saldo_corrigido numeric, valor_em_aberto numeric,
    valor_original numeric default 100);
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(), acordo_id uuid, status text,
    valor numeric default 100, vencimento date);
  create table public.acordo_titulo_vinculo (titulo_id uuid, acordo_id uuid, ativo boolean default true);
  create table public.aluno_movimentacoes (
    id uuid primary key default gen_random_uuid(),
    aluno_id text, tipo text, descricao text, registrado_por_nome text,
    registrado_por_email text, registrado_em timestamptz);
  create table public.acoes_massivas_lotes (
    id uuid primary key default gen_random_uuid(), canal text, operador_email text, arquivo text,
    aluno_ids text[], total integer, exportado_por_email text, exportado_em timestamptz default now(),
    confirmado_por_email text, confirmado_em timestamptz, descartado_por_email text, descartado_em timestamptz,
    resultado jsonb, tipo_cobranca text default 'REGRA_ANTERIOR');
  create table public._liq_stub (aluno_id uuid);
  create table public._recalc_log (aluno_id uuid, motivo text);

  create function public.usuario_e_gestao() returns boolean language sql stable as
    $$ select lower(coalesce(auth.jwt()->>'email','')) = '${GESTAO}' $$;
  create function public.normalizar_status_acionamento(p_status text) returns text
    language sql immutable as
    $$ select trim(regexp_replace(upper(coalesce(p_status, '')), '[_\\-]+', ' ', 'g')) $$;
  create function public.saldo_titulos_aberto(p_cpf text) returns numeric language sql stable as $$ select 1::numeric $$;
  create function public.semestre_corrente_inicio() returns date language sql immutable as
    $$ select case when extract(month from current_date) <= 6
                   then make_date(extract(year from current_date)::int, 1, 1)
                   else make_date(extract(year from current_date)::int, 7, 1) end $$;
  create function public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
   returns boolean language plpgsql stable as $$
  declare
    bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
    quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
    nat text := public.normalizar_status_acionamento(p_status_atual);
    nac text := public.normalizar_status_acionamento(p_status_acionamento);
    nfi text := public.normalizar_status_acionamento(p_status_financeiro);
    njo text := public.normalizar_status_acionamento(p_status_jornada);
  begin
    if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
    if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
    if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
    if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
    return false;
  end $$;
  create function public.acoes_massivas_liquidados_prime(p_aluno_ids uuid[] default null)
   returns table(aluno_id uuid, titulos integer, valor_crm numeric, pago_prime numeric, ultima_liquidacao date)
   language sql stable as
    $$ select s.aluno_id, 1, 0::numeric, 0::numeric, current_date from public._liq_stub s
        where p_aluno_ids is null or s.aluno_id = any(p_aluno_ids) $$;

  -- REAIS (producao, 20/09/2026)
  create function public.acoes_massivas_tipo_cobranca_alunos(p_aluno_ids uuid[] DEFAULT NULL::uuid[])
   RETURNS TABLE(aluno_id uuid, tem_mensalidade boolean, tem_acordo_vencido boolean)
   LANGUAGE sql STABLE SET search_path TO 'public'
  AS $function$
    with mens as (
      select distinct t.aluno_id
        from public.acordos_titulos t
       where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
         and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
         and coalesce(lower(t.status), '') <> 'quitada'
         and coalesce(t.tipo_boleto, '') <> 'Acordo'
         and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
         and not exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA'))
    ),
    ativo as (
      select distinct a.aluno_id from public.acordos a
       where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids)) and a.status = 'ATIVO'
    ),
    vencido as (
      select distinct a.aluno_id from public.acordos a
        join public.parcelas p on p.acordo_id = a.id
       where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
         and a.status = 'ATIVO' and p.status = 'VENCIDA'
    ),
    populacao as (
      select v.aluno_id from vencido v
      union
      select m.aluno_id from mens m
       where not exists (select 1 from ativo x where x.aluno_id = m.aluno_id)
    )
    select p.aluno_id,
           exists (select 1 from mens m where m.aluno_id = p.aluno_id),
           exists (select 1 from vencido v where v.aluno_id = p.aluno_id)
      from populacao p;
  $function$;
  create function public.acoes_massivas_tipo_cobranca_corresponde(p_tipo text, p_tem_mensalidade boolean, p_tem_acordo_vencido boolean)
   RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public'
  AS $function$
    select case upper(coalesce(p_tipo, ''))
             when 'MENSALIDADES' then coalesce(p_tem_mensalidade, false) and not coalesce(p_tem_acordo_vencido, false)
             when 'ACORDOS_VENCIDOS' then coalesce(p_tem_acordo_vencido, false)
             when 'MENSALIDADES_E_ACORDOS' then coalesce(p_tem_mensalidade, false) or coalesce(p_tem_acordo_vencido, false)
             else false
           end;
  $function$;
  create function public.eh_tipo_acionamento(p_tipo text) returns boolean language sql immutable
   set search_path to 'public' as $function$
    select coalesce(p_tipo,'') in (
      'FINALIZACAO_ATENDIMENTO','FINALIZACAO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL','CONTATO',
      'LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','COMPROVANTE_ENVIADO_BAIXA',
      'QUITADO_MANUAL','TERMO_ENVIADO_ADM','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO'
    );
  $function$;
  create function public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
   RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public'
  AS $function$
    select p_data_ultimo_acionamento is not null
       and p_data_ultimo_acionamento + 10 >= current_date;
  $function$;
  create function public.caso_protegido_redistribuicao(a text, b text, c boolean, d text, e numeric, f date, g numeric)
   returns boolean language sql stable as $$ select false $$;
  create function public.casos_elegiveis_liberacao_fidelizacao()
   RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $function$
    select c.id, c.aluno_id, c.operador_email, c.operador_nome,
      c.data_ultimo_acionamento,
      case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
    from public.casos c
    left join public.alunos a on a.id = c.aluno_id
    where c.operador_email is not null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
            c.status_financeiro, c.status_jornada)
      and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
      and coalesce(a.responsavel_atual_em, now() - interval '2 days') < now() - interval '1 day'
    order by c.data_ultimo_acionamento asc nulls first;
  $function$;
  -- dubles: a recalculadora real e enorme; aqui so registramos QUEM a chamou.
  create function public.recalcular_situacao_aluno(p_aluno_id uuid, p_motivo text) returns jsonb
   language plpgsql as $$ begin insert into public._recalc_log values (p_aluno_id, p_motivo); return '{}'::jsonb; end $$;
`;

const GATILHO = `
  create trigger trg_atualizar_ultimo_acionamento after insert on public.aluno_movimentacoes
    for each row execute function public.fn_atualizar_ultimo_acionamento();
`;

// Extrai do rollback so os blocos CREATE (o "estado de producao de hoje").
function estadoProducao() {
  return RB3;
}

/** fase: 'antes' = producao hoje; 'depois' = producao + migrations novas. */
export async function novoBanco({ fase = "depois" } = {}) {
  const db = await PGlite.create();
  await db.exec(ESQUEMA);
  // funcoes vivas de producao (gatilho, registrar, exportar, concluir)
  await db.exec(estadoProducao());
  await db.exec(GATILHO);
  if (fase === "depois") {
    await db.exec(MIG1);
    await db.exec(MIG2);
    await db.exec(MIG3);
  }
  await db.exec(`insert into public.prime_extrato values ('2026-09-05 10:00:00+00');
                 insert into public.usuarios values ('${GESTAO}','Gestao','gerencia',true),
                   ('${OP_A}','Ana','operador',true), ('${OP_B}','Bruno','operador',true)`);
  await comoGestao(db);
  return db;
}

export async function comoGestao(db) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ email: GESTAO, role: "authenticated", name: "Gestao" })]);
}
export async function comoOperador(db, email) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ email, role: "authenticated" })]);
}
export async function comoSistema(db) {
  await db.query(`select set_config('request.jwt.claims', '', false)`);
}

/**
 * Semeia N alunos com divida ativa (1 titulo aberto de 2026, salvo `ano`), 1 caso.
 *   dono, valor, acionadoDias (data_ultimo_acionamento operacional, dias atras), telefone/email.
 * Devolve os ids em ordem.
 */
export async function alunos(db, n, o = {}) {
  const ini = o.ini ?? 1;
  const r = await db.query(
    `with g as (select generate_series($1::int, $2::int) as i)
     insert into public.alunos (id, nome, telefone, email, cpf, data_ultimo_acionamento, situacao_academica, curso, unidade,
        responsavel_atual_email, data_retorno, status_jornada, status_atual, situacao_operacional)
     select ('00000000-0000-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid,
            'Aluno' || g.i || ' Sobrenome',
            case when $3::boolean then null else '(51) 9' || lpad(g.i::text, 4, '0') || '-0000' end,
            case when $4::boolean then null else 'a' || g.i || '@aluno.local' end,
            lpad(g.i::text, 11, '0'),
            case when $5::int is null then null else now() - ($5::int || ' days')::interval end,
            $6, $7, $8, $9,
            case when $10::int is null then null else current_date + $10::int end,
            $11, $12, $13
       from g returning id`,
    [ini, ini + n - 1, !!o.semTelefone, !!o.semEmail, o.acionadoDias ?? null,
     o.situacao ?? null, o.curso ?? null, o.unidade ?? null, o.dono ?? null,
     o.retornoEmDias ?? null, o.statusJornada ?? null, o.statusAtual ?? null, o.situacaoOperacional ?? null]);
  const ids = r.rows.map((x) => x.id);
  await db.query(
    `insert into public.casos (aluno_id, operador_email, total_em_aberto, data_ultimo_acionamento, cpf_limpo)
     select id, $2, $3, case when $4::int is null then null else current_date - $4::int end, ''
       from unnest($1::uuid[]) id`,
    [ids, o.dono ?? null, o.valor ?? 500, o.acionadoDias ?? null]);
  await db.query(
    `insert into public.acordos_titulos (aluno_id, situacao, vencimento, importacao_id, status, tipo_boleto)
     select id, 'ABERTO', make_date($2::int, 3, 10), $3, 'em_aberto', null from unnest($1::uuid[]) id`,
    [ids, o.ano ?? 2026, o.imp ?? null]);
  if (o.liquidado) await db.query(`insert into public._liq_stub select unnest($1::uuid[])`, [ids]);
  if (o.confirmacao) {
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento select id::text, 'AGUARDANDO_CONFIRMACAO' from unnest($1::uuid[]) id`, [ids]);
  }
  if (o.acordoEmDia) {
    await db.query(`insert into public.acordos (aluno_id, status) select id, 'ATIVO' from unnest($1::uuid[]) id`, [ids]);
  }
  return ids;
}

/** Movimentacao "de verdade" (sem passar por lote): tipo, dias atras. */
export async function mov(db, alunoId, tipo, diasAtras = 0, extra = {}) {
  await db.query(
    `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
     values ($1, $2, 'x', 'x', $3, now() - ($4::numeric || ' days')::interval)`,
    [String(alunoId), tipo, extra.por ?? OP_A, diasAtras]);
}

export const universoSql = (f) => [`select * from public.acoes_massivas_universo($1::jsonb)`, [JSON.stringify(f ?? {})]];
export async function universo(db, f) {
  const [sql, v] = universoSql(f);
  return (await db.query(sql, v)).rows;
}

const TIPOS_PREVIA = {
  p_ano_vencimento: "text", p_limite: "integer", p_dias_minimo_sem_contato: "integer",
  p_apenas_nunca_acionado: "boolean", p_unidade: "text", p_curso: "text", p_apenas_ja_acionado: "boolean",
  p_situacao_academica: "text", p_importacao_ids: "uuid[]", p_matricula: "text", p_canal: "text",
  p_valor_min: "numeric", p_valor_max: "numeric", p_operador_email: "text", p_tipo_cobranca: "text",
  p_acionamento: "text", p_recencia_dias: "integer", p_sem_telefone: "boolean",
};
export async function previa(db, args = {}) {
  const ch = Object.keys(args);
  const sql = `select public.acoes_massivas_previa(${ch.map((k, i) => `${k} => $${i + 1}::${TIPOS_PREVIA[k]}`).join(", ")}) as r`;
  return (await db.query(sql, ch.map((k) => (Array.isArray(args[k]) ? `{${args[k].join(",")}}` : args[k])))).rows[0].r;
}
export async function cobertura(db, f = {}) {
  return (await db.query(`select public.acoes_massivas_cobertura_por_ano($1::jsonb) r`, [JSON.stringify(f)])).rows[0].r;
}
export async function drill(db, f, ano, indicador, motivo = null, limit = 2000, offset = 0) {
  return (await db.query(
    `select public.acoes_massivas_drilldown($1::jsonb, $2::int, $3, $4, $5::int, $6::int) r`,
    [JSON.stringify(f ?? {}), ano, indicador, motivo, limit, offset])).rows[0].r;
}
export async function exportar(db, ids, { canal = "WHATSAPP", operador = null, tipo = null, previa_id = null } = {}) {
  return (await db.query(
    `select public.acoes_massivas_exportar(p_aluno_ids => $1::text[], p_canal => $2, p_arquivo => 'x.xlsx',
       p_operador_email => $3, p_tipo_cobranca => $4, p_previa_id => $5::uuid) r`,
    [`{${ids.join(",")}}`, canal, operador, tipo, previa_id])).rows[0].r;
}
export async function concluir(db, lote, acao = "CONFIRMAR") {
  return (await db.query(`select public.acoes_massivas_concluir_lote($1::uuid, $2) r`, [lote, acao])).rows[0].r;
}
/** Fluxo completo da tela: previa -> exportar (com previa_id) -> confirmar. */
export async function executar(db, args, { canal = "WHATSAPP" } = {}) {
  const p = await previa(db, { p_canal: canal, ...args });
  const ids = p.elegiveis.map((e) => e.id);
  const ex = await exportar(db, ids, {
    canal, operador: args.p_operador_email ?? null, tipo: args.p_tipo_cobranca ?? null, previa_id: p.previa_id });
  const cf = ex.lote_id ? await concluir(db, ex.lote_id) : null;
  return { previa: p, exportacao: ex, confirmacao: cf, ids };
}

/** Foto de tudo que a acao massiva NAO pode alterar. */
export async function fotoIntocavel(db) {
  const q = async (sql) => JSON.stringify((await db.query(sql)).rows);
  return [
    await q(`select id, responsavel_atual_email, responsavel_atual_em, data_retorno, data_ultimo_acionamento,
                    status_acionamento, retorno_origem, situacao_operacional from public.alunos order by id`),
    await q(`select id, operador_email, data_ultimo_acionamento, total_em_aberto from public.casos order by id`),
    await q(`select * from public.acordos_titulos order by id`),
    await q(`select * from public.acordos order by id`),
    await q(`select * from public.parcelas order by id`),
  ].join("\n");
}
export async function titularidade(db) {
  return JSON.stringify([
    (await db.query(`select id, responsavel_atual_email from public.alunos order by id`)).rows,
    (await db.query(`select id, operador_email from public.casos order by id`)).rows]);
}
