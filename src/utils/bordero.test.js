// Duas metades, e a segunda é a que importa: a lista de situações protegidas
// existe em DOIS lugares (aqui, na tela, e no gatilho da migration
// 20261008120000) e as duas precisam responder igual — senão a tela promete uma
// proteção que o banco não dá, ou o banco recusa o que a tela deixou passar.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  naoReabreNoBordero, statusNaoReabreNoBordero, motivoDeNaoTocar,
  SITUACOES_QUE_NAO_REABREM,
} from "./bordero";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

describe("borderô não reabre título terminal", () => {
  it("CANCELADA (encerramento administrativo) nunca reabre, como PAGO e EM_CONFIRMACAO", () => {
    expect(naoReabreNoBordero("CANCELADA")).toBe(true);
    expect(naoReabreNoBordero("cancelada")).toBe(true);
    expect(naoReabreNoBordero("PAGO")).toBe(true);
    expect(naoReabreNoBordero("EM_CONFIRMACAO")).toBe(true);
  });

  // Vindo do #662 (09/10/2026), preservado.
  it("DEVOLVIDO também nunca reabre: o desfecho encerrou sem recuperação da ReATIVA", () => {
    expect(naoReabreNoBordero("DEVOLVIDO")).toBe(true);
    expect(naoReabreNoBordero("devolvido")).toBe(true);
    expect(SITUACOES_QUE_NAO_REABREM).toContain("DEVOLVIDO");
  });

  // Também do #662, com UMA assertiva corrigida no merge de 09/10/2026.
  //
  // Lá NEGOCIADO seguia "o fluxo normal do borderô" porque o upsert ainda
  // atualizava título existente. Agora não: a gestão pediu que "a parcela já
  // negociada e paga não volta", NEGOCIADO entrou em
  // SITUACOES_QUE_NAO_REABREM, e a assertiva passa a ser `true`. ABERTO e
  // DUPLICADA continuam `false` -- não são terminais.
  //
  // Vale lembrar por que a lista não é a única defesa: com o importador
  // insert-only, `motivoDeNaoTocar` recusa QUALQUER título existente, mesmo
  // ABERTO. A lista serve para NOMEAR o motivo na tela e para o gatilho do
  // banco, não para decidir sozinha se atualiza.
  it("ABERTO e DUPLICADA seguem o fluxo normal; NEGOCIADO não reabre mais", () => {
    expect(naoReabreNoBordero("ABERTO")).toBe(false);
    expect(naoReabreNoBordero("DUPLICADA")).toBe(false);
    expect(naoReabreNoBordero(null)).toBe(false);
    expect(naoReabreNoBordero("NEGOCIADO")).toBe(true);
    expect(SITUACOES_QUE_NAO_REABREM).toContain("CANCELADA");
  });

  // O defeito de 08/10/2026: NEGOCIADO ficava de fora e era reaberto.
  it("NEGOCIADO não reabre — era o buraco que o upsert explorava", () => {
    expect(naoReabreNoBordero("NEGOCIADO")).toBe(true);
    expect(SITUACOES_QUE_NAO_REABREM).toContain("NEGOCIADO");
  });

  it("quitada, cancelada e devolvida também são terminais pelo `status`", () => {
    expect(statusNaoReabreNoBordero("quitada")).toBe(true);
    expect(statusNaoReabreNoBordero("QUITADA")).toBe(true);
    expect(statusNaoReabreNoBordero("cancelada")).toBe(true);
    expect(statusNaoReabreNoBordero("devolvida")).toBe(true);
    expect(statusNaoReabreNoBordero("em_aberto")).toBe(false);
    expect(statusNaoReabreNoBordero("vinculada")).toBe(false);
  });

  // VENCIDA/quitada existe na base: conferir só `situacao` deixava passar.
  it("VENCIDA com status quitada é protegida pelo status", () => {
    expect(naoReabreNoBordero("VENCIDA")).toBe(false);
    expect(motivoDeNaoTocar({ jaExiste: true, situacaoAtual: "VENCIDA", statusAtual: "quitada" }))
      .toBe("status quitada");
  });
});

describe("motivoDeNaoTocar: a importação não atualiza NENHUM título existente", () => {
  it("título novo passa", () => {
    expect(motivoDeNaoTocar({ jaExiste: false, situacaoAtual: null, statusAtual: null })).toBe(null);
  });

  it("título ABERTO que já existe também é recusado — não só os terminais", () => {
    expect(motivoDeNaoTocar({ jaExiste: true, situacaoAtual: "ABERTO", statusAtual: "em_aberto" }))
      .toBe("título já existe (a importação não atualiza existente)");
  });

  it("o motivo nomeia a situação quando ela é terminal", () => {
    expect(motivoDeNaoTocar({ jaExiste: true, situacaoAtual: "NEGOCIADO", statusAtual: "vinculada" }))
      .toBe("situação NEGOCIADO");
  });
});

// ---------------------------------------------------------------------------
// A tela e o banco respondem a mesma coisa.
//
// Este teste carrega a migration PENDENTE de verdade (não uma cópia do SQL) e
// prova as duas direções que decidem se a trava é correta:
//   1. a importação NÃO reativa nem atualiza título existente;
//   2. `titulo_reavaliar` CONTINUA podendo devolver NEGOCIADO -> ABERTO, que é
//      regra de negócio em produção desde 20260925123852.
// Se alguém "endurecer" a trava e cegar o (2), este teste cai.
// ---------------------------------------------------------------------------
describe("gatilho do banco: importação não reativa, motor legítimo continua", () => {
  async function banco() {
    const db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;

      create table public.auditoria (
        id bigserial primary key, usuario text, acao text, tabela_afetada text,
        registro_id uuid, detalhes jsonb, created_at timestamptz not null default now());
      create table public.acordos_titulos (
        id uuid primary key default gen_random_uuid(),
        aluno_id uuid, cpf text, documento text, vencimento date,
        valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
        valor_cobranca_ajustado numeric, situacao text, status text,
        tipo_boleto text, acordo_id uuid, importacao_id uuid, observacao text,
        origem_liquidacao text, origem_encerramento text, motivo_ajuste text,
        constraint acordos_titulos_documento_key unique (documento));
      create table public.acordo_titulo_vinculo (
        id uuid primary key default gen_random_uuid(), titulo_id uuid, acordo_id uuid, ativo boolean);
      create table public.parcelas (
        id uuid primary key default gen_random_uuid(), boleto text, status text,
        acordo_id uuid, aluno_id uuid, valor numeric);
      create table public.alunos (
        id uuid primary key default gen_random_uuid(), cpf text, status_atual text,
        status_jornada text, status_acionamento text);
      -- Schema REAL de produção, lido em 09/10/2026 (ahattpqrjmhkzsmnbdzs).
      -- NÃO existe cancelado_em — a fixture anterior inventava essa coluna, e
      -- com isso o teste passava enquanto a migration abortaria na aplicação
      -- com 42703. O cancelamento definitivo mora nos status_*.
      create table public.casos (
        id uuid primary key default gen_random_uuid(), aluno_id uuid, quitado_em date,
        encerrado_operacional boolean, nao_acionar boolean,
        status_atual text, status_acionamento text,
        status_financeiro text, status_jornada text, status_termo text);

      create function public.extracao_documento_norm(p_documento text) returns text
        language sql immutable as $$ select nullif(ltrim(coalesce(p_documento,''),'0'),'') $$;
      create function public.app_pode_borderos_importacoes() returns boolean
        language sql stable as $$ select true $$;

      -- os tres gatilhos preexistentes, so para a PROVA 4.3 da migration achar
      create function public._noop() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger trg_titulo_em_confirmacao_protegido before update on public.acordos_titulos
        for each row execute function public._noop();
      create trigger trg_titulo_encerrado_administrativo_protegido before update on public.acordos_titulos
        for each row execute function public._noop();
      create trigger trg_titulo_liquidado_na_origem_e_terminal before update on public.acordos_titulos
        for each row execute function public._noop();
    `);
    // a migration PENDENTE, como está no disco
    await db.exec(
      ler("supabase/aguardando_aprovacao/20261008120000_protecao_importacao_nao_reativa.sql.pendente")
    );
    return db;
  }

  it("NEGOCIADO sobrevive à assinatura do borderô (reescrita de importacao_id)", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.acordos_titulos
        (documento, situacao, status, valor_original, saldo_corrigido, importacao_id)
      values ('4000002','NEGOCIADO','vinculada', 200, 200, '11111111-1111-1111-1111-111111111111');
    `);
    // exatamente o que o upsert do bordero fazia
    await db.exec(`
      update public.acordos_titulos
         set situacao='ABERTO', valor_original=210, saldo_corrigido=210,
             importacao_id='22222222-2222-2222-2222-222222222222'
       where documento='4000002';
    `);
    const { rows } = await db.query(
      `select situacao, status, saldo_corrigido::float8 as saldo, importacao_id::text as lote
         from public.acordos_titulos where documento='4000002'`
    );
    expect(rows[0].situacao).toBe("NEGOCIADO");
    expect(rows[0].status).toBe("vinculada");
    expect(rows[0].saldo).toBe(200);                                  // valor NÃO foi sobrescrito
    expect(rows[0].lote).toBe("11111111-1111-1111-1111-111111111111"); // provência preservada

    const { rows: aud } = await db.query(
      `select detalhes->>'motivo' as motivo, detalhes->>'marca' as marca from public.auditoria
        where acao='TITULO_IMPORTACAO_REATIVACAO_RECUSADA'`
    );
    expect(aud).toHaveLength(1);
    expect(aud[0].motivo).toBe("situacao=NEGOCIADO");
    expect(aud[0].marca).toBe("importacao_id");
  });

  it("título ABERTO existente não é atualizado pela importação (GUC acesa)", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.acordos_titulos (documento, situacao, status, valor_original, saldo_corrigido)
      values ('4000001','ABERTO','em_aberto', 100, 100);
    `);
    await db.exec(`
      begin;
      select set_config('reativa.importando','on', true);
      update public.acordos_titulos set valor_original=999, saldo_corrigido=999, vencimento='2027-01-01'
       where documento='4000001';
      commit;
    `);
    const { rows } = await db.query(
      `select saldo_corrigido::float8 as saldo, vencimento from public.acordos_titulos where documento='4000001'`
    );
    expect(rows[0].saldo).toBe(100);
    expect(rows[0].vencimento).toBe(null);
    // não protegido => no-op silenciosa, sem poluir a auditoria
    const { rows: aud } = await db.query(
      `select count(*)::int as n from public.auditoria where acao='TITULO_IMPORTACAO_REATIVACAO_RECUSADA'`
    );
    expect(aud[0].n).toBe(0);
  });

  it("vínculo financeiro ativo protege mesmo com situação não terminal", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.acordos_titulos (id, documento, situacao, status, valor_original, saldo_corrigido)
      values ('33333333-3333-3333-3333-333333333333','4000009','VENCIDA','em_aberto', 300, 300);
      insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo)
      values ('33333333-3333-3333-3333-333333333333', gen_random_uuid(), true);
    `);
    await db.exec(`
      begin;
      select set_config('reativa.importando','on', true);
      update public.acordos_titulos set situacao='ABERTO', saldo_corrigido=310 where documento='4000009';
      commit;
    `);
    const { rows } = await db.query(
      `select situacao, saldo_corrigido::float8 as saldo from public.acordos_titulos where documento='4000009'`
    );
    expect(rows[0].situacao).toBe("VENCIDA");
    expect(rows[0].saldo).toBe(300);
    const { rows: aud } = await db.query(
      `select detalhes->>'motivo' as motivo from public.auditoria
        where acao='TITULO_IMPORTACAO_REATIVACAO_RECUSADA'`
    );
    expect(aud[0].motivo).toBe("vinculo financeiro ativo");
  });

  // O teste que impede "endurecer" a trava até quebrar produção.
  it("titulo_reavaliar CONTINUA devolvendo NEGOCIADO -> ABERTO (regra de 25/09, EM PROD)", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.acordos_titulos (documento, situacao, status, valor_original, saldo_corrigido)
      values ('4000003','NEGOCIADO','vinculada', 400, 400);
    `);
    // acordo cancelado sem pagamento na cadeia: a mensalidade volta.
    // Sem GUC e sem reescrever importacao_id -- o gatilho tem de ser inerte.
    await db.exec(`
      update public.acordos_titulos
         set situacao='ABERTO', status='em_aberto', acordo_id=null
       where documento='4000003';
    `);
    const { rows } = await db.query(
      `select situacao, status from public.acordos_titulos where documento='4000003'`
    );
    expect(rows[0].situacao).toBe("ABERTO");
    expect(rows[0].status).toBe("em_aberto");
  });

  it("a RPC insere só o ausente, é idempotente e não cria aluno", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-000000000001','11111111111','Novo caso'),
        ('aaaaaaaa-0000-0000-0000-000000000003','33333333333','JURIDICO');
      update public.alunos set status_jornada='JURIDICO' where cpf='33333333333';
      insert into public.acordos_titulos (documento, situacao, status, valor_original)
      values ('4000001','ABERTO','em_aberto',100);
    `);
    const linhas = JSON.stringify([
      { documento: "4000001", cpf: "11111111111", valor: 100, venc: "2026-01-10", curso: "G" }, // já existe
      { documento: "4999999", cpf: "11111111111", valor: 900, venc: "2026-09-10", curso: "G" }, // ausente
      { documento: "4888888", cpf: "33333333333", valor: 800, venc: "2026-09-10", curso: "G" }, // aluno jurídico
      { documento: "4777777", cpf: "99999999999", valor: 700, venc: "2026-09-10", curso: "G" }, // CPF sem aluno
      { documento: "123456",  cpf: "11111111111", valor: 60,  venc: null,         curso: "G" }, // legado 6 díg
      { documento: "050308850007", cpf: "11111111111", valor: 50, venc: null,     curso: "G" }, // boleto de ACORDO
    ]);

    const seco = await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-teste', true) as r`, [linhas]);
    expect(seco.rows[0].r).toMatchObject({
      dry_run: true, linhas: 6, ja_existente: 1, protegida: 1,
      ausente_elegivel: 1, divergente: 3, inseridos: 0,
    });
    const nada = await db.query(`select count(*)::int as n from public.acordos_titulos`);
    expect(nada.rows[0].n).toBe(1); // dry-run não gravou

    const vale = await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-teste', false) as r`, [linhas]);
    expect(vale.rows[0].r).toMatchObject({ inseridos: 1 });

    const { rows: novo } = await db.query(
      `select situacao, status, saldo_corrigido::float8 as saldo, aluno_id::text as aluno
         from public.acordos_titulos where documento='4999999'`);
    expect(novo[0]).toMatchObject({ situacao: "ABERTO", status: "em_aberto", saldo: 900 });
    expect(novo[0].aluno).toBe("aaaaaaaa-0000-0000-0000-000000000001");

    // IDEMPOTÊNCIA: repetir insere 0
    const outra = await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-teste', false) as r`, [linhas]);
    expect(outra.rows[0].r).toMatchObject({ inseridos: 0 });

    // não criou aluno nenhum
    const { rows: al } = await db.query(`select count(*)::int as n from public.alunos`);
    expect(al[0].n).toBe(2);
  });

  it("o índice normalizado recusa o mesmo documento com zero à esquerda", async () => {
    const db = await banco();
    await db.exec(`insert into public.acordos_titulos (documento, situacao) values ('4039712','ABERTO');`);
    await expect(
      db.exec(`insert into public.acordos_titulos (documento, situacao) values ('04039712','ABERTO');`)
    ).rejects.toThrow(/ux_acordos_titulos_documento_norm|duplicate key/i);
  });

  // -------------------------------------------------------------------------
  // PROTEGIDA é decisão de NÃO COBRAR, não "caso tratado".
  //
  // Amanda, 08/10/2026: "quando entra uma nova parcela precisamos trabalhar
  // ela". Até 09/10 a RPC tratava QUITADO, QUITADO_MANUAL,
  // `casos.encerrado_operacional` e `casos.quitado_em` como protegidos — e
  // descartava em silêncio a mensalidade nova desses alunos. Dívida real que
  // ninguém cobraria.
  //
  // Este teste trava os DOIS lados de uma vez: se alguém devolver quitado para
  // a lista, a primeira metade cai; se alguém tirar jurídico, suspensão,
  // cancelamento ou `nao_acionar`, a segunda cai.
  // -------------------------------------------------------------------------
  it("mensalidade nova de aluno quitado ENTRA; quem a gestão decidiu não cobrar fica fora", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual, status_jornada) values
        ('bbbbbbbb-0000-0000-0000-000000000001','10000000001','Novo caso','QUITADO'),
        ('bbbbbbbb-0000-0000-0000-000000000002','10000000002','Novo caso','QUITADO_MANUAL'),
        ('bbbbbbbb-0000-0000-0000-000000000003','10000000003','Novo caso','Em cobranca'),
        ('bbbbbbbb-0000-0000-0000-000000000004','10000000004','Novo caso','Em cobranca'),
        ('bbbbbbbb-0000-0000-0000-000000000005','10000000005','JURIDICO','JURIDICO'),
        ('bbbbbbbb-0000-0000-0000-000000000006','10000000006','Novo caso','SUSPENSAO_COBRANCA'),
        ('bbbbbbbb-0000-0000-0000-000000000007','10000000007','Novo caso','CANCELAMENTO_COBRANCA'),
        ('bbbbbbbb-0000-0000-0000-000000000008','10000000008','Novo caso','Em cobranca'),
        ('bbbbbbbb-0000-0000-0000-000000000009','10000000009','Novo caso','Em cobranca');
      -- 3 e 4: quitação registrada no CASO, não no status. Também entram.
      insert into public.casos (aluno_id, quitado_em, encerrado_operacional) values
        ('bbbbbbbb-0000-0000-0000-000000000003','2026-07-01', false),
        ('bbbbbbbb-0000-0000-0000-000000000004', null,        true);
      -- 8 e 9: decisão de não cobrar, registrada no caso. Ficam fora.
      --   8 = cancelamento definitivo, que mora no status do caso — não em
      --       uma coluna cancelado_em, que não existe em produção;
      --   9 = antecipação de semestre, que é o que antecipacao_semestre_aplicar
      --       grava (nao_acionar = true).
      insert into public.casos (aluno_id, status_atual, nao_acionar) values
        ('bbbbbbbb-0000-0000-0000-000000000008','CANCELAMENTO COBRANCA', false),
        ('bbbbbbbb-0000-0000-0000-000000000009', null,                   true);
    `);

    const linha = (doc, cpf) =>
      ({ documento: doc, cpf, valor: 500, venc: "2026-09-10", curso: "G" });
    const linhas = JSON.stringify([
      linha("5000001", "10000000001"), // QUITADO               -> entra
      linha("5000002", "10000000002"), // QUITADO_MANUAL        -> entra
      linha("5000003", "10000000003"), // caso.quitado_em       -> entra
      linha("5000004", "10000000004"), // encerrado_operacional -> entra
      linha("5000005", "10000000005"), // JURIDICO              -> fora
      linha("5000006", "10000000006"), // SUSPENSAO_COBRANCA    -> fora
      linha("5000007", "10000000007"), // CANCELAMENTO_COBRANCA -> fora
      linha("5000008", "10000000008"), // caso CANCELAMENTO      -> fora
      linha("5000009", "10000000009"), // caso.nao_acionar      -> fora
    ]);

    const seco = await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-protegida', true) as r`, [linhas]);
    expect(seco.rows[0].r).toMatchObject({
      ausente_elegivel: 4, protegida: 5, divergente: 0, ja_existente: 0,
    });

    await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-protegida', false) as r`, [linhas]);

    const { rows: entraram } = await db.query(
      `select documento from public.acordos_titulos
        where documento like '50000%' order by documento`);
    expect(entraram.map((r) => r.documento)).toEqual(
      ["5000001", "5000002", "5000003", "5000004"]);

    // E o que entrou entra COBRÁVEL: ABERTO/em_aberto com saldo. Sem saldo o
    // título nasce invisível para as rotinas que leem coalesce(saldo_corrigido,0).
    const { rows: novo } = await db.query(
      `select situacao, status, saldo_corrigido::float8 as saldo
         from public.acordos_titulos where documento='5000001'`);
    expect(novo[0]).toMatchObject({ situacao: "ABERTO", status: "em_aberto", saldo: 500 });
  });
});
