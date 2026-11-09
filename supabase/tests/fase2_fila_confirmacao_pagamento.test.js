// FASE 2 -- FILA UNICA DE CONFIRMACAO DE PAGAMENTOS: comportamento sobre PostgreSQL real.
//
// Roda a migration REAL (nao aplicada em producao) num PostgreSQL real (PGlite), sobre
// uma bancada que reproduz o que importa de producao:
//   * os papeis anon/authenticated/service_role E o ALTER DEFAULT PRIVILEGES de `public`
//     que concede TUDO a eles -- sem isso o teste de grants seria inerte, porque nao
//     haveria privilegio herdado para a migration revogar;
//   * `ux_parcelas_boleto` como UNIQUE parcial, que e o que faz BOLETO_EXATO ser prova;
//   * `normalizar_nome_pessoa` com o corpo exato de producao.
//
// ANCORAS DE DATA FIXAS. Nenhum `now()`, `current_date` ou "hoje" decide resultado: o
// corte e sempre a data literal 2026-10-01 e os pagamentos tem datas literais. Esta
// maquina roda em BRT e o CI em UTC; teste que depende do dia em que roda ja quebrou o
// CI deste projeto duas vezes.
//
// NENHUM DADO REAL. Nomes, CPFs e valores reproduzem a FORMA dos casos, nao a
// identidade de ninguem.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20261020140500_fase2_fila_confirmacao_pagamento.sql");
const ROLLBACK = ler("supabase/rollbacks/20261020140500_fase2_fila_confirmacao_pagamento.rollback.sql");

const CORTE = "2026-10-01";

const ALUNO_A = "11111111-0000-4000-8000-000000000001";
const ALUNO_B = "11111111-0000-4000-8000-000000000002";
const ALUNO_GEMEO_1 = "11111111-0000-4000-8000-000000000003";
const ALUNO_GEMEO_2 = "11111111-0000-4000-8000-000000000004";

const ACORDO_A = "22222222-0000-4000-8000-000000000001";
const ACORDO_B = "22222222-0000-4000-8000-000000000002";
const ACORDO_PREF = "22222222-0000-4000-8000-000000000003";

const PARCELA_A = "33333333-0000-4000-8000-000000000001"; // boleto exato, limpa
const PARCELA_B = "33333333-0000-4000-8000-000000000002"; // boleto exato, com baixa viva
const PARCELA_REF = "33333333-0000-4000-8000-000000000003"; // origem_baixa_ref aponta o credito
const PARCELA_PREF = "33333333-0000-4000-8000-000000000004"; // resolve so por prefixo

const PAG_BOLETO = "44444444-0000-4000-8000-000000000001";
const PAG_NOME = "44444444-0000-4000-8000-000000000002";
const PAG_CPF_DUPLO = "44444444-0000-4000-8000-000000000003";
const PAG_FORA_CORTE = "44444444-0000-4000-8000-000000000004";
const PAG_DUPLA_BAIXA = "44444444-0000-4000-8000-000000000005";
const PAG_JA_BAIXADO = "44444444-0000-4000-8000-000000000006";
const PAG_REIMPORTADO = "44444444-0000-4000-8000-000000000007";
const PAG_PREFIXO = "44444444-0000-4000-8000-000000000008";
const PAG_SEM_NADA = "44444444-0000-4000-8000-000000000009";

const BOLETO_A = "50123450001";
const BOLETO_B = "50123450002";
const BOLETO_PREF = "50999990007";

const TABELAS_DE_FORA = [
  "pagamentos", "parcelas", "acordos", "alunos", "baixas_pagamento",
  "links_pagamento", "solicitacao_confirmacao_pagamentos", "fluxo_pagamentos_config",
];

async function bancoComoProducao() {
  const db = await PGlite.create();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    -- O default privilege de producao. E ele que faz tabela e funcao novas nascerem
    -- abertas (inclusive com TRUNCATE) sem ninguem escrever um grant.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

    create table public.alunos (
      id uuid primary key, nome text, cpf text, nome_normalizado text, status_atual text);

    create table public.acordos (
      id uuid primary key, aluno_id uuid, numero_acordo bigint, numero_ulbra text,
      status text default 'ATIVO');

    create table public.parcelas (
      id uuid primary key, acordo_id uuid, numero int, boleto text, valor numeric,
      status text default 'ABERTO', origem_baixa text, origem_baixa_ref text,
      origem_baixa_em timestamptz);
    -- O indice que faz BOLETO_EXATO ser prova, na forma exata de producao.
    create unique index ux_parcelas_boleto on public.parcelas (boleto) where boleto is not null;

    create table public.pagamentos (
      id uuid primary key, aluno_id uuid, cpf text, data_pagamento date, valor_pago numeric,
      tipo_pagamento text, importacao_id uuid, created_at timestamptz default now(),
      operador_email text, aluno_nome text, titulo_numero text, matricula text,
      numero_parcela_completo text, origem_vinculo text, origem_vinculo_ref text,
      origem_vinculo_em timestamptz, status_conciliacao text, conciliacao_motivo text,
      conciliacao_em timestamptz, dados jsonb);

    create table public.baixas_pagamento (
      id uuid primary key default gen_random_uuid(), aluno_id text, parcela_id uuid,
      acordo_id uuid, valor_pago numeric, status_baixa text not null,
      baixado_em timestamptz, devolvido_em timestamptz, data_pagamento date);

    create table public.links_pagamento (
      id uuid primary key default gen_random_uuid(), aluno_id text, valor numeric,
      valor_pago numeric, status text, pago_em timestamptz);

    create table public.solicitacao_confirmacao_pagamentos (
      confirmacao_id uuid, pagamento_id uuid not null, criado_em timestamptz, origem text);

    create table public.fluxo_pagamentos_config (
      etapa text primary key, ligado boolean not null default false, observacao text,
      alterado_em timestamptz, alterado_por text);

    -- Corpo EXATO de producao (SQL, IMMUTABLE): a fila normaliza os dois lados com ele.
    create function public.normalizar_nome_pessoa(p text) returns text
      language sql immutable set search_path to 'public' as $f$
      select translate(upper(regexp_replace(trim(coalesce(p,'')),'\\s+',' ','g')),
        'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC');
    $f$;

    create function public.usuario_e_gestao() returns boolean
      language sql stable set search_path to 'public' as $f$ select false $f$;

    -- Tabela gemea, criada na bancada e NUNCA endurecida. Serve de controle: se ela
    -- nao nascer com TRUNCATE para authenticated, o default privilege acima nao esta
    -- valendo e o teste de grants da fila nao provaria nada.
    create table public.gemea_sem_revoke (id int primary key);
  `);
  return db;
}

async function comDados(db) {
  await db.exec(`
    insert into public.alunos (id, nome, cpf) values
      ('${ALUNO_A}', 'Maria Souza Lima',  '10000000001'),
      ('${ALUNO_B}', 'Joao Pereira Alves','10000000002'),
      ('${ALUNO_GEMEO_1}', 'Ana Clara Dias','10000000003'),
      ('${ALUNO_GEMEO_2}', 'Ana C. Dias',   '10000000003');

    insert into public.acordos (id, aluno_id, numero_acordo, numero_ulbra) values
      ('${ACORDO_A}', '${ALUNO_A}', 12345, null),
      ('${ACORDO_B}', '${ALUNO_B}', 12346, null),
      ('${ACORDO_PREF}', '${ALUNO_B}', 99999, null);

    insert into public.parcelas (id, acordo_id, numero, boleto, valor) values
      ('${PARCELA_A}',    '${ACORDO_A}', 1, '${BOLETO_A}', 500.00),
      ('${PARCELA_B}',    '${ACORDO_B}', 1, '${BOLETO_B}', 700.00),
      ('${PARCELA_PREF}', '${ACORDO_PREF}', 1, '${BOLETO_PREF}', 300.00);

    insert into public.parcelas (id, acordo_id, numero, boleto, valor, origem_baixa, origem_baixa_ref)
      values ('${PARCELA_REF}', '${ACORDO_A}', 2, null, 450.00,
              'GATILHO_IMPORTACAO', '${PAG_JA_BAIXADO}');

    -- baixa VIVA na parcela B, sem nada que a amarre a um credito especifico
    insert into public.baixas_pagamento (parcela_id, status_baixa, valor_pago, devolvido_em)
      values ('${PARCELA_B}', 'REALIZADA', 700.00, null);

    insert into public.pagamentos
      (id, aluno_id, cpf, data_pagamento, valor_pago, aluno_nome, numero_parcela_completo,
       origem_vinculo, status_conciliacao, importacao_id) values
      -- boleto exato, valor igual ao da parcela, parcela limpa -> A_CONFIRMAR
      ('${PAG_BOLETO}', null, null, date '2026-10-05', 500.00, 'Maria Souza Lima',
       '${BOLETO_A}', 'BOLETO_EXATO', 'BAIXADO', null),
      -- so o nome resolve -> FRACA, PRECISA_ANALISE
      ('${PAG_NOME}', null, null, date '2026-10-06', 123.45, 'Joao Pereira Alves',
       null, 'SEM_VINCULO', null, null),
      -- CPF em duas fichas -> SEM_IDENTIFICACAO (D1)
      ('${PAG_CPF_DUPLO}', null, '100.000.000-03', date '2026-10-07', 222.00, 'Nome Que Nao Casa',
       null, 'SEM_VINCULO', null, null),
      -- antes do corte -> nunca entra na fila
      ('${PAG_FORA_CORTE}', null, null, date '2026-09-20', 999.00, 'Maria Souza Lima',
       null, 'SEM_VINCULO', null, null),
      -- boleto exato numa parcela que JA tem baixa viva -> alerta de dupla baixa
      ('${PAG_DUPLA_BAIXA}', null, null, date '2026-10-08', 700.00, 'Joao Pereira Alves',
       '${BOLETO_B}', 'BOLETO_EXATO', null, null),
      -- a parcela aponta ESTE credito em origem_baixa_ref -> CONFIRMADO
      ('${PAG_JA_BAIXADO}', null, null, date '2026-10-09', 450.00, 'Maria Souza Lima',
       null, 'SEM_VINCULO', null, null),
      -- mesma movimentacao do PAG_BOLETO chegando de novo -> DUPLICADO_IGNORADO
      ('${PAG_REIMPORTADO}', null, null, date '2026-10-05', 500.00, 'Maria Souza Lima',
       '${BOLETO_A}', 'BOLETO_EXATO', null, null),
      -- boleto que nao existe em parcelas, mas cujo prefixo resolve UM acordo
      ('${PAG_PREFIXO}', null, null, date '2026-10-10', 300.00, 'Nome Que Nao Casa',
       '50999990001', 'PREFIXO_UNICO', null, null),
      -- nada resolve
      ('${PAG_SEM_NADA}', null, null, date '2026-10-11', 77.00, null,
       null, 'SEM_VINCULO', null, null);
  `);
}

const um = async (db, sql, params = []) => {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
};

const ligar = (db) =>
  db.exec(`update public.fluxo_pagamentos_config set ligado = true
            where etapa = 'fila_confirmacao_enfileirar';`);

const item = async (db, pagamentoId) =>
  (await db.query(
    `select estado, forca_evidencia, fonte_evidencia, aluno_sugerido_id, parcela_sugerida_id,
            valor_esperado, motivo, chave_movimentacao
       from public.fila_confirmacao_pagamento where pagamento_id = $1`, [pagamentoId])).rows[0];

const enfileirarLote = (db, corte = CORTE, limite = 500, prefixoForte = false) =>
  um(db, `select public.confirmacao_fila_enfileirar_lote($1::date, $2::int, $3::boolean)`,
     [corte, limite, prefixoForte]);

// Foto do banco FORA da fila: conteudo (md5 das linhas) e contagem, por tabela.
async function fotoDeFora(db) {
  const foto = {};
  for (const t of TABELAS_DE_FORA) {
    foto[t] = (await db.query(
      `select coalesce(md5(string_agg(t::text, '|' order by t::text)), 'VAZIA') h,
              count(*)::int n from public.${t} t`)).rows[0];
  }
  return foto;
}

describe("Fase 2 -- fila de confirmação de pagamentos (migration NÃO aplicada)", () => {
  let db;
  beforeEach(async () => {
    db = await bancoComoProducao();
    await db.exec(MIGRATION);
    await comDados(db);
  });

  // -------------------------------------------------------------------------
  describe("a âncora: UNIQUE (pagamento_id)", () => {
    it("recusa um segundo item para a mesma movimentação -- é índice, não lógica", async () => {
      await db.exec(`
        insert into public.fila_confirmacao_pagamento
          (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia, motivo)
        values ('${PAG_NOME}', 'BOL:x:1.00:2026-10-06', 'PRECISA_ANALISE', 'FRACA', 'NOME_UNICO', 'x');`);

      await expect(db.exec(`
        insert into public.fila_confirmacao_pagamento
          (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia, motivo)
        values ('${PAG_NOME}', 'OUTRA:CHAVE', 'PRECISA_ANALISE', 'FRACA', 'NOME_UNICO', 'y');`))
        .rejects.toThrow(/fila_confirmacao_pagamento_unico/);
    });

    it("a unicidade existe como constraint nomeada, não como convenção", async () => {
      expect(await um(db, `
        select pg_get_constraintdef(oid) from pg_constraint
         where conname = 'fila_confirmacao_pagamento_unico'`)).toBe("UNIQUE (pagamento_id)");
    });
  });

  // -------------------------------------------------------------------------
  describe("os CHECK de estado e de força de evidência", () => {
    const insere = (estado, forca, fonte, extra = "") => db.exec(`
      insert into public.fila_confirmacao_pagamento
        (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia,
         aluno_sugerido_id, motivo ${extra ? "," + extra.split("=")[0] : ""})
      values ('${PAG_NOME}', 'CH:1', '${estado}', '${forca}', '${fonte}',
         '${ALUNO_A}', 'motivo' ${extra ? "," + extra.split("=")[1] : ""});`);

    it("recusa estado inválido", async () => {
      await expect(insere("EM_ANDAMENTO", "FORTE", "BOLETO_EXATO"))
        .rejects.toThrow(/fila_confirmacao_estado_valido/);
    });

    it("recusa força de evidência inválida", async () => {
      await expect(insere("PRECISA_ANALISE", "MEDIA", "BOLETO_EXATO"))
        .rejects.toThrow(/fila_confirmacao_forca_valida/);
    });

    it("recusa fonte de evidência fora da matriz", async () => {
      await expect(insere("PRECISA_ANALISE", "FRACA", "ACHISMO"))
        .rejects.toThrow(/fila_confirmacao_fonte_valida/);
    });

    it("FRACA não pode nascer A_CONFIRMAR -- a promoção é impossível no banco", async () => {
      await expect(insere("A_CONFIRMAR", "FRACA", "NOME_UNICO"))
        .rejects.toThrow(/fila_confirmacao_so_forte_sai_da_analise/);
    });

    it("SEM_IDENTIFICACAO não pode nascer CONFIRMADO", async () => {
      await expect(insere("CONFIRMADO", "SEM_IDENTIFICACAO", "CPF"))
        .rejects.toThrow(/fila_confirmacao_so_forte_sai_da_analise/);
    });

    it("nenhuma rotina promove depois: UPDATE de FRACA para A_CONFIRMAR é recusado", async () => {
      await insere("PRECISA_ANALISE", "FRACA", "NOME_UNICO");
      await expect(db.exec(`
        update public.fila_confirmacao_pagamento set estado = 'A_CONFIRMAR'
         where pagamento_id = '${PAG_NOME}';`))
        .rejects.toThrow(/fila_confirmacao_so_forte_sai_da_analise/);
      // e nem trocando a força junto, sem decisão humana registrada: a força muda,
      // mas quem promove tem de registrar quem promoveu -- o que a tela da gestão fará.
      expect(await um(db, `select forca_evidencia from public.fila_confirmacao_pagamento
                            where pagamento_id = '${PAG_NOME}'`)).toBe("FRACA");
    });

    it("evidência não FORTE exige motivo em texto", async () => {
      await expect(db.exec(`
        insert into public.fila_confirmacao_pagamento
          (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia)
        values ('${PAG_NOME}', 'CH:1', 'PRECISA_ANALISE', 'SEM_IDENTIFICACAO', 'NENHUMA');`))
        .rejects.toThrow(/fila_confirmacao_fraca_tem_motivo/);
    });

    it("NAO_IDENTIFICADO exige decisão humana registrada e motivo", async () => {
      await expect(insere("NAO_IDENTIFICADO", "SEM_IDENTIFICACAO", "NENHUMA"))
        .rejects.toThrow(/fila_confirmacao_nao_identificado_e_humano/);

      await db.exec(`
        insert into public.fila_confirmacao_pagamento
          (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia,
           motivo, decidido_por, decidido_em)
        values ('${PAG_NOME}', 'CH:1', 'NAO_IDENTIFICADO', 'SEM_IDENTIFICACAO', 'NENHUMA',
                'nao da para vincular: boleto nao existe em parcelas',
                'amanda.seibel@aelbra.com.br', timestamptz '2026-10-20 12:00:00+00');`);
      expect(await um(db, `select count(*)::int from public.fila_confirmacao_pagamento`)).toBe(1);
    });

    it("A_CONFIRMAR sem aluno resolvido é recusado", async () => {
      await expect(db.exec(`
        insert into public.fila_confirmacao_pagamento
          (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia, motivo)
        values ('${PAG_NOME}', 'CH:1', 'A_CONFIRMAR', 'FORTE', 'BOLETO_EXATO', 'm');`))
        .rejects.toThrow(/fila_confirmacao_identificado_tem_aluno/);
    });
  });

  // -------------------------------------------------------------------------
  describe("a etapa nasce desligada", () => {
    it("a migration deixa ligado = false", async () => {
      expect(await um(db, `select ligado from public.fluxo_pagamentos_config
                            where etapa = 'fila_confirmacao_enfileirar'`)).toBe(false);
    });

    it("desligada, o populador não escreve NADA -- nem na fila", async () => {
      const antes = await fotoDeFora(db);
      expect((await enfileirarLote(db)).motivo).toBe("ETAPA_DESLIGADA");
      expect(await um(db, `select public.confirmacao_fila_enfileirar_um('${PAG_BOLETO}'::uuid)`))
        .toMatchObject({ ok: false, motivo: "ETAPA_DESLIGADA" });
      expect(await um(db, `select count(*)::int from public.fila_confirmacao_pagamento`)).toBe(0);
      expect(await fotoDeFora(db)).toEqual(antes);
    });
  });

  // -------------------------------------------------------------------------
  describe("a matriz de força de evidência", () => {
    beforeEach(async () => { await ligar(db); await enfileirarLote(db); });

    it("BOLETO_EXATO é FORTE e nasce A_CONFIRMAR", async () => {
      expect(await item(db, PAG_BOLETO)).toMatchObject({
        estado: "A_CONFIRMAR", forca_evidencia: "FORTE", fonte_evidencia: "BOLETO_EXATO",
        aluno_sugerido_id: ALUNO_A, parcela_sugerida_id: PARCELA_A,
      });
    });

    it("nome único é FRACA, vai para análise e diz que é só o nome", async () => {
      const i = await item(db, PAG_NOME);
      expect(i.forca_evidencia).toBe("FRACA");
      expect(i.estado).toBe("PRECISA_ANALISE");
      expect(i.fonte_evidencia).toBe("NOME_UNICO");
      expect(i.aluno_sugerido_id).toBe(ALUNO_B);         // a sugestão é útil, não se joga fora
      expect(i.motivo).toMatch(/somente pelo nome/i);
    });

    it("CPF em duas fichas é SEM_IDENTIFICACAO, com a contagem no motivo (D1)", async () => {
      const i = await item(db, PAG_CPF_DUPLO);
      expect(i.forca_evidencia).toBe("SEM_IDENTIFICACAO");
      expect(i.estado).toBe("PRECISA_ANALISE");
      expect(i.aluno_sugerido_id).toBeNull();            // nunca escolhe uma das fichas
      expect(i.motivo).toMatch(/pertence a 2 fichas/);
    });

    it("prefixo único entra como FRACA enquanto a medição de 20/09 não for refeita", async () => {
      const i = await item(db, PAG_PREFIXO);
      expect(i.fonte_evidencia).toBe("PREFIXO_UNICO");
      expect(i.forca_evidencia).toBe("FRACA");
      expect(i.estado).toBe("PRECISA_ANALISE");
      expect(i.motivo).toMatch(/nao foi refeita/);
    });

    it("com p_prefixo_como_forte a gestão liga -- e só então vira FORTE", async () => {
      await db.exec(`delete from public.fila_confirmacao_pagamento;`);
      await enfileirarLote(db, CORTE, 500, true);
      expect(await item(db, PAG_PREFIXO)).toMatchObject({
        fonte_evidencia: "PREFIXO_UNICO", forca_evidencia: "FORTE", estado: "A_CONFIRMAR",
      });
    });

    it("nada resolvendo é SEM_IDENTIFICACAO / NENHUMA, em análise", async () => {
      expect(await item(db, PAG_SEM_NADA)).toMatchObject({
        estado: "PRECISA_ANALISE", forca_evidencia: "SEM_IDENTIFICACAO", fonte_evidencia: "NENHUMA",
      });
    });

    it("nenhum item FRACA ou SEM_IDENTIFICACAO saiu da análise", async () => {
      expect(await um(db, `
        select count(*)::int from public.fila_confirmacao_pagamento
         where forca_evidencia <> 'FORTE' and estado in ('A_CONFIRMAR','CONFIRMADO')`)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("BAIXADO no CRM não é prova", () => {
    it("status_conciliacao = BAIXADO não produz CONFIRMADO -- entra como alerta no motivo", async () => {
      await ligar(db);
      await enfileirarLote(db);
      const i = await item(db, PAG_BOLETO);                   // este crédito está BAIXADO no CRM
      expect(i.estado).toBe("A_CONFIRMAR");                   // e NÃO CONFIRMADO
      expect(i.motivo).toMatch(/BAIXADO.*nao conta como prova|nao e baixa oficial/s);
    });

    it("a única porta automática para CONFIRMADO é a baixa amarrada a ESTE crédito", async () => {
      await ligar(db);
      await enfileirarLote(db);
      expect(await item(db, PAG_JA_BAIXADO)).toMatchObject({
        estado: "CONFIRMADO", forca_evidencia: "FORTE",
        fonte_evidencia: "BAIXA_REGISTRADA_NA_PARCELA", parcela_sugerida_id: PARCELA_REF,
      });
      expect(await um(db, `
        select count(*)::int from public.fila_confirmacao_pagamento
         where estado = 'CONFIRMADO' and fonte_evidencia <> 'BAIXA_REGISTRADA_NA_PARCELA'`)).toBe(0);
    });

    it("baixa viva na parcela SEM amarra ao crédito é alerta de dupla baixa, não confirmação", async () => {
      await ligar(db);
      await enfileirarLote(db);
      const i = await item(db, PAG_DUPLA_BAIXA);
      expect(i.forca_evidencia).toBe("FORTE");      // a identificação continua forte
      expect(i.fonte_evidencia).toBe("BOLETO_EXATO");
      expect(i.estado).toBe("PRECISA_ANALISE");     // mas o item não sai da análise
      expect(i.motivo).toMatch(/dupla baixa/i);
    });
  });

  // -------------------------------------------------------------------------
  describe("corte, reimportação e idempotência", () => {
    beforeEach(() => ligar(db));

    it("o corte é a data literal 2026-10-01 -- não depende do dia em que o teste roda", async () => {
      expect(await um(db, `select public.confirmacao_fila_enfileirar_um('${PAG_FORA_CORTE}'::uuid)`))
        .toMatchObject({ ok: false, motivo: "FORA_DO_CORTE" });
      await enfileirarLote(db);
      expect(await item(db, PAG_FORA_CORTE)).toBeUndefined();
      // e a fronteira: 30/09 fica fora, 01/10 entra
      await db.exec(`update public.pagamentos set data_pagamento = date '2026-09-30'
                      where id = '${PAG_SEM_NADA}';`);
      expect((await um(db, `select public.confirmacao_fila_enfileirar_um('${PAG_SEM_NADA}'::uuid)`)).motivo)
        .toBe("FORA_DO_CORTE");
      await db.exec(`update public.pagamentos set data_pagamento = date '2026-10-01'
                      where id = '${PAG_SEM_NADA}';`);
      expect((await um(db, `select public.confirmacao_fila_enfileirar_um('${PAG_SEM_NADA}'::uuid)`)).ok)
        .toBe(true);
    });

    it("a mesma movimentação reimportada vira DUPLICADO_IGNORADO, e não um segundo item vivo", async () => {
      await enfileirarLote(db);
      const original = await item(db, PAG_BOLETO);
      const copia = await item(db, PAG_REIMPORTADO);
      expect(copia.chave_movimentacao).toBe(original.chave_movimentacao);
      expect(copia.estado).toBe("DUPLICADO_IGNORADO");
      expect(copia.fonte_evidencia).toBe("REIMPORTACAO");
      // a decisão viva continua sendo UMA só para aquela movimentação
      expect(await um(db, `
        select count(*)::int from public.fila_confirmacao_pagamento
         where chave_movimentacao = $1 and estado <> 'DUPLICADO_IGNORADO'`,
        [original.chave_movimentacao])).toBe(1);
    });

    it("rodar duas vezes não duplica e não muda nenhuma decisão", async () => {
      const r1 = await enfileirarLote(db);
      const fila1 = await um(db, `select md5(string_agg(f::text, '|' order by pagamento_id::text))
                                    from public.fila_confirmacao_pagamento f`);
      const n1 = await um(db, `select count(*)::int from public.fila_confirmacao_pagamento`);

      const r2 = await enfileirarLote(db);
      const fila2 = await um(db, `select md5(string_agg(f::text, '|' order by pagamento_id::text))
                                    from public.fila_confirmacao_pagamento f`);

      expect(r1.itens_novos).toBe(n1);
      expect(r2.itens_novos).toBe(0);
      expect(r2.movimentacoes_vistas).toBe(0);   // nada sobrou para ver
      expect(fila2).toBe(fila1);                 // byte a byte: nenhuma decisão foi reescrita
    });

    it("a idempotência é do índice, não da lógica: ON CONFLICT não insere o segundo", async () => {
      const a = await um(db, `select public.confirmacao_fila_enfileirar_um('${PAG_BOLETO}'::uuid)`);
      const b = await um(db, `select public.confirmacao_fila_enfileirar_um('${PAG_BOLETO}'::uuid)`);
      expect(a.inserido).toBe(true);
      expect(b).toMatchObject({ ok: true, ja_existia: true, inserido: false });
      expect(await um(db, `select count(*)::int from public.fila_confirmacao_pagamento
                            where pagamento_id = '${PAG_BOLETO}'`)).toBe(1);
    });

    it("decisão humana já tomada sobrevive a um novo enfileiramento", async () => {
      await enfileirarLote(db);
      await db.exec(`
        update public.fila_confirmacao_pagamento
           set estado = 'NAO_IDENTIFICADO', motivo = 'gestao: boleto nao existe em parcelas',
               decidido_por = 'amanda.seibel@aelbra.com.br',
               decidido_em = timestamptz '2026-10-20 13:00:00+00', decisao = 'NAO_VINCULAR'
         where pagamento_id = '${PAG_SEM_NADA}';`);
      const antes = await item(db, PAG_SEM_NADA);

      await enfileirarLote(db);

      expect(await item(db, PAG_SEM_NADA)).toEqual(antes);
    });
  });

  // -------------------------------------------------------------------------
  describe("o populador não escreve fora da fila", () => {
    it("nenhuma linha de pagamentos, parcelas, títulos, acordos, baixas ou links muda", async () => {
      await ligar(db);
      const antes = await fotoDeFora(db);          // já com a etapa ligada: a foto é pós-flag

      const r = await enfileirarLote(db);

      expect(r.itens_novos).toBeGreaterThan(0);    // escreveu de fato...
      expect(await fotoDeFora(db)).toEqual(antes); // ...e só na fila
    });

    it("o lote visita cada movimentação uma vez e classifica todas as elegíveis", async () => {
      await ligar(db);
      const r = await enfileirarLote(db);
      const elegiveis = await um(db, `select count(*)::int from public.pagamentos
                                       where data_pagamento >= date '${CORTE}'`);
      expect(r.movimentacoes_vistas).toBe(elegiveis);
      expect(r.itens_novos).toBe(elegiveis);
      expect(await um(db, `select count(*)::int from public.fila_confirmacao_pagamento`)).toBe(elegiveis);
    });
  });

  // -------------------------------------------------------------------------
  describe("grants endurecidos", () => {
    const podeTabela = (papel, priv, tabela = "fila_confirmacao_pagamento") =>
      um(db, `select has_table_privilege($1, 'public.${tabela}', $2)`, [papel, priv]);
    const podeFuncao = (papel, assinatura) =>
      um(db, `select has_function_privilege($1, $2, 'EXECUTE')`, [papel, assinatura]);

    it("CONTROLE: sem o revoke, o default do schema dá TRUNCATE a authenticated", async () => {
      // Se este teste falhar, o default privilege não está valendo na bancada e os
      // testes abaixo não provariam nada.
      expect(await podeTabela("authenticated", "TRUNCATE", "gemea_sem_revoke")).toBe(true);
      expect(await podeTabela("authenticated", "DELETE", "gemea_sem_revoke")).toBe(true);
    });

    it("authenticated não tem TRUNCATE na fila", async () => {
      expect(await podeTabela("authenticated", "TRUNCATE")).toBe(false);
    });

    it("authenticated não tem escrita ampla: nem INSERT, nem UPDATE, nem DELETE", async () => {
      expect(await podeTabela("authenticated", "INSERT")).toBe(false);
      expect(await podeTabela("authenticated", "UPDATE")).toBe(false);
      expect(await podeTabela("authenticated", "DELETE")).toBe(false);
    });

    it("authenticated fica exatamente em r no ACL CRU -- não no information_schema", async () => {
      // O information_schema esconde grants a PUBLIC; o relacl não.
      const acl = await um(db, `
        select coalesce(array_to_string(c.relacl, ' | '), '(sem acl)')
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'fila_confirmacao_pagamento'`);
      expect(acl).toMatch(/authenticated=r\//);
      expect(acl).not.toMatch(/authenticated=[a-zA-Z]*[awdDxt]/);
      expect(acl).not.toMatch(/(^| )=[a-zA-Z]+\//);   // nenhum grant a PUBLIC
      expect(await podeTabela("authenticated", "SELECT")).toBe(true);
    });

    it("anon não enxerga a fila", async () => {
      expect(await podeTabela("anon", "SELECT")).toBe(false);
    });

    it("service_role escreve mas não trunca", async () => {
      expect(await podeTabela("service_role", "INSERT")).toBe(true);
      expect(await podeTabela("service_role", "SELECT")).toBe(true);
      expect(await podeTabela("service_role", "TRUNCATE")).toBe(false);
    });

    it("RLS fica ligada, com uma política de leitura", async () => {
      expect(await um(db, `select c.relrowsecurity from pg_class c
                            join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname='public' and c.relname='fila_confirmacao_pagamento'`)).toBe(true);
      expect(await um(db, `select count(*)::int from pg_policy p join pg_class c on c.oid=p.polrelid
                           where c.relname='fila_confirmacao_pagamento'`)).toBe(1);
    });

    it("o populador não é executável por authenticated nem por anon", async () => {
      for (const f of ["public.confirmacao_fila_enfileirar_um(uuid,date,boolean)",
                       "public.confirmacao_fila_enfileirar_lote(date,integer,boolean)"]) {
        expect(await podeFuncao("authenticated", f)).toBe(false);
        expect(await podeFuncao("anon", f)).toBe(false);
        expect(await podeFuncao("service_role", f)).toBe(true);
      }
      // proacl nulo significaria "default", e o default é EXECUTE para PUBLIC.
      expect(await um(db, `select count(*)::int from pg_proc p
                            join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname='public' and p.proacl is null
                             and p.proname like 'confirmacao_fila_enfileirar%'`)).toBe(0);
    });

    it("o populador é SECURITY INVOKER -- não empresta privilégio a quem chamar", async () => {
      expect(await um(db, `select count(*)::int from pg_proc p
                            join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname='public' and p.prosecdef
                             and p.proname like 'confirmacao_fila_enfileirar%'`)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("rollback", () => {
    it("remove fila, populador e etapa, e não deixa resto", async () => {
      await ligar(db);
      await enfileirarLote(db);
      await db.exec(ROLLBACK);

      expect(await um(db, `select count(*)::int from pg_class c
                            join pg_namespace n on n.oid=c.relnamespace
                           where n.nspname='public' and c.relname='fila_confirmacao_pagamento'`)).toBe(0);
      expect(await um(db, `select count(*)::int from pg_proc p
                            join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='public' and p.proname like 'confirmacao_fila_enfileirar%'`)).toBe(0);
      expect(await um(db, `select count(*)::int from public.fluxo_pagamentos_config
                            where etapa='fila_confirmacao_enfileirar'`)).toBe(0);
    });

    it("recusa apagar decisão humana sem a saída explícita", async () => {
      await ligar(db);
      await enfileirarLote(db);
      await db.exec(`
        update public.fila_confirmacao_pagamento
           set estado='NAO_IDENTIFICADO', motivo='gestao: nao da para vincular',
               decidido_por='amanda.seibel@aelbra.com.br',
               decidido_em = timestamptz '2026-10-20 13:00:00+00'
         where pagamento_id='${PAG_SEM_NADA}';`);

      await expect(db.exec(ROLLBACK)).rejects.toThrow(/decisao humana registrada/);
      // O arquivo abre a própria transação: quando a guarda levanta, o `commit;` do fim
      // nunca roda e a sessão fica em transação abortada. Nada foi aplicado -- é esse o
      // ponto -- e quem rodou precisa encerrar a transação antes de seguir.
      await db.exec(`rollback;`);
      // e a fila continua de pé, com a decisão intacta
      expect((await item(db, PAG_SEM_NADA)).estado).toBe("NAO_IDENTIFICADO");

      await db.exec(`set rollback_fila_confirmacao.apagar_decisoes = 'sim';`);
      await db.exec(ROLLBACK);
      expect(await um(db, `select count(*)::int from pg_class c
                            join pg_namespace n on n.oid=c.relnamespace
                           where n.nspname='public' and c.relname='fila_confirmacao_pagamento'`)).toBe(0);
    });

    it("a migration volta a aplicar depois do rollback (ida e volta)", async () => {
      await db.exec(ROLLBACK);
      await db.exec(MIGRATION);
      expect(await um(db, `select count(*)::int from public.fila_confirmacao_pagamento`)).toBe(0);
      expect(await um(db, `select ligado from public.fluxo_pagamentos_config
                            where etapa='fila_confirmacao_enfileirar'`)).toBe(false);
    });
  });
});
