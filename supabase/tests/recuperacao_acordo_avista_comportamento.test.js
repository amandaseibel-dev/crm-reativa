// RECUPERACAO DE ACORDO PAGO SEM IMPORTACAO -- COMPORTAMENTO, nao estrutura.
//
// Executa a migration REAL num PostgreSQL real (PGlite). O que ela chama roda
// com o codigo de PRODUCAO, conferido por md5 antes de usar:
//   pagamento_conciliar_um, documento_casa_com_parcela, vencimento_do_pagamento,
//   vincular_titulos_acordo, pagamento_vincular_aluno,
//   tg_acordo_bloquear_duplicado, _acordo_herda_responsavel_do_aluno
// -- lidos das migrations do repositorio -- e os gatilhos que decidem o
// desfecho da baixa (`_acordo_fecha_com_a_ultima_parcela`,
// `_titulo_quita_com_o_acordo`, `_bloquear_parcela_baixa_acordo_encerrado`,
// `_parcela_pago_em_automatico`, `_reabrir_aluno_com_divida_nova`) mais
// `usuario_e_gestao`, copiados BYTE A BYTE
// de producao.
//
// `recalcular_situacao_aluno` e DUBLE: so marca que foi chamado. O saldo que a
// previa projeta e calculado por ela mesma, e e isso que o teste confere.
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const MIGRATION = ler("supabase/migrations/20260916230000_recuperacao_acordo_pago_sem_importacao.sql");

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

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A1 = U(1), A2 = U(2), A3 = U(3), A4 = U(4), A5 = U(5);
const T1 = U(11), T2 = U(12), T3 = U(13), T4 = U(14), T5 = U(15);
const G1 = U(21), G2 = U(22), G3 = U(23), G4 = U(24), G5 = U(25);
const GESTAO = "amanda.seibel@aelbra.com.br";
const OPERADOR = "cobranca11@aelbra.com.br";

const TABELAS = ["alunos", "acordos", "parcelas", "acordos_titulos", "acordo_titulo_vinculo", "pagamentos",
  "fila_pagamento_sem_vinculo", "auditoria", "aluno_movimentacoes"];

async function novoBanco() {
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

  // --- fixture ----------------------------------------------------------------
  await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values
    ('Allan', $1, 'operador', true), ('Outro', 'cobranca99@aelbra.com.br', 'operador', true)`, [OPERADOR]);
  const aluno = (id, nome, cpf, resp, status = "Em cobrança") =>
    db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, unidade, status_atual, responsavel_atual_email, saldo_total)
              values ($1,$2,$3,'***',$4,$5,$6,0)`, [id, nome, cpf, "CANOAS", status, resp]);
  await aluno(A1, "Maria da Silva", "111.222.333-44", "cobranca99@aelbra.com.br", "AGUARDANDO_BAIXA");
  await aluno(A2, "João Souza", "22233344455", null);
  await aluno(A3, "Ana Lima", "33344455566", null);
  await aluno(A4, "Pedro Costa", "44455566677", null);
  await aluno(A5, "Pedro Costa", "55566677788", null); // homonimo
  await db.query(`insert into public.prime_contratos (cpf, registration) values
    ('11122233344','2023000752'), ('33344455566','221009075'), ('44455566677','202003660')`);

  const titulo = (id, aluno_id, doc, venc, valor, situacao = "ABERTO", status = "em_aberto", tipo = "Cursos de Graduação") =>
    db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, saldo_corrigido, situacao, status, tipo_boleto)
              values ($1,$2,$3,$4,$5,$5,$6,$7,$8)`, [id, aluno_id, doc, venc, valor, situacao, status, tipo]);
  await titulo(T1, A1, "4527055", "2026-08-05", 1000);
  await titulo(T2, A1, "4527050", "2026-06-05", 900, "PAGO", "quitada");
  await titulo(T3, A2, "4527999", "2026-08-05", 500);
  await titulo(T4, A3, "1071752", "2025-06-05", 646.27);
  await titulo(T5, A4, "3720660", "2026-08-05", 1100);

  const pagamento = (id, bol, valor, data, venc, nome, mat, status = "AGUARDANDO_ACORDO") =>
    db.query(`insert into public.pagamentos (id, numero_parcela_completo, valor_pago, data_pagamento, dados, status_conciliacao,
                aluno_nome, matricula, operador_email, operador_nome, titulo_numero)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Allan',$10)`,
      [id, bol, valor, data, JSON.stringify({ vencimento: venc, valor_original: valor }), status, nome, mat, OPERADOR,
        String(Number(bol.slice(1, 7)))]);
  await pagamento(G1, "50720660001", "1131.10", "2026-09-15", "2026-09-18", "MARIA DA SILVA", "2023000752");
  await pagamento(G2, "50717520001", "816.63", "2026-09-16", "2026-09-16", "ANA LIMA", "221009075");
  await pagamento(G3, "50720660002", "1131.10", "2026-09-15", "2026-10-18", "PEDRO COSTA", "202003660");
  await pagamento(G4, "50720990001", "1200.00", "2026-09-15", "2026-09-18", "PEDRO COSTA", "202003660");
  await pagamento(G5, "50710000001", "100.00", "2026-09-15", "2026-09-18", "MARIA DA SILVA", "2023000752", "BAIXADO");
  for (const g of [G1, G2, G3, G4]) {
    await db.query(`insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo, status_conciliacao) values ($1,'pendente','AGUARDANDO_ACORDO')`, [g]);
  }
  // o acordo de numero MAIOR que 71752 ja veio numa importacao anterior ao dia do pagamento
  await db.query(`insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas, criado_por_email, criado_em)
                  values ($1,'71757','ATIVO',10,1,'importacao@sistema','2026-09-14 11:13:53+00')`, [A2]);

  await comoUsuario(db, GESTAO);
  return db;
}

async function comoUsuario(db, email) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ email, role: "authenticated" })]);
}

async function foto(db) {
  const out = {};
  for (const t of TABELAS) {
    const r = await db.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.${t} x`);
    out[t] = r.rows[0].h;
  }
  return out;
}

async function registrar(db, pid, titulos, confirmar = false) {
  const r = await db.query(`select public.acordo_avista_registrar($1, $2::uuid[], $3) as r`,
    [pid, titulos, confirmar]);
  return r.rows[0].r;
}
const bloqueios = (r) => r.bloqueios;
const validacao = (r, codigo) => r.validacoes.find((v) => v.codigo === codigo);

describe("simulação", () => {
  it("aprova o à vista com matrícula + nome e não grava NADA", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]); // G3 e o 2o boleto do 72066
    const antes = await foto(db);
    const r = await registrar(db, G1, null);
    expect(await foto(db)).toEqual(antes);

    expect(r.modo).toBe("SIMULACAO");
    expect(r.gravou).toBe(false);
    expect(bloqueios(r)).toEqual([]);
    expect(r.aprovado).toBe(true);
    expect(r.aluno.id).toBe(A1);
    expect(r.acordo_a_criar).toMatchObject({ numero_ulbra: "72066", qtd_parcelas: 1, status: "ATIVO",
      operador_responsavel_email: OPERADOR });
    expect(r.parcela_a_criar).toMatchObject({ numero: 1, boleto: "50720660001", vencimento: "2026-09-18", boleto_confiavel: true });
    expect(r.titulos.selecao).toBe("SUGERIDA");
    expect(r.titulos.selecionados.map((t) => t.id)).toEqual([T1]);
    expect(Number(r.titulos.soma)).toBe(1000);
    // 1131,10 / 1000 = 1,1311: a razao medida nos quatro casos explicados de 16/09
    expect(validacao(r, "DIFERENCA_DENTRO_DA_MARGEM_SEGURA").detalhe).toMatch(/soma × 1,1311 · dentro da margem segura/);
    expect(Number(r.titulos.faixa_valor_pago.margem_segura)).toBe(1.15);
    expect(Number(r.saldo.antes)).toBe(1000);
    expect(Number(r.saldo.esperado_depois)).toBe(0);
    // o credito e do operador do pagamento; o dono do aluno nao muda
    expect(r.credito.operador_email).toBe(OPERADOR);
    expect(r.aluno.responsavel_antes).toBe("cobranca99@aelbra.com.br");
    expect(r.aluno.responsavel_depois).toBe("cobranca99@aelbra.com.br");
    // AGUARDANDO_BAIXA e o estado de quem pagou: passa, e o efeito vem dito
    expect(r.aluno.status_atual).toBe("AGUARDANDO_BAIXA");
    expect(r.aluno.status_logo_apos).toBe("ACORDO_FECHADO");
    expect(r.efeitos.join(" | ")).toMatch(/AGUARDANDO_BAIXA para ACORDO_FECHADO/);
  });

  it("quem não é da gestão é barrado antes de ler qualquer coisa", async () => {
    const db = await novoBanco();
    await comoUsuario(db, OPERADOR);
    await expect(registrar(db, G1, null)).rejects.toThrow(/gestão financeira/);
  });
});

describe("travas: recusa sem gravar", () => {
  it("boleto que não é a parcela 0001", async () => {
    const db = await novoBanco();
    const r = await registrar(db, G3, [T5]);
    expect(bloqueios(r)).toContain("BOLETO_PARCELA_0001");
  });

  it("mais de um boleto do mesmo acordo", async () => {
    const db = await novoBanco();
    // G3 e 50720660002: o acordo 72066 tem dois boletos na base
    const r = await registrar(db, G1, [T1]);
    expect(bloqueios(r)).toContain("UNICO_BOLETO_DO_ACORDO");
    expect(validacao(r, "UNICO_BOLETO_DO_ACORDO").detalhe).toMatch(/outros pagamentos do acordo: 1/);
  });

  it("número ULBRA que já existe no CRM", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    await db.query(`insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas) values ($1,'72066','CANCELADO',1,1)`, [A2]);
    const r = await registrar(db, G1, [T1]);
    expect(bloqueios(r)).toEqual(["NUMERO_ULBRA_INEXISTENTE"]);
  });

  it("matrícula e nome apontando para alunos diferentes", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set aluno_nome = 'JOÃO SOUZA' where id = $1`, [G2]);
    const r = await registrar(db, G2, [T4]);
    expect(bloqueios(r)).toContain("MATRICULA_E_NOME_MESMO_ALUNO");
  });

  it("nome repetido na base não identifica", async () => {
    const db = await novoBanco();
    const r = await registrar(db, G4, [T5]);
    expect(bloqueios(r)).toEqual(expect.arrayContaining(["NOME_APONTA_UM_ALUNO", "MATRICULA_E_NOME_MESMO_ALUNO"]));
  });

  it("título de outro aluno e título já ligado a acordo", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    const outro = await registrar(db, G1, [T1, T3]);
    expect(validacao(outro, "TITULOS_ELEGIVEIS").detalhe).toMatch(/TITULO_DE_OUTRO_ALUNO/);

    await db.query(`update public.acordos_titulos set acordo_id = (select id from public.acordos limit 1) where id = $1`, [T1]);
    const ligado = await registrar(db, G1, [T1]);
    expect(validacao(ligado, "TITULOS_ELEGIVEIS").detalhe).toMatch(/TITULO_LIGADO_A_OUTRO_ACORDO/);
  });

  it("a soma das mensalidades não pode passar do valor pago", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    await db.query(`update public.acordos_titulos set saldo_corrigido = 1200 where id = $1`, [T1]);
    const r = await registrar(db, G1, [T1]);
    expect(bloqueios(r)).toEqual(["SOMA_ATE_O_VALOR_PAGO"]);
    expect(validacao(r, "SOMA_ATE_O_VALOR_PAGO").detalhe).toMatch(/a soma passa do valor pago/);
  });

  it("margem segura: soma × 1,15 passa, acima disso recusa e diz que excede", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    // 983,57 × 1,15 = 1131,1055 >= 1131,10: no limite, passa
    await db.query(`update public.acordos_titulos set saldo_corrigido = 983.57 where id = $1`, [T1]);
    const limite = await registrar(db, G1, [T1]);
    expect(bloqueios(limite)).toEqual([]);

    // 975 × 1,15 = 1121,25 < 1131,10 (razao 1,1601): recusa
    await db.query(`update public.acordos_titulos set saldo_corrigido = 975 where id = $1`, [T1]);
    const acima = await registrar(db, G1, [T1]);
    expect(bloqueios(acima)).toEqual(["DIFERENCA_DENTRO_DA_MARGEM_SEGURA"]);
    expect(validacao(acima, "DIFERENCA_DENTRO_DA_MARGEM_SEGURA").detalhe)
      .toMatch(/a diferença excede a margem segura de 15% \(limite: soma × 1,15\)/);

    // 1,30 deixou de ser aceito: 1131,10 / 900 = 1,2568
    await db.query(`update public.acordos_titulos set saldo_corrigido = 900 where id = $1`, [T1]);
    const antigo = await registrar(db, G1, [T1]);
    expect(bloqueios(antigo)).toEqual(["DIFERENCA_DENTRO_DA_MARGEM_SEGURA"]);
  });

  it("ausência não explicada (71752) fica fora do fluxo normal, sem liberação manual", async () => {
    const db = await novoBanco();
    const r = await registrar(db, G2, [T4]);
    // o fixture repete o 71752: ausencia nao explicada E razao 816,63 / 646,27 = 1,2636
    expect(bloqueios(r)).toEqual(["AUSENCIA_EXPLICADA", "DIFERENCA_DENTRO_DA_MARGEM_SEGURA"]);
    expect(validacao(r, "AUSENCIA_EXPLICADA").detalhe).toMatch(/71757/);
    expect(validacao(r, "AUSENCIA_EXPLICADA").detalhe).toMatch(/fora do fluxo normal/);

    // nao existe parametro de liberacao: a assinatura tem tres argumentos
    const assinatura = await db.query(`select pg_get_function_identity_arguments('public.acordo_avista_registrar'::regproc) a`);
    expect(assinatura.rows[0].a).toBe("p_pagamento_id uuid, p_titulo_ids uuid[], p_confirmar boolean");
    const antes = await foto(db);
    const tentativa = await registrar(db, G2, [T4], true);
    expect(tentativa.gravou).toBe(false);
    expect(await foto(db)).toEqual(antes);
  });

  it("aluno já encerrado à mão (quitado) não recebe acordo", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    await db.query(`update public.alunos set status_atual = 'QUITADO_MANUAL' where id = $1`, [A1]);
    const r = await registrar(db, G1, [T1]);
    expect(bloqueios(r)).toEqual(["ALUNO_NAO_ENCERRADO"]);
  });

  it("confirmar recusado não grava, e confirmar sem mensalidades escolhidas é recusado", async () => {
    const db = await novoBanco();
    const antes = await foto(db);
    const recusado = await registrar(db, G2, [T4], true);
    expect(recusado.gravou).toBe(false);
    expect(recusado.modo).toBe("RECUSADO");
    const semTitulos = await registrar(db, G2, [], true);
    expect(semTitulos.bloqueios).toEqual(["TITULOS_ESCOLHIDOS"]);
    expect(await foto(db)).toEqual(antes);
  });
});

describe("confirmação", () => {
  it("cria acordo e parcela, vincula a mensalidade e a baixa sai pelo motor real", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    const r = await registrar(db, G1, [T1], true);

    expect(r.gravou).toBe(true);
    expect(r.modo).toBe("CONFIRMADO");

    const acordo = (await db.query(`select * from public.acordos where numero_ulbra = '72066'`)).rows;
    expect(acordo).toHaveLength(1);
    expect(acordo[0]).toMatchObject({ status: "QUITADO", qtd_parcelas: 1, aluno_id: A1,
      operador_responsavel_email: OPERADOR, criado_por_email: GESTAO });
    expect(acordo[0].observacao).toMatch(/^RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO/);

    const parcela = (await db.query(`select * from public.parcelas where acordo_id = $1`, [acordo[0].id])).rows;
    expect(parcela).toHaveLength(1);
    expect(parcela[0]).toMatchObject({ status: "PAGO", boleto: "50720660001", boleto_confiavel: true,
      origem_baixa: "GATILHO_IMPORTACAO", origem_baixa_ref: G1, confirmado_por_email: OPERADOR });

    const t1 = (await db.query(`select situacao, status, acordo_id from public.acordos_titulos where id = $1`, [T1])).rows[0];
    expect(t1).toMatchObject({ situacao: "PAGO", status: "quitada", acordo_id: acordo[0].id });

    const pag = (await db.query(`select status_conciliacao, aluno_id, origem_vinculo from public.pagamentos where id = $1`, [G1])).rows[0];
    expect(pag).toMatchObject({ status_conciliacao: "BAIXADO", aluno_id: A1, origem_vinculo: "GESTAO_MANUAL" });

    // o dono do aluno nao foi trocado pela regularizacao
    const al = (await db.query(`select responsavel_atual_email, status_atual from public.alunos where id = $1`, [A1])).rows[0];
    expect(al.responsavel_atual_email).toBe("cobranca99@aelbra.com.br");
    // o gatilho de reabertura roda como na importacao de acordo; quem encerra o
    // aluno de saldo zero e a rotina existente, que este teste nao reproduz
    expect(al.status_atual).toBe("ACORDO_FECHADO");
    const reab = (await db.query(`select count(*)::int n from public.aluno_movimentacoes where aluno_id = $1 and tipo = 'REABERTURA_DIVIDA_NOVA'`, [A1])).rows[0];
    expect(reab.n).toBe(1);

    const aud = (await db.query(`select * from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'`)).rows;
    expect(aud).toHaveLength(1);
    expect(aud[0].registro_id).toBe(acordo[0].id);
    expect(aud[0].detalhes).toMatchObject({ origem: "RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO", confirmado_por: GESTAO,
      pagamento_id: G1, parcela_id: parcela[0].id, titulo_ids: [T1] });
    expect(aud[0].detalhes.operador_original.operador_email).toBe(OPERADOR);
    expect(aud[0].detalhes.estado_antes.aprovado).toBe(true);
    expect(aud[0].detalhes.estado_depois.pagamento.status_conciliacao).toBe("BAIXADO");

    // repetir o clique nao cria segundo acordo
    const deNovo = await registrar(db, G1, [T1], true);
    expect(deNovo.gravou).toBe(false);
    expect(deNovo.bloqueios).toEqual(expect.arrayContaining(["ESTADO_AGUARDANDO_ACORDO", "NUMERO_ULBRA_INEXISTENTE"]));
  });

  it("se o motor não baixar, nada fica gravado", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    // o motor recusa a baixa: o vencimento do arquivo passa a divergir da parcela
    await db.exec(`
      create or replace function public.pagamento_vincular_aluno(p_pagamento_id uuid, p_aluno_id uuid, p_observacao text default null)
      returns jsonb language plpgsql as $$
      begin
        update public.pagamentos set aluno_id = p_aluno_id where id = p_pagamento_id;
        return jsonb_build_object('ok', true, 'conciliacao', jsonb_build_object('status', 'REVISAO'));
      end $$;`);
    const antes = await foto(db);
    await expect(registrar(db, G1, [T1], true)).rejects.toThrow(/RECUPERACAO_ABORTADA/);
    expect(await foto(db)).toEqual(antes);
  });
});

describe("pagamentos_trava", () => {
  it("diz o ponto exato em que cada pagamento travou", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set matricula = null where id = $1`, [G4]);
    const r = await db.query(`select pagamento_id, trava from public.pagamentos_trava($1::uuid[]) order by pagamento_id`,
      [[G1, G2, G3, G4, G5]]);
    const porId = Object.fromEntries(r.rows.map((x) => [x.pagamento_id, x.trava]));
    expect(porId[G1]).toBe("ACORDO_PARCELADO_AUSENTE"); // 72066 tem dois boletos na base (G1 e G3)
    expect(porId[G2]).toBe("ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA"); // o 71752: fora do fluxo normal
    expect(porId[G3]).toBe("ALUNO_NAO_IDENTIFICADO"); // nome repetido
    expect(porId[G4]).toBe("ALUNO_NAO_IDENTIFICADO");
    expect(porId[G5]).toBe("FORA_DO_ESCOPO");
  });

  it("à vista explicado recebe a ação normal", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.pagamentos where id = $1`, [G3]);
    const r = await db.query(`select trava from public.pagamentos_trava($1::uuid[])`, [[G1]]);
    expect(r.rows[0].trava).toBe("ACORDO_AVISTA_AUSENTE");
  });

  it("matrícula e nome únicos, mas de alunos diferentes, é identidade divergente", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set aluno_nome = 'JOÃO SOUZA' where id = $1`, [G2]);
    const r = await db.query(`select trava from public.pagamentos_trava($1::uuid[])`, [[G2]]);
    expect(r.rows[0].trava).toBe("IDENTIDADE_DIVERGENTE");
  });
});
