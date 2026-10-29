// A FILA VOLTOU A ABRIR: FILTRAR ANTES DE ENRIQUECER -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) aplicando os DOIS arquivos, um depois do outro.
//
// O teste que importa aqui NAO e "a consulta e rapida" -- com meia duzia de
// linhas de bancada qualquer plano e rapido, e afirmar velocidade daqui seria
// mentira. O que se prova e que a correcao NAO MUDOU NADA do que a tela recebe:
//
//   * a versao nova devolve exatamente as mesmas linhas, nos mesmos valores e
//     na mesma ordem que a versao que estava em producao -- comparacao linha a
//     linha, nos tres modos (mes corrente, todos os meses, mes sem nada);
//   * a CTE da populacao e `materialized`, que E a correcao e some sem avisar
//     se alguem reescrever a consulta;
//   * os grants sobreviveram -- `create or replace` na mesma assinatura, ao
//     contrario da migration anterior, que precisou de drop e reconcessao;
//   * o portao da gestao continua de pe.
//
// A prova de velocidade fica onde ela existe de verdade: no cabecalho da
// migration, com os numeros medidos no banco de PRODUCAO (29.308 ms -> 1.290 ms).
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const migracao = (nome) => readFileSync(join(AQUI, "..", "migrations", nome), "utf8");
const VERSAO_ANTIGA = migracao("20260923160000_conferencia_pagamento_na_ficha.sql");
const VERSAO_NOVA = migracao("20260923170000_fila_pagamentos_filtra_antes_de_enriquecer.sql");

const BANCADA = `
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='anon')
    then create role anon; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='service_role')
    then create role service_role; end if; end $$;
  create schema if not exists auth;
  create or replace function auth.jwt() returns jsonb language sql stable
    as $$ select '{"email":"amanda.seibel@aelbra.com.br"}'::jsonb $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
  create or replace function public.usuario_e_gestao() returns boolean language sql stable
    as $$ select coalesce(current_setting('teste.gestao', true), 'on') = 'on' $$;
  create or replace function public.eh_tipo_acionamento(p_tipo text) returns boolean
   language sql immutable as $$ select coalesce(p_tipo,'') in ('CONTATO') $$;

  create table public.alunos (
    id uuid primary key default gen_random_uuid(),
    nome text, matricula text, cpf text, cpf_mascarado text,
    saldo_total numeric, saldo_vencido numeric, data_ultimo_acionamento timestamptz
  );
  create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid, data_ultimo_acionamento date);
  create table public.acordos (
    id uuid primary key default gen_random_uuid(), numero_ulbra text, status text, saldo numeric);
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(), acordo_id uuid, numero int,
    status text, valor numeric, boleto text unique);
  create table public.importacoes (
    id uuid primary key default gen_random_uuid(), tipo text, arquivo_nome text,
    created_at timestamp default now());
  create table public.prime_portador_membro (portador int, cpf text);
  create table public.pagamentos (
    id uuid primary key default gen_random_uuid(),
    importacao_id uuid, aluno_id uuid, aluno_nome text, matricula text, cpf text,
    titulo_numero text, numero_parcela_completo text, data_pagamento date,
    valor_pago numeric, valor_honorario numeric, operador_nome text, operador_email text,
    status_conciliacao text, conciliacao_motivo text);
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
           else conclusao is null and motivo_rejeicao is null end));
  create table public.auditoria (
    id uuid primary key default gen_random_uuid(), usuario text, acao text,
    tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamp default now());
  create table public.aluno_movimentacoes (
    id uuid primary key default gen_random_uuid(),
    aluno_id text not null, tipo text not null, descricao text,
    status_anterior text, status_novo text,
    registrado_por_nome text, registrado_por_email text,
    registrado_em timestamptz not null default now(), valor_movimentacao numeric);
`;

// Uma linha de cada forma que a fila conhece, para a comparacao entre as duas
// versoes ter o que diferenciar: com e sem aluno, com e sem acordo no CRM, com
// e sem parcela, boleto fora do padrao, homonimo, decidida (sai da fila) e de
// outro mes.
const CENARIO = `
  insert into public.alunos (id, nome, matricula, cpf, cpf_mascarado, saldo_total, saldo_vencido) values
    ('aaaaaaaa-0000-0000-0000-000000000001','Ana Conferencia','2320001','60054871085','600.548.710-85', 5000, 2000),
    ('aaaaaaaa-0000-0000-0000-000000000002','Bruno Homonimo','2320002','11122233344','111.222.333-44', 0, 0),
    ('aaaaaaaa-0000-0000-0000-000000000003','Bruno Homonimo','2320003','99988877766','999.888.777-66', 700, 0);
  insert into public.prime_portador_membro (portador, cpf) values (166, '60054871085');
  insert into public.importacoes (id, tipo, arquivo_nome) values
    ('11111111-1111-1111-1111-111111111111','PROJECAO_DIARIA','22.09.xlsx');
  insert into public.acordos (id, numero_ulbra, status) values
    ('bbbbbbbb-0000-0000-0000-000000000001','71861','ATIVO'),
    ('bbbbbbbb-0000-0000-0000-000000000002','71862','CANCELADO');
  insert into public.parcelas (acordo_id, numero, status, valor, boleto) values
    ('bbbbbbbb-0000-0000-0000-000000000001', 2, 'PAGO', 300.00, '50718610001');

  insert into public.pagamentos
    (id, importacao_id, aluno_id, aluno_nome, matricula, cpf, titulo_numero,
     numero_parcela_completo, data_pagamento, valor_pago, valor_honorario,
     operador_nome, operador_email, status_conciliacao, conciliacao_motivo)
  values
    -- com aluno, sem acordo no CRM, CPF no 166
    ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Conferencia','2320001','60054871085','72529',
     '50725290001','2026-09-22', 3945.53, 315.64,'Nataly','n@x','AGUARDANDO_ACORDO','acordo 072529 fora do CRM'),
    -- com aluno, acordo ATIVO no CRM e parcela existente
    ('dddddddd-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Conferencia','2320001','60054871085','71861',
     '50718610001','2026-09-21', 300.00, 24.00,'Olga','o@x','PARCELA_JA_PAGA','parcela ja paga'),
    -- acordo CANCELADO no CRM: nao conta como "acordo no CRM"
    ('dddddddd-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Conferencia','2320001','60054871085','71862',
     '50718620001','2026-09-20', 150.00, 12.00,'Olga','o@x','REVISAO','acordo cancelado'),
    -- SEM aluno, nome com homonimo, boleto fora do padrao
    ('dddddddd-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
     null,'Bruno Homonimo','9999','','70004',
     '123','2026-09-19', 120.00, 9.60,'Luana','l@x','SEM_VINCULO','boleto fora do padrao'),
    -- ja decidida: nao entra na fila ativa
    ('dddddddd-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000002','Bruno Homonimo','2320002','11122233344','70005',
     '50700050001','2026-09-18', 90.00, 7.20,'Luana','l@x','AGUARDANDO_ACORDO','ja decidida'),
    -- de outro mes
    ('dddddddd-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',
     null,'Ana Conferencia','2320001','60054871085','70006',
     '50700060001','2026-08-15', 500.00, 40.00,'Nataly','n@x','SEM_VINCULO','mes anterior');

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, boleto, motivo, status_conciliacao, quantidade_tentativas,
     consulta_estrutura_resultado, evidencia_origem, sugestoes,
     decisao, conclusao)
  values
    ('dddddddd-0000-0000-0000-000000000001','50725290001','acordo 072529 fora do CRM','AGUARDANDO_ACORDO',4,'NAO_ENCONTRADA','PRIME_PORTADOR_MEMBRO','[{"nome":"Ana"}]'::jsonb, null, null),
    ('dddddddd-0000-0000-0000-000000000002','50718610001','parcela ja paga','PARCELA_JA_PAGA',2,null,null,'[]'::jsonb, null, null),
    ('dddddddd-0000-0000-0000-000000000003','50718620001','acordo cancelado','REVISAO',1,null,null,'[]'::jsonb, null, null),
    ('dddddddd-0000-0000-0000-000000000005','50700050001','ja decidida','AGUARDANDO_ACORDO',3,null,null,'[]'::jsonb, 'FEITO','JA_TRATADO');
`;

let db;

const chamar = async (mes, todos) => {
  const r = await db.query(
    "select * from public.pagamentos_sem_aluno($1::text, $2::boolean)", [mes, todos]);
  return r.rows;
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(VERSAO_ANTIGA);
  await db.exec(CENARIO);
});

describe("a correcao nao muda nada do que a tela recebe", () => {
  it.each([
    ["mês corrente", "2026-09", false],
    ["todos os meses", null, true],
    ["mês sem nada", "2026-01", false],
    ["mês anterior", "2026-08", false],
  ])("%s: mesma saída antes e depois", async (_nome, mes, todos) => {
    const antes = await chamar(mes, todos);
    await db.exec(VERSAO_NOVA);
    const depois = await chamar(mes, todos);
    expect(depois).toEqual(antes);
  });

  it("a fila ativa continua sendo a mesma, e a decidida segue fora", async () => {
    await db.exec(VERSAO_NOVA);
    const linhas = await chamar(null, true);
    const ids = linhas.map((l) => l.pagamento_id).sort();
    expect(ids).toEqual([
      "dddddddd-0000-0000-0000-000000000001",
      "dddddddd-0000-0000-0000-000000000003",
      "dddddddd-0000-0000-0000-000000000004",
      "dddddddd-0000-0000-0000-000000000006",
      // a 2 tem aluno E fila aberta, entao entra tambem
      "dddddddd-0000-0000-0000-000000000002",
    ].sort());
    expect(ids).not.toContain("dddddddd-0000-0000-0000-000000000005");
  });

  it("as evidências continuam certas depois da correção", async () => {
    await db.exec(VERSAO_NOVA);
    const linhas = await chamar(null, true);
    const porId = Object.fromEntries(linhas.map((l) => [l.pagamento_id, l]));

    const semAcordo = porId["dddddddd-0000-0000-0000-000000000001"];
    expect(semAcordo.acordo_identificado).toBe("072529");
    expect(semAcordo.evidencias.acordo_no_crm).toBe(false);
    expect(semAcordo.evidencias.cpf_no_portador_166).toBe(true);
    expect(Number(semAcordo.saldo_total)).toBe(5000);

    const comAcordo = porId["dddddddd-0000-0000-0000-000000000002"];
    expect(comAcordo.evidencias.acordo_no_crm).toBe(true);
    expect(comAcordo.evidencias.acordo_status).toBe("ATIVO");
    expect(comAcordo.evidencias.parcela_com_este_boleto).toBe(true);
    expect(comAcordo.evidencias.parcela_status).toBe("PAGO");

    // acordo CANCELADO nao conta como acordo no CRM -- a fila existe por causa disso
    expect(porId["dddddddd-0000-0000-0000-000000000003"].evidencias.acordo_no_crm).toBe(false);

    // boleto fora do padrao de 11 digitos nao inventa acordo, e sem aluno nao ha saldo
    const foraDoPadrao = porId["dddddddd-0000-0000-0000-000000000004"];
    expect(foraDoPadrao.acordo_identificado).toBeNull();
    expect(foraDoPadrao.saldo_total).toBeNull();
    expect(foraDoPadrao.candidatos).toBe(2); // dois "Bruno Homonimo" no cadastro
    expect(foraDoPadrao.motivo).toBe("NOME_REPETIDO");
  });
});

describe("a correção em si", () => {
  it("a população é uma CTE materialized -- é isso que evita o timeout", async () => {
    await db.exec(VERSAO_NOVA);
    const r = await db.query(
      "select prosrc from pg_proc where oid='public.pagamentos_sem_aluno(text,boolean)'::regprocedure");
    expect(r.rows[0].prosrc).toMatch(/base\s+as\s+materialized/i);
  });

  it("o enriquecimento lê de `base`, não da tabela inteira", async () => {
    await db.exec(VERSAO_NOVA);
    const r = await db.query(
      "select prosrc from pg_proc where oid='public.pagamentos_sem_aluno(text,boolean)'::regprocedure");
    // as laterais se correlacionam com o alias da CTE (b.), nunca com p.
    expect(r.rows[0].prosrc).toMatch(/upper\(trim\(coalesce\(b\.aluno_nome/);
    expect(r.rows[0].prosrc).not.toMatch(/upper\(trim\(coalesce\(p\.aluno_nome/);
  });

  it("os grants sobreviveram à substituição", async () => {
    await db.exec(VERSAO_NOVA);
    const r = await db.query(`select
      has_function_privilege('authenticated','public.pagamentos_sem_aluno(text,boolean)','EXECUTE') a,
      has_function_privilege('anon','public.pagamentos_sem_aluno(text,boolean)','EXECUTE') b`);
    expect(r.rows[0].a).toBe(true);
    expect(r.rows[0].b).toBe(false);
  });

  it("quem não é da gestão continua sem ler a fila", async () => {
    await db.exec(VERSAO_NOVA);
    await db.exec("set teste.gestao = 'off'");
    await expect(chamar(null, true)).rejects.toThrow(/gestao financeira/i);
  });
});
