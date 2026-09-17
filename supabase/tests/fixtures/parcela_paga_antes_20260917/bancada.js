// BANCADA PGlite da reconstrucao da parcela paga antes da extracao -- apoio de
// teste, nao e teste.
//
// Reaproveita a montagem do teste da recuperacao do a vista (motor real,
// gatilhos de parcela e acordo, previa -- corpos de PRODUCAO conferidos por md5)
// e acrescenta o caminho da importacao: `trg_pagamento_conciliar` por linha,
// `_pagamentos_baixar_lote` por comando, `baixa_pelo_relatorio_pagamento`,
// `conciliacao_reprocessar`, `fluxo_pagamentos_rodar` e `importar_acordos`. As
// quatro funcoes que a migration troca entram no estado de producao pelo
// PROPRIO rollback.
//
// NENHUM DADO REAL: nomes, CPFs e matriculas sao inventados; os numeros dos
// acordos e os valores sao os dos casos de referencia 72113 e 72153.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", "..", "..", p), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const MIGRATION = ler("supabase/migrations/20260916230000_recuperacao_acordo_pago_sem_importacao.sql");
// 17/09/2026: pagamentos_trava passa a usar `aprovado` e `bloqueios` da previa.
// Os testes rodam no estado que producao tera depois das duas migrations.
const MIGRATION_TRAVA = ler("supabase/migrations/20260917100000_pagamentos_trava_usa_resultado_da_previa.sql");

// Ultima definicao de public.<nome> no arquivo: comando inteiro e corpo.
function funcao(arquivo, nome, md5Producao) {
  const texto = ler(arquivo);
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, "gi");
  let ultimo = -1;
  for (const m of texto.matchAll(re)) ultimo = m.index;
  if (ultimo < 0) throw new Error(`nao achei ${nome} em ${arquivo}`);
  const resto = texto.slice(ultimo);
  const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(resto);
  const ini = tag.index + tag[0].length;
  const fim = resto.indexOf(tag[1], ini);
  const corpo = resto.slice(ini, fim);
  if (md5(corpo) !== md5Producao) {
    throw new Error(`${nome}: o corpo em ${arquivo} nao e o de producao (${md5(corpo)})`);
  }
  return resto.slice(0, resto.indexOf(";", fim + tag[1].length) + 1);
}

const MOTOR = funcao("supabase/migrations/20260915120000_titulo_liquidado_na_origem.sql", "pagamento_conciliar_um", "fa3d64add73e0e73e587e16f0c0624d1");
const DOC = funcao("supabase/migrations/20260908200000_baixa_pelo_documento_respeita_vencimento.sql", "documento_casa_com_parcela", "8dc19271b478f12b4841a5ab7729ad1b");
const VENC = funcao("supabase/migrations/20260908200000_baixa_pelo_documento_respeita_vencimento.sql", "vencimento_do_pagamento", "4f4668a6b0da45839390d66306c0f397");
const VINC_TIT = funcao("supabase/migrations/20260902160000_vincular_nao_deixa_duvida.sql", "vincular_titulos_acordo", "47125b28f3af3db88d4bee721bcde130");
const VINC_ALUNO = funcao("supabase/migrations/20260914170000_motor_unico_de_conciliacao.sql", "pagamento_vincular_aluno", "341df31bd28fcdda6028fef621db27fc");
const DUPLICADO = funcao("supabase/migrations/20260827131917_importacao_sinaliza_duplicado_em_vez_de_barrar.sql", "tg_acordo_bloquear_duplicado", "1cbfef05f557d89c04583edc90f2c84c");
const HERDA = funcao("supabase/migrations/20260828170000_acordo_herda_responsavel_e_quitacao_sugerida.sql", "_acordo_herda_responsavel_do_aluno", "054ac6e1e6de2da7f78676591f915cc9");

// --- corpos EXATOS de producao que o repositorio nao tem ----------------------
const CORPO = {
  usuario_e_gestao: "\n  select lower(coalesce(auth.jwt()->>'email','')) in (\n    'amanda.seibel@aelbra.com.br',\n    'cobranca04@aelbra.com.br',\n    'cobranca07@aelbra.com.br'\n  );\n",
  titulo_quita: "\nbegin\n  if upper(coalesce(new.status,'')) <> 'QUITADO'\n     or upper(coalesce(old.status,'')) = 'QUITADO' then\n    return new;\n  end if;\n\n  -- acordo marcado quitado mas com parcela viva nao quita mensalidade nenhuma\n  if exists (select 1 from public.parcelas p\n              where p.acordo_id = new.id\n                and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA')) then\n    return new;\n  end if;\n\n  update public.acordos_titulos t\n     set situacao = 'PAGO', status = 'quitada',\n         motivo_ajuste = coalesce(t.motivo_ajuste,'')\n           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end\n           || 'quitada junto com o acordo ' || coalesce(new.numero_acordo::text,'')\n           || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',\n         atualizado_em = now()\n   where t.acordo_id = new.id\n     and coalesce(t.tipo_boleto,'') <> 'Acordo'\n     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');\n\n  return new;\nend;\n",
  fecha: "\ndeclare v_acordo uuid;\nbegin\n  v_acordo := coalesce(new.acordo_id, old.acordo_id);\n  if v_acordo is null then return null; end if;\n\n  update public.acordos a\n     set status = 'QUITADO', saldo = 0,\n         motivo_ajuste = coalesce(a.motivo_ajuste,'')\n           || case when coalesce(a.motivo_ajuste,'')='' then '' else ' | ' end\n           || 'quitado automaticamente: a ultima parcela foi paga',\n         atualizado_em = now()\n   where a.id = v_acordo\n     and upper(coalesce(a.status,'')) = 'ATIVO'\n     and exists (select 1 from public.parcelas p where p.acordo_id = a.id)\n     and not exists (select 1 from public.parcelas p where p.acordo_id = a.id\n                      and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));\n\n  return null;\nend;\n",
  bloqueia: "\ndeclare v_status text;\nbegin\n  if new.status = 'PAGO' and coalesce(old.status,'') is distinct from 'PAGO' then\n    select upper(coalesce(status,'')) into v_status from public.acordos where id = new.acordo_id;\n    if v_status = 'CANCELADO' then\n      raise exception 'acordo_cancelado_operacao_nao_permitida' using errcode='P0001';\n    end if;\n  end if;\n  return new;\nend; ",
  reabrir: "\ndeclare\n  v_aluno  uuid;\n  v_status text;\nbegin\n  begin\n    -- Só interessa parcela que representa dívida viva.\n    if upper(coalesce(new.status,'')) not in ('A_VENCER','VENCIDA') then\n      return null;\n    end if;\n\n    select a.aluno_id into v_aluno\n      from public.acordos a\n     where a.id = new.acordo_id and a.status = 'ATIVO';\n\n    if v_aluno is null then\n      return null;\n    end if;\n\n    select upper(coalesce(status_atual,'')) into v_status\n      from public.alunos where id = v_aluno;\n\n    -- Só mexe em quem está marcado como encerrado. Aluno normal não é tocado.\n    if not (v_status like 'QUIT%'\n            or v_status in ('BAIXA_REALIZADA','AGUARDANDO_BAIXA',\n                            'SALDO_ZERO_CONFIRMADO','SEM_SALDO_EM_ABERTO')) then\n      return null;\n    end if;\n\n    update public.alunos\n       set status_atual       = 'ACORDO_FECHADO',\n           status_jornada     = 'ACORDO_FECHADO',\n           status_acionamento = 'ACORDO_FECHADO'\n     where id = v_aluno;\n\n    insert into public.aluno_movimentacoes\n      (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)\n    values (v_aluno::text, 'REABERTURA_DIVIDA_NOVA',\n      'Aluno estava como ' || v_status || ' e voltou a ter parcela de acordo em aberto. '\n      || 'Devolvido para a fila automaticamente -- sem isso a divida ficaria invisivel.',\n      'ACORDO_FECHADO', 'SISTEMA', 'sistema_reabertura', now());\n\n  exception when others then\n    -- Nunca derrubar a criacao da parcela por causa disto.\n    return null;\n  end;\n  return null;\nend;\n",
  pago_em: "\nbegin\n  if new.status = 'PAGO' and new.pago_em is null then\n    new.pago_em := now();\n  end if;\n  return new;\nend;\n",
};
const MD5_CORPO = {
  usuario_e_gestao: "889cfa4a82e9046b4322e8c85ee07b7d",
  titulo_quita: "bde4388c3a26ea98f66e5163eef9bd51",
  fecha: "9a2301342f99c312e7bfa971ac621a1e",
  bloqueia: "eea504e2c7d47256d3f5e2b29d2bba4a",
  pago_em: "25bf0fb40ae9651c80dfdc3f6a1df491",
  reabrir: "57ff577266fec31ea5ffb47086be8408",
};


export const MIGRATION_NOVA = ler("supabase/migrations/20260917200000_parcela_paga_antes_da_extracao.sql");
export const ROLLBACK_NOVA = ler("supabase/rollbacks/20260917200000_parcela_paga_antes_da_extracao.rollback.sql");
const REPROCESSAR = funcao("supabase/migrations/20260914190000_acordo_confirmado_sem_estrutura.sql", "conciliacao_reprocessar", "e1475551d63d41dea9b93144524de4ac");
const GATILHO_CONCILIAR = funcao("supabase/migrations/20260914170000_motor_unico_de_conciliacao.sql", "_pagamento_conciliar", "fb72abd1a9ea25a16772e2f126de7a63");
const PRODUCAO = JSON.parse(ler("supabase/tests/fixtures/parcela_paga_antes_20260917/funcoes_producao.json")).funcoes;
export { md5 };

export async function montarBase() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.email() returns text language sql stable as $$ select auth.jwt() ->> 'email' $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;

    create table public.alunos (id uuid primary key, nome text, cpf text, cpf_mascarado text, matricula text,
      unidade text, status_atual text, status_jornada text, status_acionamento text, responsavel_atual_email text, responsavel_atual_nome text,
      saldo_total numeric, situacao_operacional text);
    create table public.usuarios (id uuid primary key default gen_random_uuid(), nome text, email text,
      perfil text, ativo boolean, nome_exibicao text);
    create table public.prime_contratos (cpf text, registration text);
    create sequence public.acordos_numero_acordo_seq;
    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid, cpf text,
      tipo text default 'ACORDO', forma_pagamento text default 'PARCELADO', valor_total numeric,
      qtd_parcelas int default 1, status text default 'ATIVO', unidade text, saldo numeric, observacao text,
      criado_por_email text, criado_por_nome text, numero_ulbra text, operador_responsavel_email text,
      operador_responsavel_nome text, criado_em timestamptz default now(), atualizado_em timestamptz default now(),
      numero_acordo bigint default nextval('public.acordos_numero_acordo_seq'), motivo_ajuste text,
      duplicado_de uuid, duplicado_marcado_em timestamptz);
    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid, numero int default 1,
      valor numeric, vencimento date, status text default 'A_VENCER', pago_em timestamptz, confirmado_por_email text,
      observacao text, criado_em timestamptz default now(), atualizado_em timestamptz default now(), honorarios numeric,
      is_entrada boolean default false, boleto text, boleto_confiavel boolean not null default false,
      origem_baixa text, origem_baixa_ref text, origem_baixa_em timestamptz);
    create unique index ux_parcelas_boleto on public.parcelas (boleto) where boleto is not null;
    create table public.acordos_titulos (id uuid primary key, aluno_id uuid, cpf text, documento text, vencimento date,
      valor_original numeric, saldo_corrigido numeric, valor_em_aberto numeric, valor_cobranca_ajustado numeric,
      situacao text, status text, tipo_boleto text, acordo_id uuid, vinculado_em timestamptz, vinculado_por text,
      motivo_ajuste text, atualizado_em timestamptz, origem_liquidacao text);
    create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      titulo_id uuid, ativo boolean, vinculado_por text, criado_em timestamptz);
    create table public.pagamentos (id uuid primary key, numero_parcela_completo text, dados jsonb,
      status_conciliacao text, conciliacao_motivo text, conciliacao_em timestamptz, cpf text, titulo_numero text,
      valor_pago numeric(14,2), retroativo boolean not null default false, data_pagamento date,
      operador_email text, operador_nome text, valor_honorario numeric, aluno_id uuid, aluno_nome text,
      importacao_id uuid, matricula text, origem_vinculo text, origem_vinculo_ref text, origem_vinculo_em timestamptz);
    create table public.fila_pagamento_sem_vinculo (id bigserial primary key, pagamento_id uuid not null unique,
      importacao_id uuid, arquivo_nome text, boleto text, data_pagamento date, valor_pago numeric, valor_honorario numeric,
      nome_recebido text, cpf_recebido text, matricula_recebida text, sugestoes jsonb not null default '[]',
      motivo text not null default '', decisao text, decidido_por text, decidido_em timestamptz, observacao text,
      status_conciliacao text, evidencia_origem text, evidencia_em timestamptz, consulta_estrutura_resultado text,
      aluno_escolhido_id uuid);
    create table public.baixas_pagamento (parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);
    create table public.prime_portador_membro (cpf text, portador int, coletado_em timestamptz);
    create table public.auditoria (id uuid primary key default gen_random_uuid(), usuario text, acao text,
      tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamptz default now());
    create table public.importacoes (id uuid primary key, arquivo_nome text);
    create table public.solicitacoes_confirmacao_pagamento (id uuid primary key default gen_random_uuid(),
      aluno_id text, status text);
    create table public.aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text, descricao text,
      status_novo text, registrado_por_nome text, registrado_por_email text, registrado_em timestamptz);

    create sequence public.chamadas_recalc;
    create function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null) returns jsonb
      language plpgsql as $$
      begin
        perform nextval('public.chamadas_recalc');
        update public.alunos set situacao_operacional = 'RECALCULADO' where id = p_aluno_id;
        return '{}'::jsonb;
      end $$;
  `);

  for (const [chave, esperado] of Object.entries(MD5_CORPO)) {
    if (md5(CORPO[chave]) !== esperado) throw new Error(`corpo de producao alterado: ${chave}`);
  }
  await db.query(`create function public.usuario_e_gestao() returns boolean language sql stable security definer set search_path to 'public' as $b$${CORPO.usuario_e_gestao}$b$`);
  for (const c of [VENC, DOC, MOTOR, VINC_TIT, VINC_ALUNO, DUPLICADO, HERDA]) await db.exec(c);
  await db.query(`create function public._titulo_quita_com_o_acordo() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO.titulo_quita}$b$`);
  await db.query(`create function public._acordo_fecha_com_a_ultima_parcela() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO.fecha}$b$`);
  await db.query(`create function public._bloquear_parcela_baixa_acordo_encerrado() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO.bloqueia}$b$`);
  await db.query(`create function public._parcela_pago_em_automatico() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO.pago_em}$b$`);
  await db.query(`create function public._reabrir_aluno_com_divida_nova() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO.reabrir}$b$`);
  await db.exec(`
    create trigger trg_acordo_bloquear_duplicado before insert or update of status, valor_total, qtd_parcelas, aluno_id
      on public.acordos for each row execute function tg_acordo_bloquear_duplicado();
    create trigger trg_acordo_herda_responsavel before insert on public.acordos
      for each row execute function _acordo_herda_responsavel_do_aluno();
    create trigger trg_titulo_quita_com_o_acordo after update of status on public.acordos
      for each row execute function _titulo_quita_com_o_acordo();
    create trigger trg_bloquear_parcela_baixa_acordo_encerrado before update on public.parcelas
      for each row execute function _bloquear_parcela_baixa_acordo_encerrado();
    create trigger trg_parcela_pago_em_automatico before insert or update on public.parcelas
      for each row execute function _parcela_pago_em_automatico();
    create trigger trg_acordo_fecha_com_a_ultima_parcela after update of status on public.parcelas
      for each row execute function _acordo_fecha_com_a_ultima_parcela();
    create trigger trg_reabrir_aluno_divida_nova_ins after insert on public.parcelas
      for each row execute function _reabrir_aluno_com_divida_nova();
  `);

  await db.exec(MIGRATION);
  await db.exec(MIGRATION_TRAVA);

  // --- caminho da importacao e da rodada horaria -----------------------------
  await db.exec(`
    alter table public.acordos_titulos add column if not exists dados jsonb, add column if not exists importacao_id uuid,
      add column if not exists created_at timestamp default now(), add column if not exists competencia text;
    create table public._backup_completar_parcelas_lote (id uuid primary key default gen_random_uuid(), lote text, acordo_id uuid,
      acao text, parcela_id uuid, titulo_id uuid, titulo_snapshot jsonb, executado_por text, executado_em timestamptz default now());
    create table public._backup_parcelas_acordo_erro_import (id uuid, aluno_id uuid, cpf text, documento text, vencimento date,
      valor_original numeric, saldo_corrigido numeric, situacao text, tipo_boleto text, dados jsonb, importacao_id uuid,
      created_at timestamp, status text, valor_em_aberto numeric, competencia text, motivo_ajuste text, atualizado_em timestamptz,
      acordo_id uuid, vinculado_em timestamptz, vinculado_por text);
    create function public._gate_completar_parcelas() returns boolean language sql as $$ select true $$;
    create table public.fluxo_pagamentos_config (etapa text primary key, ligado boolean default false, observacao text,
      alterado_em timestamptz default now(), alterado_por text);
    create table public.fluxo_pagamentos_execucoes (id bigserial primary key, rodou_em timestamptz default now(), origem text,
      carteira_antes numeric, carteira_depois numeric, resultado jsonb, erro text);
    insert into public.fluxo_pagamentos_config (etapa, ligado) values ('baixa_pelo_relatorio', true);
    create function public.sistema_sob_carga() returns jsonb language sql as $$ select '{"sob_carga": false}'::jsonb $$;
    create function public.baixa_por_documento_aplicar(p_desde date, p_confirmar boolean) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.conciliacao_consultar_portador_pendentes(p_limite integer default 5) returns jsonb language sql as $$ select '{}'::jsonb $$;

    -- importar_acordos (corpo de producao, pelo rollback)
    alter table public.alunos add column if not exists situacao_academica text, add column if not exists tipo_base text,
      add column if not exists origem text, add column if not exists observacao text;
    alter table public.importacoes add column if not exists tipo text, add column if not exists referencia text,
      add column if not exists usuario text, add column if not exists status text, add column if not exists retroativo boolean,
      add column if not exists qtd_registros int, add column if not exists created_at timestamptz default now();
    alter table public.acordos_titulos alter column id set default gen_random_uuid();
    create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid, quitado_em timestamptz);
    create table public.fila_acordos_confirmar (id bigserial primary key, aluno_id uuid, cpf text, nome text, acordo_base text,
      qtd_parcelas int, valor_total numeric, unidade text, situacao_aluno text, importacao_id uuid, unique (cpf, acordo_base));
    create function public.app_pode_borderos_importacoes() returns boolean language sql as $$ select true $$;
  `);
  for (const [nome, f] of Object.entries(PRODUCAO)) {
    if (md5(f.corpo) !== f.md5) throw new Error(`corpo de producao alterado na fixture: ${nome}`);
  }
  await db.query(`create function public.baixa_pelo_relatorio_pagamento(p_confirmar boolean default false, p_desde date default '2026-07-01'::date)
    returns jsonb language plpgsql security definer set search_path to 'public' set statement_timeout to '600s'
    as $b$${PRODUCAO.baixa_pelo_relatorio_pagamento.corpo}$b$`);
  await db.exec(REPROCESSAR);
  await db.exec(GATILHO_CONCILIAR);
  // estado de PRODUCAO de _pagamentos_baixar_lote, fluxo_pagamentos_rodar, completar_parcelas_acordo e importar_acordos
  await db.exec(ROLLBACK_NOVA);
  await db.exec(`
    create trigger trg_pagamento_conciliar after insert on public.pagamentos
      for each row execute function _pagamento_conciliar();
    create trigger pagamentos_baixar_lote after insert on public.pagamentos
      referencing new table as novos for each statement execute function _pagamentos_baixar_lote();
  `);
  return db;
}

export async function novoBanco({ patch = true, etapaLigada = false } = {}) {
  const db = await montarBase();
  if (patch) await db.exec(MIGRATION_NOVA);
  if (patch && etapaLigada) await ligarEtapa(db);
  return db;
}

export const ligarEtapa = (db) =>
  db.query(`update public.fluxo_pagamentos_config set ligado = true where etapa = 'reconstruir_parcela_paga_antes'`);

export async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

export const TABELAS_FOTO = ["alunos", "acordos", "parcelas", "pagamentos", "fila_pagamento_sem_vinculo", "auditoria", "aluno_movimentacoes"];
export async function foto(db) {
  const out = {};
  for (const t of TABELAS_FOTO) {
    out[t] = await um(db, `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.${t} x`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cenarios de referencia: estrutura, valores, datas, operador e situacao do
// aluno lidos em producao em 17/09/2026 (leitura com prova de md5):
//   72113: importado 16/09 16:47 com 4 parcelas (0002..0005, 839,05 x 3 +
//          839,08, vencimentos 18/10/2026..18/01/2027); entrada 0001 de
//          R$ 2.000,00 paga em 16/09, vencimento 18/09, honorario 148,15.
//   72153: importado 17/09 08:20 com 6 parcelas (0002..0007, 548,26 x 5 +
//          548,28, 18/10/2026..18/03/2027); entrada 0001 de R$ 2.193,05 paga
//          em 16/09, vencimento 18/09, honorario 162,45.
//   Os dois alunos estao em AGUARDANDO_BAIXA e os dois pagamentos em REVISAO.
// ---------------------------------------------------------------------------
export const CASOS = {
  "72113": { aluno: "00000000-0000-4000-8000-000000072113", cpf: "70000072113", matricula: "2026001113", nome: "ALUNA DE TESTE UM",
    parcelas: [839.05, 839.05, 839.05, 839.08], vencPrimeira: "2026-10-18", entrada: 2000, honorario: 148.15,
    importadoEm: "2026-09-16 19:47:02+00", operador: "cobranca12@aelbra.com.br",
    pagamento: "00000000-0000-4000-9000-000000072113" },
  "72153": { aluno: "00000000-0000-4000-8000-000000072153", cpf: "70000072153", matricula: "2026001153", nome: "ALUNO DE TESTE DOIS",
    parcelas: [548.26, 548.26, 548.26, 548.26, 548.26, 548.28], vencPrimeira: "2026-10-18", entrada: 2193.05, honorario: 162.45,
    importadoEm: "2026-09-17 11:20:48+00", operador: "cobranca11@aelbra.com.br",
    pagamento: "00000000-0000-4000-9000-000000072153" },
};

export const boletoDe = (numero, sufixo) => "5" + String(numero).padStart(6, "0") + String(sufixo).padStart(4, "0");

const somaMeses = (iso, n) => {
  const [a, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1 + n, d));
  return dt.toISOString().slice(0, 10);
};

// Aluno + acordo importado com as parcelas abertas, sem a entrada.
export async function semearAcordo(db, numero, o = {}) {
  const c = { ...CASOS[numero], ...o };
  if (!(await um(db, `select count(*)::int from public.usuarios where email = $1`, [c.operador]))) {
    await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operadora', $1, 'operador', true)`, [c.operador]);
  }
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, responsavel_atual_email, saldo_total)
                  values ($1, $2, $3, '***', $4, 'CANOAS', 'AGUARDANDO_BAIXA', $5, 0)`, [c.aluno, c.nome, c.cpf, c.matricula, c.operador]);
  await db.query(`insert into public.prime_contratos (cpf, registration) values ($1, $2)`, [c.cpf, c.matricula]);
  const primeiroSufixo = c.primeiroSufixo ?? 2;
  const importadas = c.parcelas
    .map((valor, i) => ({ valor, sufixo: primeiroSufixo + i, vencimento: somaMeses(c.vencPrimeira, i) }))
    .filter((q) => !(c.pular ?? []).includes(q.sufixo));
  const total = Number(importadas.reduce((s, q) => s + q.valor, 0).toFixed(2));
  const acordoId = await um(db, `insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, saldo, observacao,
                     criado_por_email, criado_por_nome, numero_ulbra, operador_responsavel_email, criado_em)
                   values ($1, $2, $3, $4, 'ATIVO', $3, 'Importado do Relatorio de Titulos em Aberto (Acordo) — lote teste',
                     $5, 'Importacao Acordos', $6, $7, $8) returning id`,
    [c.aluno, c.cpf, c.valorTotal ?? total, c.qtd ?? importadas.length, c.criadoPor ?? "importacao@sistema", numero, c.operador,
      c.importadoEm]);
  for (const q of importadas) {
    await db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, boleto_confiavel, observacao)
                    values ($1, $2, $3, $4, 'A_VENCER', $5, false, 'Gerada da importacao (lote teste)')`,
      [acordoId, q.sufixo, q.valor, q.vencimento, boletoDe(numero, q.sufixo)]);
  }
  // Em producao o aluno voltou a AGUARDANDO_BAIXA depois da importacao (o
  // operador informou o pagamento). A reabertura da importacao e desfeita aqui.
  await db.query(`update public.alunos set status_atual = 'AGUARDANDO_BAIXA', status_jornada = null, status_acionamento = null
                  where id = $1`, [c.aluno]);
  await db.query(`delete from public.aluno_movimentacoes where aluno_id = $1`, [c.aluno]);
  return acordoId;
}

// O pagamento da entrada, pelo INSERT normal (gatilhos da importacao).
export async function pagarEntrada(db, numero, o = {}) {
  const c = { ...CASOS[numero], ...o };
  const boleto = c.boleto ?? boletoDe(numero, 1);
  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                    data_pagamento, operador_email, operador_nome, aluno_nome, matricula)
                  values ($1, $2, $3, $4, $5, $6, $7, $8, 'Operadora', $9, $10)`,
    [c.pagamentoId ?? c.pagamento, boleto,
      JSON.stringify({ vencimento: c.vencEntrada === undefined ? "2026-09-18" : c.vencEntrada,
        valor_original: c.valorOriginal === undefined ? c.entrada : c.valorOriginal, ...(c.dadosExtra ?? {}) }),
      c.tituloNumero ?? numero, c.valorPago ?? c.entrada, c.honorario, c.dataPagamento ?? "2026-09-16", c.operador, c.nome, c.matricula]);
  return c.pagamentoId ?? c.pagamento;
}

export async function reconstruir(db, pagamentoId, confirmar = false) {
  return um(db, `select public.parcela_paga_antes_reconstruir($1, $2)`, [pagamentoId, confirmar]);
}
