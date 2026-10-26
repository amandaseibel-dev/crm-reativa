// ENCAMINHAMENTO DA ETAPA 2, em PostgreSQL de verdade (PGlite).
//
// POR QUE EM BANCO REAL. O que esta etapa promete não é formato de retorno: é
// ATOMICIDADE. `conciliacao_ja_paga_encerrar` grava a decisão da fila e
// `conciliacao_encerrar_sem_efeito_financeiro` move o pagamento ao estado
// terminal; usada sozinha, a primeira produz exatamente os 33 casos de
// "decidido e eternamente pendente" que a Etapa 1 foi feita para encerrar.
// A fachada chama as duas na MESMA transação e desfaz a primeira se a segunda
// recusar. Isso só se prova com transação real -- um dublê de cliente não tem
// rollback para exercitar.
//
// AS FUNÇÕES TESTADAS SÃO AS REAIS, extraídas dos arquivos versionados:
//   conciliacao_ja_paga_previa              20260917210000 (#405)
//   conciliacao_ja_paga_encerrar            20260917210000 (#405)
//   conciliacao_encerrar_sem_efeito_financeiro  20261024170000 (#752, Etapa 1)
//   conciliacao_encaminhar_previa           20261026160000 (esta etapa)
//   conciliacao_encaminhar_confirmar        20261026160000 (esta etapa)
// `usuario_e_gestao` também é o corpo real (allowlist de três e-mails), para o
// portão ser exercitado e não simulado.
//
// O QUE ESTE TESTE NÃO COBRE, dito aqui para ninguém ler mais do que ele prova:
//
//   1. `vw_fila_pagamento_triagem` é um DUBLÊ nesta bancada. A view real tem
//      ~200 linhas e depende de uma dezena de tabelas; reproduzi-la aqui seria
//      testar a cópia. O dublê expõe as mesmas colunas que a fachada lê e a
//      mesma regra que importa para ela: `acao_sugerida` derivada da
//      subcategoria, e o estado terminal FORA da triagem. A classificação em si
//      é coberta por `filaPagamentoTriagem.arquivo.test.js` e pelas migrations
//      #737/#746.
//   2. `pagamento_vincular_aluno` é um DUBLÊ. Ela é função pré-existente, com
//      portão próprio, de outra frente -- o que se testa aqui é a FACHADA (o
//      portão, a conferência do aluno contra as sugestões, a auditoria), não o
//      vínculo.
//
// NENHUM DADO REAL.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const M_JA_PAGA = ler("supabase/migrations/20260917210000_encerrar_pendencia_de_conciliacao.sql");
const M_TERMINAL = ler("supabase/migrations/20261024170000_conciliacao_saida_terminal.sql");
const M_ETAPA2 = ler("supabase/migrations/20261026160000_conciliacao_encaminhamento_etapa2.sql");

// EXTRAI UMA FUNÇÃO DO ARQUIVO VERSIONADO, do `create` até o fechamento do
// corpo. Lança quando não acha: extração silenciosa que devolve vazio faria o
// teste passar sem testar nada -- o pior resultado possível.
function extrair(sql, nome) {
  const abre = `create or replace function public.${nome}(`;
  const i = sql.indexOf(abre);
  if (i < 0) throw new Error(`funcao ${nome} nao encontrada no arquivo da migration`);
  const resto = sql.slice(i);
  const m = resto.match(/\n\s*as\s+(\$[a-z_]*\$)/i);
  if (!m) throw new Error(`delimitador do corpo de ${nome} nao encontrado`);
  const tag = m[1];
  const ini = resto.indexOf(tag);
  const fim = resto.indexOf(tag, ini + tag.length);
  if (fim < 0) throw new Error(`corpo de ${nome} nao fecha`);
  return `${resto.slice(0, fim + tag.length)};`;
}

const UUID_PAG = "11111111-1111-4111-8111-111111111111";
const UUID_PAG2 = "22222222-2222-4222-8222-222222222222";
const UUID_ACORDO = "33333333-3333-4333-8333-333333333333";
const UUID_PARCELA = "44444444-4444-4444-8444-444444444444";
const UUID_ALUNO_A = "55555555-5555-4555-8555-555555555555";
const UUID_ALUNO_B = "66666666-6666-4666-8666-666666666666";
const UUID_OUTRA_PARC = "77777777-7777-4777-8777-777777777777";

const GESTAO = "amanda.seibel@aelbra.com.br";
const OPERADOR = "cobranca10@aelbra.com.br";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

// Quem está logado. `request.jwt.claims` é o mesmo mecanismo do Supabase, e
// `usuario_e_gestao` real lê exatamente dele.
async function entrarComo(db, email, role = "authenticated") {
  await db.exec(`set request.jwt.claims = '${JSON.stringify({ email, role })}';`);
  await db.exec(`set request.jwt.role = '${role}';`);
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;

    create function auth.jwt() returns jsonb language sql stable as
      $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.role', true), '') $$;

    create table public.alunos (id uuid primary key, nome text, cpf text);

    create table public.acordos (id uuid primary key, numero_ulbra text, status text default 'ATIVO',
      qtd_parcelas int, valor_total numeric);

    create table public.parcelas (id uuid primary key, acordo_id uuid, numero int, boleto text,
      valor numeric, vencimento date, status text, origem_baixa text, origem_baixa_ref text,
      pago_em timestamptz, confirmado_por_email text);

    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(),
      parcela_id uuid, devolvido_em timestamptz);

    create table public.pagamentos (id uuid primary key, numero_parcela_completo text,
      valor_pago numeric, data_pagamento date, status_conciliacao text, conciliacao_motivo text,
      retroativo boolean default false, dados jsonb default '{}'::jsonb,
      aluno_id uuid, origem_vinculo text, origem_vinculo_ref text, origem_vinculo_em timestamptz);

    -- O CHECK REAL da Etapa 1, com o valor terminal. Sem ele o teste não
    -- provaria que o estado novo é aceito pelo banco.
    alter table public.pagamentos add constraint pagamentos_status_conciliacao_valido
      check (status_conciliacao is null or status_conciliacao = any (array[
        'BAIXADO','AGUARDANDO_ACORDO','AGUARDANDO_AMARRACAO','PARCELA_JA_PAGA','REVISAO',
        'SEM_VINCULO','ACORDO_CONFIRMADO_SEM_ESTRUTURA','TITULO_ORIGINAL_LIQUIDADO',
        'ENCERRADO_SEM_EFEITO_FINANCEIRO']));

    create table public.fila_pagamento_sem_vinculo (id uuid primary key default gen_random_uuid(),
      pagamento_id uuid, decisao text, conclusao text, decidido_por text, decidido_em timestamptz,
      motivo text, observacao text, status_conciliacao text, valor_pago numeric, boleto text,
      subcategoria text, sugestoes jsonb default '[]'::jsonb);

    create table public.auditoria (id bigserial primary key, usuario text, acao text,
      tabela_afetada text, registro_id uuid, detalhes jsonb, criado_em timestamptz default now());

    -- O PORTÃO REAL: allowlist de três e-mails, igual à produção.
    create function public.usuario_e_gestao() returns boolean language sql stable
      security definer set search_path to 'public' as $$
        select lower(coalesce(auth.jwt()->>'email','')) in (
          'amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
      $$;

    -- DUBLÊ da triagem. Mesmas colunas que a fachada lê; a acao vem da
    -- subcategoria, e o ESTADO TERMINAL FICA FORA -- como na view real.
    create view public.vw_fila_pagamento_triagem as
      select f.pagamento_id, p.aluno_id, p.data_pagamento, p.valor_pago,
             p.status_conciliacao, null::text as titulo_numero, f.boleto,
             case when f.subcategoria in ('ja_paga_conferir_e_encerrar','escolher_aluno_sugerido')
                  then 'ACIONAVEL_ADMINISTRATIVO' else 'CONFERENCIA_HUMANA' end as categoria,
             f.subcategoria, null::text as etapa_desligada,
             case f.subcategoria
               when 'ja_paga_conferir_e_encerrar' then 'CONFERIR_E_ENCERRAR'
               when 'escolher_aluno_sugerido' then 'ESCOLHER_ALUNO' end as acao_sugerida,
             f.motivo, f.sugestoes, f.decisao, f.decidido_por, f.decidido_em
        from public.fila_pagamento_sem_vinculo f
        join public.pagamentos p on p.id = f.pagamento_id
       where coalesce(p.status_conciliacao,'') <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';

    -- DUBLÊ do vínculo. Grava o aluno e fecha a linha, como a real; recusa
    -- aluno inexistente, para o ramo VINCULO_RECUSADO ter caminho.
    create function public.pagamento_vincular_aluno(p_pagamento_id uuid, p_aluno_id uuid,
                                                    p_observacao text)
      returns jsonb language plpgsql security definer set search_path to 'public' as $$
      begin
        if not exists (select 1 from public.alunos a where a.id = p_aluno_id) then
          return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_ENCONTRADO');
        end if;
        update public.pagamentos
           set aluno_id = p_aluno_id, origem_vinculo = 'GESTAO_MANUAL', origem_vinculo_em = now()
         where id = p_pagamento_id;
        update public.fila_pagamento_sem_vinculo
           set decisao = 'FEITO', decidido_por = lower(auth.jwt()->>'email'), decidido_em = now()
         where pagamento_id = p_pagamento_id and decisao is null;
        return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id);
      end; $$;
  `);

  await db.exec(extrair(M_JA_PAGA, "conciliacao_ja_paga_previa"));
  await db.exec(extrair(M_JA_PAGA, "conciliacao_ja_paga_encerrar"));
  await db.exec(extrair(M_TERMINAL, "conciliacao_encerrar_sem_efeito_financeiro"));
  await db.exec(extrair(M_ETAPA2, "conciliacao_encaminhar_previa"));
  await db.exec(extrair(M_ETAPA2, "conciliacao_encaminhar_confirmar"));

  return db;
}

// O CASO QUE PASSA NAS 8 VALIDAÇÕES de PARCELA_JA_PAGA_CONFERIDA: pagamento em
// PARCELA_JA_PAGA, boleto no padrão, parcela única do boleto em PAGO, um único
// pagamento desse boleto, valor dentro da faixa, acordo fechando pagamento a
// pagamento, referência da baixa antiga deslocada e nenhuma baixa devolvida.
async function semearJaPaga(db) {
  await db.exec(`
    insert into public.acordos (id, numero_ulbra, status, qtd_parcelas, valor_total)
      values ('${UUID_ACORDO}', '064053', 'ATIVO', 1, 327.10);
    insert into public.parcelas (id, acordo_id, numero, boleto, valor, vencimento, status,
                                 origem_baixa, origem_baixa_ref, pago_em)
      values ('${UUID_PARCELA}', '${UUID_ACORDO}', 2, '50640530004', 327.10, '2026-09-10', 'PAGO',
              'RELATORIO', null, '2026-09-12');
    insert into public.pagamentos (id, numero_parcela_completo, valor_pago, data_pagamento,
                                   status_conciliacao, conciliacao_motivo)
      values ('${UUID_PAG}', '50640530004', 327.10, '2026-09-15', 'PARCELA_JA_PAGA',
              'a parcela 2 do boleto 50640530004 ja estava PAGO antes deste pagamento');
    insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo, status_conciliacao,
                                                   valor_pago, boleto, subcategoria)
      values ('${UUID_PAG}', 'a parcela 2 do boleto 50640530004 ja estava PAGO antes deste pagamento',
              'PARCELA_JA_PAGA', 327.10, '50640530004', 'ja_paga_conferir_e_encerrar');
  `);
}

async function semearEscolherAluno(db) {
  await db.exec(`
    insert into public.alunos (id, nome, cpf) values
      ('${UUID_ALUNO_A}', 'MARIA DA SILVA', '00000000191'),
      ('${UUID_ALUNO_B}', 'MARIA DA SILVA', '00000000272');
    insert into public.pagamentos (id, numero_parcela_completo, valor_pago, data_pagamento,
                                   status_conciliacao)
      values ('${UUID_PAG2}', '50700010001', 559.00, '2026-09-20', 'SEM_VINCULO');
    insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo, status_conciliacao,
                                                   valor_pago, boleto, subcategoria, sugestoes)
      values ('${UUID_PAG2}', 'NOME_REPETIDO: duas fichas com o mesmo nome', 'SEM_VINCULO',
              559.00, '50700010001', 'escolher_aluno_sugerido',
              '[{"aluno_id":"${UUID_ALUNO_A}","aluno_nome":"MARIA DA SILVA","cpf":"00000000191"},
                {"aluno_id":"${UUID_ALUNO_B}","aluno_nome":"MARIA DA SILVA","cpf":"00000000272"}]'::jsonb);
  `);
}

// A FOTOGRAFIA DO DINHEIRO. Se qualquer destas três tabelas mudar, a etapa teve
// efeito financeiro -- e é exatamente o que ela promete não ter.
async function fotoFinanceira(db) {
  return {
    parcelas: await um(db, `select coalesce(md5(string_agg(t::text, '|' order by t::text)),'vazio')
                              from (select * from public.parcelas) t`),
    acordos: await um(db, `select coalesce(md5(string_agg(t::text, '|' order by t::text)),'vazio')
                             from (select * from public.acordos) t`),
    baixas: await um(db, `select coalesce(md5(string_agg(t::text, '|' order by t::text)),'vazio')
                            from (select * from public.baixas_pagamento) t`),
  };
}

describe("Etapa 2 · o portão", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await semearJaPaga(db);
  });

  it("operador não abre a prévia", async () => {
    await entrarComo(db, OPERADOR);
    await expect(
      db.query(`select public.conciliacao_encaminhar_previa('${UUID_PAG}')`)
    ).rejects.toThrow(/decisao da gestao/i);
  });

  it("operador não confirma", async () => {
    await entrarComo(db, OPERADOR);
    await expect(
      db.query(`select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`)
    ).rejects.toThrow(/decisao da gestao/i);
  });

  // A LIÇÃO DA ALLOWLIST POR auth.email() (PR #729): sem JWT, `usuario_e_gestao`
  // devolve false e `NULL and ...` não barraria. O portão usa
  // `coalesce(..., false)` e a identidade nula é recusada.
  it("sem identidade nenhuma, recusa", async () => {
    await db.exec(`set request.jwt.claims = ''; set request.jwt.role = '';`);
    await expect(
      db.query(`select public.conciliacao_encaminhar_previa('${UUID_PAG}')`)
    ).rejects.toThrow(/decisao da gestao/i);
  });

  it("gestão abre a prévia", async () => {
    await entrarComo(db, GESTAO);
    const r = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG}')`);
    expect(r.ok).toBe(true);
    expect(r.acao).toBe("CONFERIR_E_ENCERRAR");
  });

  it("o backend (service_role) passa, para a rodada poder usar a mesma porta", async () => {
    await entrarComo(db, "cron@sistema", "service_role");
    const r = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG}')`);
    expect(r.ok).toBe(true);
  });
});

describe("Etapa 2 · a prévia não grava", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await semearJaPaga(db);
    await entrarComo(db, GESTAO);
  });

  it("devolve as 8 validações, aprovado, e os DOIS passos", async () => {
    const r = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG}')`);
    expect(r.aprovado).toBe(true);
    expect(r.bloqueios).toEqual([]);
    expect(r.validacoes).toHaveLength(8);
    expect(r.passos).toEqual([
      "REGISTRAR_DECISAO_RESOLVIDO_AUTOMATICO",
      "MOVER_PARA_ENCERRADO_SEM_EFEITO_FINANCEIRO",
    ]);
    expect(r.resultado_esperado).toBe("PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO");
    expect(r.efeito_financeiro).toBe(false);
    expect(r.gravou).toBe(false);
  });

  it("a prévia, e a confirmação sem confirmar, não mudam nada", async () => {
    const antes = await fotoFinanceira(db);
    await db.query(`select public.conciliacao_encaminhar_previa('${UUID_PAG}')`);
    const sim = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,false)`);

    expect(sim.modo).toBe("SIMULACAO");
    expect(sim.gravou).toBe(false);
    expect(await um(db, `select status_conciliacao from public.pagamentos where id='${UUID_PAG}'`))
      .toBe("PARCELA_JA_PAGA");
    expect(await um(db, `select count(*)::int from public.fila_pagamento_sem_vinculo
                          where pagamento_id='${UUID_PAG}' and decisao is not null`)).toBe(0);
    expect(await um(db, `select count(*)::int from public.auditoria`)).toBe(0);
    expect(await fotoFinanceira(db)).toEqual(antes);
  });

  it("pagamento fora da triagem é recusado com motivo nomeado", async () => {
    const r = await um(db,
      `select public.conciliacao_encaminhar_previa('88888888-8888-4888-8888-888888888888')`);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("SEM_PENDENCIA_NA_TRIAGEM");
  });

  it("subcategoria sem ação declarada não oferece encaminhamento", async () => {
    await db.exec(`update public.fila_pagamento_sem_vinculo
                      set subcategoria = 'consulta_portador' where pagamento_id='${UUID_PAG}'`);
    const r = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG}')`);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("SEM_ACAO_SUGERIDA");
  });
});

describe("Etapa 2 · CONFERIR_E_ENCERRAR", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await semearJaPaga(db);
    await entrarComo(db, GESTAO);
  });

  it("encerra em dois passos: decisão na fila E estado terminal", async () => {
    const r = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`);

    expect(r.ok).toBe(true);
    expect(r.modo).toBe("CONFIRMADO");
    expect(r.gravou).toBe(true);
    expect(r.resultado).toBe("PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO");

    // O PASSO 2 É O QUE EVITA O LIMBO: decisão na fila *e* estado terminal.
    expect(await um(db, `select decisao from public.fila_pagamento_sem_vinculo
                          where pagamento_id='${UUID_PAG}'`)).toBe("RESOLVIDO_AUTOMATICO");
    expect(await um(db, `select status_conciliacao from public.pagamentos where id='${UUID_PAG}'`))
      .toBe("ENCERRADO_SEM_EFEITO_FINANCEIRO");
  });

  it("não tem efeito financeiro: parcela, acordo e baixa ficam idênticos", async () => {
    const antes = await fotoFinanceira(db);
    await db.query(
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`);
    expect(await fotoFinanceira(db)).toEqual(antes);
  });

  it("deixa trilha: auditoria do encaminhamento, com quem decidiu e sem efeito financeiro", async () => {
    await db.query(
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`);

    const a = await um(db, `select to_jsonb(t) from (
      select usuario, acao, tabela_afetada, registro_id, detalhes from public.auditoria
       where acao = 'CONCILIACAO_ENCAMINHAMENTO') t`);
    expect(a.usuario).toBe(GESTAO);
    expect(a.registro_id).toBe(UUID_PAG);
    expect(a.detalhes.acao).toBe("CONFERIR_E_ENCERRAR");
    expect(a.detalhes.origem).toBe("FILA_PAGAMENTO_ENCAMINHAMENTO");
    expect(a.detalhes.sem_efeito_financeiro).toBe(true);

    // As auditorias dos dois passos internos continuam lá: a trilha do
    // encaminhamento SOMA à delas, não as substitui.
    const acoes = await um(db, `select array_agg(distinct acao order by acao) from public.auditoria`);
    expect(acoes).toContain("CONCILIACAO_JA_PAGA_CONFERIDA");
    expect(acoes).toContain("CONCILIACAO_SAIDA_TERMINAL");
    expect(acoes).toContain("CONCILIACAO_ENCAMINHAMENTO");
  });

  // O TESTE CENTRAL DESTA ETAPA. Uma parcela de OUTRO boleto aponta para este
  // pagamento: a prévia não a vê (ela olha a parcela do boleto do pagamento) e
  // aprova; o passo 2 a vê e recusa com TEM_BAIXA_REGISTRADA. A exceção tem de
  // desfazer o passo 1 -- senão a fachada acabou de criar um 34º caso de
  // "decidido e eternamente pendente".
  it("se a saída terminal recusa, a decisão do passo 1 é DESFEITA", async () => {
    await db.exec(`
      insert into public.parcelas (id, acordo_id, numero, boleto, valor, status, origem_baixa_ref)
        values ('${UUID_OUTRA_PARC}', null, 1, '50999990001', 100.00, 'PAGO', '${UUID_PAG}');
    `);

    const previa = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG}')`);
    expect(previa.aprovado).toBe(true); // a prévia aprova: ela não olha essa parcela

    await expect(
      db.query(`select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`)
    ).rejects.toThrow(/ENCAMINHAMENTO_ABORTADO/);

    // NADA GRAVADO. Nem a decisão, nem o estado, nem auditoria.
    expect(await um(db, `select decisao from public.fila_pagamento_sem_vinculo
                          where pagamento_id='${UUID_PAG}'`)).toBeNull();
    expect(await um(db, `select status_conciliacao from public.pagamentos where id='${UUID_PAG}'`))
      .toBe("PARCELA_JA_PAGA");
    expect(await um(db, `select count(*)::int from public.auditoria`)).toBe(0);
  });

  it("a ação pedida é CONFERIDA contra a sugerida, não obedecida", async () => {
    const r = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','ESCOLHER_ALUNO','${UUID_ALUNO_A}',true)`);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("ACAO_DIVERGE_DA_SUGERIDA");
    expect(r.acao_sugerida).toBe("CONFERIR_E_ENCERRAR");
    expect(r.gravou).toBe(false);
    expect(await um(db, `select count(*)::int from public.auditoria`)).toBe(0);
  });

  it("prévia reprovada não encerra", async () => {
    // Um segundo pagamento do mesmo boleto derruba UNICO_PAGAMENTO_DO_BOLETO.
    await db.exec(`
      insert into public.pagamentos (id, numero_parcela_completo, valor_pago, data_pagamento,
                                     status_conciliacao)
        values ('${UUID_PAG2}', '50640530004', 327.10, '2026-09-16', 'REVISAO');
    `);
    const r = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`);
    expect(r.ok).toBe(false);
    expect(r.gravou).toBe(false);
    expect(r.bloqueios).toContain("UNICO_PAGAMENTO_DO_BOLETO");
    expect(await um(db, `select status_conciliacao from public.pagamentos where id='${UUID_PAG}'`))
      .toBe("PARCELA_JA_PAGA");
  });

  // IDEMPOTÊNCIA. Depois de encerrado, o pagamento sai da triagem (como na view
  // real) e a segunda chamada é recusada sem gravar -- não duplica decisão nem
  // auditoria.
  it("confirmar duas vezes não grava duas vezes", async () => {
    await db.query(
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`);
    const auditorias = await um(db, `select count(*)::int from public.auditoria`);

    const r2 = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG}','CONFERIR_E_ENCERRAR',null,true)`);
    expect(r2.ok).toBe(false);
    expect(r2.motivo).toBe("SEM_PENDENCIA_NA_TRIAGEM");
    expect(r2.gravou).toBe(false);
    expect(await um(db, `select count(*)::int from public.auditoria`)).toBe(auditorias);
  });
});

describe("Etapa 2 · ESCOLHER_ALUNO", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await semearEscolherAluno(db);
    await entrarComo(db, GESTAO);
  });

  it("a prévia devolve as sugestões da fila, e um passo só", async () => {
    const r = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG2}')`);
    expect(r.ok).toBe(true);
    expect(r.acao).toBe("ESCOLHER_ALUNO");
    expect(r.sugestoes).toHaveLength(2);
    expect(r.passos).toEqual(["VINCULAR_ALUNO_ESCOLHIDO"]);
    expect(r.efeito_financeiro).toBe(false);
  });

  it("sem aluno escolhido, recusa", async () => {
    const r = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG2}','ESCOLHER_ALUNO',null,true)`);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("ALUNO_NAO_INFORMADO");
    expect(r.gravou).toBe(false);
  });

  // A PORTA NÃO É UM VÍNCULO LIVRE. Aceitar id de fora da lista faria desta
  // ação outra coisa -- a busca manual, que já existe e tem a própria tela.
  it("aluno fora das sugestões, recusa e não grava", async () => {
    await db.exec(`insert into public.alunos (id, nome, cpf)
                     values ('99999999-9999-4999-8999-999999999999','OUTRO ALUNO','11111111111')`);
    const r = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG2}','ESCOLHER_ALUNO',
                                                      '99999999-9999-4999-8999-999999999999',true)`);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("ALUNO_FORA_DAS_SUGESTOES");
    expect(await um(db, `select aluno_id from public.pagamentos where id='${UUID_PAG2}'`)).toBeNull();
    expect(await um(db, `select count(*)::int from public.auditoria`)).toBe(0);
  });

  it("aluno da lista: vincula, audita e não toca no dinheiro", async () => {
    const antes = await fotoFinanceira(db);
    const r = await um(db,
      `select public.conciliacao_encaminhar_confirmar('${UUID_PAG2}','ESCOLHER_ALUNO','${UUID_ALUNO_B}',true)`);

    expect(r.ok).toBe(true);
    expect(r.modo).toBe("CONFIRMADO");
    expect(r.resultado).toBe("PAGAMENTO_VINCULADO_AO_ALUNO");
    expect(await um(db, `select aluno_id from public.pagamentos where id='${UUID_PAG2}'`))
      .toBe(UUID_ALUNO_B);

    // O VÍNCULO NÃO ENCERRA A CONCILIAÇÃO: o estado fica como estava, e a
    // rodada volta a avaliar o pagamento com o aluno certo.
    expect(await um(db, `select status_conciliacao from public.pagamentos where id='${UUID_PAG2}'`))
      .toBe("SEM_VINCULO");
    expect(await fotoFinanceira(db)).toEqual(antes);

    const a = await um(db, `select to_jsonb(t) from (
      select usuario, detalhes from public.auditoria where acao='CONCILIACAO_ENCAMINHAMENTO') t`);
    expect(a.usuario).toBe(GESTAO);
    expect(a.detalhes.aluno_id).toBe(UUID_ALUNO_B);
    expect(a.detalhes.sem_efeito_financeiro).toBe(true);
  });

  it("fila sem sugestão nenhuma não aprova", async () => {
    await db.exec(`update public.fila_pagamento_sem_vinculo set sugestoes = '[]'::jsonb
                    where pagamento_id='${UUID_PAG2}'`);
    const r = await um(db, `select public.conciliacao_encaminhar_previa('${UUID_PAG2}')`);
    expect(r.aprovado).toBe(false);
    expect(r.bloqueios).toContain("SEM_SUGESTAO_DE_ALUNO");
  });
});
