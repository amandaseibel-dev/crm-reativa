// CONFERENCIA DE PAGAMENTO NA FICHA DO ALUNO -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) aplicando o ARQUIVO da migration.
//
// O QUE ESTE TESTE PROVA
//   * FEITO e REJEITAR gravam nos TRES lugares: fila, auditoria e ficha;
//   * a movimentacao carrega o que a gestao pediu -- decisao, valor, data,
//     boleto, documento, acordo identificado, conclusao/motivo, observacao,
//     quem decidiu e quando;
//   * a movimentacao NAO tem efeito financeiro: nao cria acordo nem parcela,
//     nao baixa, nao mexe em saldo, mensalidade nem status de acordo;
//   * ela NAO conta como acionamento -- com o gatilho REAL de producao montado
//     na bancada, `alunos.data_ultimo_acionamento` continua intocado;
//   * pagamento sem aluno nao gera movimentacao, e a decisao vale do mesmo jeito;
//   * falha ao escrever na ficha nao desfaz a decisao;
//   * a fila devolve acordo identificado, evidencias e saldo.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(AQUI, "..", "migrations", "20260923160000_conferencia_pagamento_na_ficha.sql"), "utf8");

// `eh_tipo_acionamento` e `fn_atualizar_ultimo_acionamento` sao COPIA do que
// roda em producao (lidos de pg_proc em 23/09/2026). Sem eles a bancada
// provaria o contrario do que interessa: que nada acontece porque o gatilho
// nao existe, e nao porque o tipo esta fora da lista.
const BANCADA = `
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='anon')
    then create role anon; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='service_role')
    then create role service_role; end if; end $$;
  create schema if not exists auth;
  create or replace function auth.jwt() returns jsonb language sql stable
    as $$ select jsonb_build_object('email', coalesce(current_setting('teste.email', true), 'amanda.seibel@aelbra.com.br')) $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
  create or replace function public.usuario_e_gestao() returns boolean language sql stable
    as $$ select coalesce(current_setting('teste.gestao', true), 'on') = 'on' $$;

  create table public.alunos (
    id uuid primary key default gen_random_uuid(),
    nome text, matricula text, cpf text, cpf_mascarado text,
    saldo_total numeric, saldo_vencido numeric,
    data_ultimo_acionamento timestamptz
  );
  create table public.casos (
    id uuid primary key default gen_random_uuid(),
    aluno_id uuid, data_ultimo_acionamento date
  );
  create table public.acordos (
    id uuid primary key default gen_random_uuid(),
    numero_ulbra text, status text, saldo numeric
  );
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(),
    acordo_id uuid, numero int, status text, valor numeric, boleto text unique
  );
  create table public.importacoes (
    id uuid primary key default gen_random_uuid(), tipo text, arquivo_nome text,
    created_at timestamp default now()
  );
  create table public.prime_portador_membro (portador int, cpf text);
  create table public.pagamentos (
    id uuid primary key default gen_random_uuid(),
    importacao_id uuid, aluno_id uuid, aluno_nome text, matricula text, cpf text,
    titulo_numero text, numero_parcela_completo text, data_pagamento date,
    valor_pago numeric, valor_honorario numeric, operador_nome text, operador_email text,
    status_conciliacao text, conciliacao_motivo text
  );
  create table public.fila_pagamento_sem_vinculo (
    id bigserial primary key,
    pagamento_id uuid not null unique references public.pagamentos(id) on delete cascade,
    boleto text, motivo text, observacao text, status_conciliacao text,
    sugestoes jsonb default '[]'::jsonb,
    decisao text, decidido_por text, decidido_em timestamptz,
    conclusao text, motivo_rejeicao text,
    evidencia_origem text, evidencia_em timestamptz, consulta_estrutura_resultado text,
    detectado_em timestamptz not null default now(),
    primeira_tentativa_em timestamptz default now(),
    ultima_tentativa_em timestamptz default now(),
    quantidade_tentativas integer not null default 1,
    constraint fila_pag_decisao_coerente check (
      case when decisao = 'FEITO'     then conclusao is not null and motivo_rejeicao is null
           when decisao = 'REJEITADO' then motivo_rejeicao is not null and conclusao is null
           else conclusao is null and motivo_rejeicao is null end)
  );
  create table public.auditoria (
    id uuid primary key default gen_random_uuid(), usuario text, acao text,
    tabela_afetada text, registro_id uuid, detalhes jsonb,
    created_at timestamp default now()
  );
  create table public.aluno_movimentacoes (
    id uuid primary key default gen_random_uuid(),
    aluno_id text not null, tipo text not null, descricao text,
    status_anterior text, status_novo text,
    registrado_por_nome text, registrado_por_email text,
    registrado_em timestamptz not null default now(),
    valor_movimentacao numeric,
    elogio_print_path text, elogio_aprovado_tv boolean, elogio_rejeitado_tv boolean
  );

  -- COPIA DE PRODUCAO
  create or replace function public.eh_tipo_acionamento(p_tipo text) returns boolean
   language sql immutable as $$
    select coalesce(p_tipo,'') in (
      'FINALIZACAO_ATENDIMENTO','FINALIZACAO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL','CONTATO',
      'LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','COMPROVANTE_ENVIADO_BAIXA',
      'QUITADO_MANUAL','TERMO_ENVIADO_ADM','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO');
  $$;
  create or replace function public.fn_atualizar_ultimo_acionamento() returns trigger
   language plpgsql as $$
  declare v_uuid uuid;
  begin
    if not public.eh_tipo_acionamento(new.tipo) then return new; end if;
    if new.tipo in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL') then return new; end if;
    begin v_uuid := new.aluno_id::uuid; exception when others then return new; end;
    update public.alunos a set data_ultimo_acionamento = new.registrado_em
     where a.id = v_uuid
       and (a.data_ultimo_acionamento is null or a.data_ultimo_acionamento < new.registrado_em);
    update public.casos c set data_ultimo_acionamento = new.registrado_em::date
     where c.aluno_id = v_uuid
       and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < new.registrado_em::date);
    return new;
  end; $$;
  create trigger trg_atualizar_ultimo_acionamento after insert on public.aluno_movimentacoes
    for each row execute function public.fn_atualizar_ultimo_acionamento();
`;

const CENARIO = `
  insert into public.alunos (id, nome, matricula, cpf, cpf_mascarado, saldo_total, saldo_vencido, data_ultimo_acionamento)
  values ('aaaaaaaa-0000-0000-0000-000000000001','Ana Conferencia','2320001','60054871085','600.548.710-85',
          5000, 2000, '2026-09-01 10:00:00+00');
  insert into public.casos (aluno_id, data_ultimo_acionamento)
  values ('aaaaaaaa-0000-0000-0000-000000000001','2026-09-01');
  insert into public.prime_portador_membro (portador, cpf) values (166, '60054871085');
  insert into public.importacoes (id, tipo, arquivo_nome) values
    ('11111111-1111-1111-1111-111111111111','PROJECAO_DIARIA','22.09.xlsx');

  insert into public.pagamentos
    (id, importacao_id, aluno_id, aluno_nome, matricula, cpf, titulo_numero,
     numero_parcela_completo, data_pagamento, valor_pago, valor_honorario,
     operador_nome, status_conciliacao, conciliacao_motivo)
  values
    ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Conferencia','2320001','60054871085','72529',
     '50725290001','2026-09-22', 3945.53, 315.64,'Nataly','AGUARDANDO_ACORDO',
     'boleto 50725290001 nao existe em parcelas e o acordo 072529 nao esta no CRM'),
    -- sem aluno: a decisao vale, mas nao ha ficha onde escrever
    ('dddddddd-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
     null,'Fulano do Arquivo','9999','','70002',
     '50700020001','2026-09-20', 120.00, 9.60,'Luana','SEM_VINCULO',
     'boleto fora do padrao');

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, boleto, motivo, status_conciliacao, quantidade_tentativas,
     consulta_estrutura_resultado, evidencia_origem)
  values
    ('dddddddd-0000-0000-0000-000000000001','50725290001','acordo 072529 nao esta no CRM',
     'AGUARDANDO_ACORDO', 4, 'NAO_ENCONTRADA', 'PRIME_PORTADOR_MEMBRO'),
    ('dddddddd-0000-0000-0000-000000000002','50700020001','sem boleto utilizavel',
     'SEM_VINCULO', 1, null, null);
`;

let db;
const PG1 = "dddddddd-0000-0000-0000-000000000001";
const PG2 = "dddddddd-0000-0000-0000-000000000002";

const chamar = async (fn, args) => {
  const r = await db.query(`select public.${fn}($1::uuid, $2::text, $3::text) j`, args);
  return r.rows[0].j;
};
const movimentacoes = async () =>
  (await db.query("select * from public.aluno_movimentacoes order by registrado_em")).rows;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(MIGRATION);
  await db.exec(CENARIO);
});

describe("a decisao humana chega aos tres lugares", () => {
  it("FEITO grava na fila, na auditoria e na ficha", async () => {
    const r = await chamar("conciliacao_feito", [PG1, "ENTRADA_DE_ACORDO", "conferido no extrato"]);
    expect(r.ok).toBe(true);
    expect(r.movimentacao_id).toBeTruthy();

    const fila = (await db.query(
      "select decisao, conclusao, decidido_por from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [PG1])).rows[0];
    expect(fila.decisao).toBe("FEITO");
    expect(fila.conclusao).toBe("ENTRADA_DE_ACORDO");

    const aud = (await db.query(
      "select acao, detalhes from public.auditoria where registro_id=$1", [PG1])).rows[0];
    expect(aud.acao).toBe("CONCILIACAO_FEITO_PELA_GESTAO");
    expect(aud.detalhes.sem_efeito_financeiro).toBe(true);

    const m = await movimentacoes();
    expect(m).toHaveLength(1);
    expect(m[0].tipo).toBe("CONFERENCIA_PAGAMENTO");
    expect(m[0].aluno_id).toBe("aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("a movimentacao traz tudo que a gestao pediu", async () => {
    await chamar("conciliacao_feito", [PG1, "ENTRADA_DE_ACORDO", "conferido no extrato"]);
    const [m] = await movimentacoes();
    const t = m.descricao;
    expect(t).toMatch(/Conferencia de pagamento -- FEITO/);
    expect(t).toMatch(/R\$ 3.945,53/);            // valor
    expect(t).toMatch(/22\/09\/2026/);            // data do pagamento
    expect(t).toMatch(/boleto 50725290001/);      // boleto
    expect(t).toMatch(/documento 72529/);         // documento
    expect(t).toMatch(/Acordo identificado: 072529/); // prefixo do acordo
    expect(t).toMatch(/Conclusao: Confirmado como entrada de acordo/);
    expect(t).toMatch(/Observacao: conferido no extrato/);
    expect(t).toMatch(/Decisao registrada por amanda\.seibel@aelbra\.com\.br em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(t).toMatch(new RegExp(`pagamento_id: ${PG1}`));
    expect(m.registrado_por_email).toBe("amanda.seibel@aelbra.com.br");
  });

  it("REJEITAR grava o motivo na ficha, e nao fala em conclusao", async () => {
    const r = await chamar("conciliacao_rejeitar", [PG1, "NAO_E_ENTRADA_DE_ACORDO", null]);
    expect(r.ok).toBe(true);
    const [m] = await movimentacoes();
    expect(m.descricao).toMatch(/Conferencia de pagamento -- REJEITADO/);
    expect(m.descricao).toMatch(/Motivo: Nao e entrada de acordo/);
    expect(m.descricao).not.toMatch(/Conclusao:/);
    expect(m.descricao).not.toMatch(/Observacao:/);
  });
});

describe("historico, e nada alem disso", () => {
  it("nao cria acordo nem parcela, nao baixa, nao mexe em saldo", async () => {
    const antes = await db.query(`select
      (select count(*) from public.acordos) a,
      (select count(*) from public.parcelas) p,
      (select md5(coalesce(string_agg(id::text||coalesce(saldo_total::text,'-')||coalesce(saldo_vencido::text,'-'), '|' order by id),'')) from public.alunos) al,
      (select md5(coalesce(string_agg(id::text||coalesce(status_conciliacao,'-'), '|' order by id),'')) from public.pagamentos) pg`);
    await chamar("conciliacao_feito", [PG1, "PARCELA_DE_ACORDO", null]);
    const depois = await db.query(`select
      (select count(*) from public.acordos) a,
      (select count(*) from public.parcelas) p,
      (select md5(coalesce(string_agg(id::text||coalesce(saldo_total::text,'-')||coalesce(saldo_vencido::text,'-'), '|' order by id),'')) from public.alunos) al,
      (select md5(coalesce(string_agg(id::text||coalesce(status_conciliacao,'-'), '|' order by id),'')) from public.pagamentos) pg`);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  it("NAO conta como acionamento -- o gatilho real de producao nao age", async () => {
    const antes = (await db.query(
      "select data_ultimo_acionamento from public.alunos where id='aaaaaaaa-0000-0000-0000-000000000001'")).rows[0];
    const antesCaso = (await db.query("select data_ultimo_acionamento from public.casos")).rows[0];
    await chamar("conciliacao_feito", [PG1, "JA_TRATADO", null]);
    const depois = (await db.query(
      "select data_ultimo_acionamento from public.alunos where id='aaaaaaaa-0000-0000-0000-000000000001'")).rows[0];
    const depoisCaso = (await db.query("select data_ultimo_acionamento from public.casos")).rows[0];
    expect(depois).toEqual(antes);
    expect(depoisCaso).toEqual(antesCaso);
    // e a prova de que o gatilho FUNCIONA nesta bancada: um tipo da lista mexe
    await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em)
                    values ('aaaaaaaa-0000-0000-0000-000000000001','CONTATO', now())`);
    const comContato = (await db.query(
      "select data_ultimo_acionamento from public.alunos where id='aaaaaaaa-0000-0000-0000-000000000001'")).rows[0];
    expect(comContato.data_ultimo_acionamento).not.toEqual(antes.data_ultimo_acionamento);
  });

  it("nao preenche valor_movimentacao -- nao entra em soma financeira", async () => {
    await chamar("conciliacao_feito", [PG1, "SEM_IMPACTO_FINANCEIRO", null]);
    const [m] = await movimentacoes();
    expect(m.valor_movimentacao).toBeNull();
    expect(m.status_novo).toBeNull();
  });
});

describe("os casos de borda", () => {
  it("pagamento sem aluno: decisao vale, ficha nao recebe nada", async () => {
    const r = await chamar("conciliacao_rejeitar", [PG2, "DOCUMENTO_INCOMPATIVEL", null]);
    expect(r.ok).toBe(true);
    expect(r.movimentacao_id).toBeNull();
    expect(await movimentacoes()).toHaveLength(0);
    const fila = (await db.query(
      "select decisao, motivo_rejeicao from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [PG2])).rows[0];
    expect(fila.decisao).toBe("REJEITADO");
  });

  it("falha ao escrever na ficha nao desfaz a decisao", async () => {
    await db.exec("alter table public.aluno_movimentacoes add constraint quebra check (tipo <> 'CONFERENCIA_PAGAMENTO')");
    const r = await chamar("conciliacao_feito", [PG1, "JA_TRATADO", null]);
    expect(r.ok).toBe(true);
    expect(r.movimentacao_id).toBeNull();
    const fila = (await db.query(
      "select decisao from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [PG1])).rows[0];
    expect(fila.decisao).toBe("FEITO");
  });

  it("as validacoes continuam: sem categoria, sem observacao no outro, sem gestao", async () => {
    await expect(chamar("conciliacao_feito", [PG1, "", null])).rejects.toThrow(/exige a conclusao/i);
    await expect(chamar("conciliacao_feito", [PG1, "OUTRO_CONFIRMADO", null])).rejects.toThrow(/exige observacao/i);
    await expect(chamar("conciliacao_rejeitar", [PG1, "OUTRO", null])).rejects.toThrow(/exige observacao/i);
    await db.exec("set teste.gestao = 'off'");
    await expect(chamar("conciliacao_feito", [PG1, "JA_TRATADO", null])).rejects.toThrow(/gestao/i);
  });

  it("decidida uma vez, nao decide de novo -- e nao duplica a ficha", async () => {
    await chamar("conciliacao_feito", [PG1, "JA_TRATADO", null]);
    const r = await chamar("conciliacao_rejeitar", [PG1, "VALOR_INCOMPATIVEL", null]);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("SEM_PENDENCIA_ABERTA");
    expect(await movimentacoes()).toHaveLength(1);
  });
});

describe("a fila mostra o que falta para conferir", () => {
  it("devolve acordo identificado, evidencias e saldo", async () => {
    const r = await db.query("select * from public.pagamentos_sem_aluno(null, true) order by valor_pago desc");
    const linha = r.rows.find((x) => x.pagamento_id === PG1);
    expect(linha.acordo_identificado).toBe("072529");
    expect(Number(linha.saldo_total)).toBe(5000);
    expect(Number(linha.saldo_vencido)).toBe(2000);
    const ev = linha.evidencias;
    expect(ev.acordo_prefixo).toBe("072529");
    expect(ev.acordo_no_crm).toBe(false);          // o acordo nao esta no CRM
    expect(ev.parcela_com_este_boleto).toBe(false);
    expect(ev.cpf_no_portador_166).toBe(true);     // negociacao provada no 166
    expect(ev.consulta_estrutura).toBe("NAO_ENCONTRADA");
    expect(ev.evidencia_origem).toBe("PRIME_PORTADOR_MEMBRO");
    expect(ev.tentativas).toBe(4);
    expect(ev.documento).toBe("72529");
  });

  it("quando o acordo existe no CRM, a evidencia diz isso", async () => {
    await db.exec(`
      insert into public.acordos (id, numero_ulbra, status) values ('bbbbbbbb-0000-0000-0000-000000000001','72529','ATIVO');
      insert into public.parcelas (acordo_id, numero, status, valor, boleto)
      values ('bbbbbbbb-0000-0000-0000-000000000001', 1, 'VENCIDA', 3945.53, '50725290001');`);
    const r = await db.query("select * from public.pagamentos_sem_aluno(null, true)");
    const ev = r.rows.find((x) => x.pagamento_id === PG1).evidencias;
    expect(ev.acordo_no_crm).toBe(true);
    expect(ev.acordo_status).toBe("ATIVO");
    expect(ev.parcela_com_este_boleto).toBe(true);
    expect(ev.parcela_status).toBe("VENCIDA");
  });

  it("boleto fora do padrao de 11 digitos nao inventa acordo", async () => {
    await db.exec("update public.pagamentos set numero_parcela_completo = '123' where id = '" + PG2 + "'");
    const r = await db.query("select * from public.pagamentos_sem_aluno(null, true)");
    const linha = r.rows.find((x) => x.pagamento_id === PG2);
    expect(linha.acordo_identificado).toBeNull();
    expect(linha.evidencias.acordo_prefixo).toBeNull();
    expect(linha.saldo_total).toBeNull();
  });
});
