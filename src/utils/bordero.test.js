// Duas metades, e a segunda é a que importa: a lista de situações protegidas
// existe em DOIS lugares (aqui, na tela, e no gatilho da migration
// 20261027120000) e as duas precisam responder igual — senão a tela promete uma
// proteção que o banco não dá, ou o banco recusa o que a tela deixou passar.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  naoReabreNoBordero, statusNaoReabreNoBordero, motivoDeNaoTocar,
  SITUACOES_QUE_NAO_REABREM,
  cpfConfiavel, motivoDeAnalise, fichasParaCriar,
  titulosNovosParaImportar,
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
describe("identidade: nome não vincula, e CPF não confirmável não cria dívida", () => {
  // Decisões da gestão de 27/10/2026, regras 1 e 2. A regra 5 ("separar para
  // análise, sem criar dívida") é o efeito das duas juntas.

  it("cpfConfiavel aceita o que o padding recupera e recusa o que não identifica", () => {
    // 11 dígitos: o caso normal
    expect(cpfConfiavel("12345678901")).toBe(true);
    expect(cpfConfiavel("123.456.789-01")).toBe(true);
    // 10 e 9 dígitos: o Excel comeu o zero à esquerda. `chaveCpf` recupera com
    // padStart, e é por isso que ACEITAR aqui é o certo -- exigir 11 crus
    // rejeitaria aluno legítimo cujo CPF começa com zero.
    expect(cpfConfiavel("1234567890")).toBe(true);
    expect(cpfConfiavel("123456789")).toBe(true);
    // menos de 9: não há padding que invente o que falta
    expect(cpfConfiavel("12345678")).toBe(false);
    expect(cpfConfiavel("123")).toBe(false);
    // ausente
    expect(cpfConfiavel("")).toBe(false);
    expect(cpfConfiavel(null)).toBe(false);
    expect(cpfConfiavel(undefined)).toBe(false);
    // mais de 11: CNPJ ou lixo -- não é CPF de aluno e não se chuta
    expect(cpfConfiavel("12345678901234")).toBe(false);
    // preenchimento de formulário, não identidade
    expect(cpfConfiavel("00000000000")).toBe(false);
    expect(cpfConfiavel("11111111111")).toBe(false);
  });

  it("regra 2: linha sem CPF confirmável NÃO gera ficha -- vai para análise", () => {
    const linhas = [
      { nome: "Com CPF",        cpfOriginal: "12345678901", cpfLimpo: "12345678901" },
      { nome: "Zero comido",    cpfOriginal: "1234567890",  cpfLimpo: "01234567890" },
      { nome: "Sem CPF",        cpfOriginal: "",            cpfLimpo: null },
      { nome: "CPF truncado",   cpfOriginal: "123",         cpfLimpo: "00000000123" },
      { nome: "CPF de fachada", cpfOriginal: "00000000000", cpfLimpo: "00000000000" },
      { nome: "CNPJ",           cpfOriginal: "12345678901234", cpfLimpo: "12345678901234" },
    ];
    const { registros, linhasEmAnalise } = fichasParaCriar(linhas);

    // só os dois confirmáveis criam cadastro
    expect(registros).toHaveLength(2);
    expect(registros.map((r) => r.nome)).toEqual(["Com CPF", "Zero comido"]);
    // o zero à esquerda é recuperado no cadastro
    expect(registros[1].cpf).toBe("01234567890");

    // os outros quatro NÃO criam nada
    expect(linhasEmAnalise.map((l) => l.nome)).toEqual([
      "Sem CPF", "CPF truncado", "CPF de fachada", "CNPJ",
    ]);
  });

  it("regra 2: UM cadastro por CPF segue valendo, por mais linhas que o CPF tenha", () => {
    // o borderô tem uma linha por TÍTULO; quem deve 3 mensalidades aparece 3x
    const linhas = [
      { nome: "Aluna", cpfOriginal: "12345678901", cpfLimpo: "12345678901" },
      { nome: "Aluna", cpfOriginal: "123.456.789-01", cpfLimpo: "12345678901" },
      { nome: "Aluna", cpfOriginal: "12345678901", cpfLimpo: "12345678901" },
    ];
    const { registros, linhasEmAnalise } = fichasParaCriar(linhas);
    expect(registros).toHaveLength(1);
    expect(linhasEmAnalise).toHaveLength(0);
  });

  it("regra 1: cadastro com o mesmo nome NÃO vincula -- só sugere", () => {
    // `aluno` é o que o preview resolveu POR CPF. Com ele nulo e uma sugestão
    // por nome, a linha vai para análise com o motivo -- nunca para o homônimo.
    //
    // O CPF aqui é CONFIRMÁVEL e só não tem cadastro: é o que isola o ramo do
    // nome. (Na primeira versão deste teste usei 99999999999, dígito repetido,
    // e o motivo devolvido foi o do CPF -- comportamento certo, dado errado.)
    expect(motivoDeAnalise({
      cpfOriginal: "98765432100", aluno: null,
      sugestaoPorNome: { id: "x", nome: "Maria Silva" },
    })).toMatch(/existe cadastro com o mesmo nome/);

    // identidade comprovada por CPF: não é análise
    expect(motivoDeAnalise({
      cpfOriginal: "12345678901", aluno: { id: "y" }, sugestaoPorNome: null,
    })).toBeNull();

    // sem CPF: o motivo é esse, não o nome
    expect(motivoDeAnalise({ cpfOriginal: "", aluno: null, sugestaoPorNome: null }))
      .toBe("linha sem CPF");

    // CPF que não confirma: o motivo diz quantos dígitos vieram, para a
    // conferência manual não ter de adivinhar
    expect(motivoDeAnalise({ cpfOriginal: "123", aluno: null, sugestaoPorNome: null }))
      .toBe("CPF não confirmável (3 dígitos)");
  });
});

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
    // As migrations PENDENTES, como estão no disco. São DUAS desde 27/10/2026:
    // a RPC `mensalidades_ausentes_inserir` saiu da proteção para um artefato
    // próprio (ela é o veículo da reimportação, não da proteção, e tem três
    // decisões de dado em aberto). Os testes carregam as duas porque provam a
    // cadeia inteira; em produção a proteção vai primeiro.
    await db.exec(
      ler("supabase/aguardando_aprovacao/20261027120000_protecao_importacao_nao_reativa.sql.pendente")
    );
    await db.exec(
      ler("supabase/aguardando_aprovacao/20261027120001_mensalidades_ausentes_inserir.sql.pendente")
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
      dry_run: true, linhas_arquivo: 6, ja_existente: 1, protegida: 1,
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

  // 27/10/2026: esta asserção MUDOU, e o motivo importa.
  //
  // Antes: inserir '04039712' quando já existe '4039712' tinha de LEVANTAR
  // (violação de ux_acordos_titulos_documento_norm). Isso continua sendo o que
  // o índice faria — mas a tela grava em lotes de 500 com
  // `ON CONFLICT (documento)`, e ON CONFLICT declarado para UM índice não
  // absorve violação de OUTRO: o 23505 abortava as 500 linhas, inclusive as
  // 499 legítimas. Era a ressalva 1 do parecer do Guardião de 27/10/2026.
  //
  // Agora a guarda BEFORE INSERT da seção 1b pula a linha e registra. O
  // resultado financeiro é o MESMO (a duplicata não entra) sem derrubar o lote.
  //
  // A unicidade NÃO foi enfraquecida — exigência da gestão de 27/10/2026 — e
  // este teste prova as duas coisas juntas: o índice continua único, e a
  // tentativa não vira erro.
  // Regressão da 4ª revisão do Guardião (27/10/2026), MEDIDA em PGlite antes
  // de ser corrigida: a §3 deduplicava `_origem` por `distinct on (documento)`
  // — grafia CRUA. Duas grafias da mesma chave normalizada no MESMO arquivo
  // sobreviviam as duas, os dois `not exists` (que só veem o estado comitado)
  // deixavam passar, e o `insert` único disparava a guarda na segunda linha —
  // com a GUC acesa, levantando e abortando a carga inteira.
  //
  // O sintoma era o pior possível: o dry-run prometia 2 inseridos e a execução
  // entregava 0 + erro, perdendo também a linha legítima. A prévia é o
  // instrumento de segurança da gestão; uma prévia que não prevê não serve.
  it("§3: grafias com valor IDÊNTICO colapsam em uma, sem abortar", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-000000000001','11111111111','Novo caso');`);

    // MESMO valor e MESMO vencimento: não há divergência, só repetição.
    const linhas = JSON.stringify([
      { documento: "04039712", cpf: "11111111111", valor: 200, venc: "2026-09-10", curso: "G" },
      { documento: "4039712",  cpf: "11111111111", valor: 200, venc: "2026-09-10", curso: "G" },
    ]);

    const seco = await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-colapso', true) as r`, [linhas]);
    expect(seco.rows[0].r).toMatchObject({
      linhas_arquivo: 2, linhas_classificadas: 1,
      colapsado_repeticao_identica: 1, ausente_elegivel: 1, inseridos: 0,
    });

    const vale = await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-colapso', false) as r`, [linhas]);
    expect(vale.rows[0].r).toMatchObject({ inseridos: 1 });

    const { rows } = await db.query(`select count(*)::int as n from public.acordos_titulos`);
    expect(rows[0].n).toBe(1);
  });

  // ---- As QUATRO DECISÕES da gestão de 27/10/2026 -------------------------

  it("decisão 2: grafias da mesma chave com VALOR diferente viram DIVERGENTE", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-000000000001','11111111111','Novo caso');`);

    // Antes, `order by valor desc` escolhia 200 e descartava 100 sem rastro --
    // resolvia a divergência do arquivo PARA CIMA, inflando dívida.
    const linhas = JSON.stringify([
      { documento: "04039712", cpf: "11111111111", valor: 200, venc: "2026-09-10", curso: "G" },
      { documento: "4039712",  cpf: "11111111111", valor: 100, venc: "2026-09-10", curso: "G" },
    ]);

    const r = (await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-div', false) as r`, [linhas]
    )).rows[0].r;
    expect(r).toMatchObject({ divergente: 1, ausente_elegivel: 0, inseridos: 0 });

    // nada entrou: a divergência aparece na prévia e fica para análise
    const { rows } = await db.query(`select count(*)::int as n from public.acordos_titulos`);
    expect(rows[0].n).toBe(0);
  });

  it("decisão 2: vencimento diferente também é DIVERGENTE (não só o valor)", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-000000000001','11111111111','Novo caso');`);
    const linhas = JSON.stringify([
      { documento: "04039712", cpf: "11111111111", valor: 200, venc: "2026-09-10", curso: "G" },
      { documento: "4039712",  cpf: "11111111111", valor: 200, venc: "2026-10-10", curso: "G" },
    ]);
    const r = (await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-div2', false) as r`, [linhas]
    )).rows[0].r;
    expect(r).toMatchObject({ divergente: 1, inseridos: 0 });
  });

  it("decisão 1: CPF em DOIS alunos vira CPF_AMBIGUO, e a prévia NÃO dobra", async () => {
    const db = await banco();
    // Dois cadastros para o mesmo CPF -- um com máscara, um sem. Não há índice
    // único em alunos.cpf (17 casos medidos em produção em 02/09/2026).
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-00000000000a','11111111111','Novo caso'),
        ('aaaaaaaa-0000-0000-0000-00000000000b','111.111.111-11','Novo caso');`);

    const linhas = JSON.stringify([
      { documento: "4999999", cpf: "11111111111", valor: 900, venc: "2026-09-10", curso: "G" },
    ]);

    const r = (await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-amb', false) as r`, [linhas]
    )).rows[0].r;

    // UMA linha de arquivo continua UMA linha. Antes o join multiplicava e a
    // prévia prometia 2 / R$ 1.800 para uma linha de R$ 900.
    expect(r).toMatchObject({
      linhas_arquivo: 1, linhas_classificadas: 1,
      cpf_ambiguo: 1, ausente_elegivel: 0, inseridos: 0,
      valor_ausente_elegivel: 0,
    });

    // não escolheu nenhum dos dois cadastros
    const { rows } = await db.query(`select count(*)::int as n from public.acordos_titulos`);
    expect(rows[0].n).toBe(0);
  });

  it("decisão 3: documento só de zeros é REJEITADO e contado, não vira título", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-000000000001','11111111111','Novo caso');`);

    // '0000000' tem chave normalizada NULA. Antes, `distinct on` tratava os
    // NULL como iguais, um sobrevivia, o filtro `^[0-9]{6,13}$` o aceitava --
    // e virava dívida com documento que nunca poderia ser baixada.
    const linhas = JSON.stringify([
      { documento: "0000000",  cpf: "11111111111", valor: 10,  venc: "2026-09-10", curso: "G" },
      { documento: "00000000", cpf: "11111111111", valor: 20,  venc: "2026-09-10", curso: "G" },
      { documento: "4999999",  cpf: "11111111111", valor: 900, venc: "2026-09-10", curso: "G" },
    ]);

    const r = (await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-zeros', false) as r`, [linhas]
    )).rows[0].r;
    expect(r).toMatchObject({
      linhas_arquivo: 3, rejeitado_documento_invalido: 2,
      linhas_classificadas: 1, ausente_elegivel: 1, inseridos: 1,
    });

    // entrou só o legítimo; nenhum documento de zeros virou título
    const { rows } = await db.query(
      `select documento from public.acordos_titulos order by documento`);
    expect(rows).toHaveLength(1);
    expect(rows[0].documento).toBe("4999999");
  });

  it("a prévia FECHA por soma -- e a RPC aborta se não fechar", async () => {
    const db = await banco();
    await db.exec(`
      insert into public.alunos (id, cpf, status_atual) values
        ('aaaaaaaa-0000-0000-0000-000000000001','11111111111','Novo caso'),
        ('aaaaaaaa-0000-0000-0000-00000000000c','33333333333','JURIDICO');
      update public.alunos set status_jornada='JURIDICO' where cpf='33333333333';
      insert into public.acordos_titulos (documento, situacao, status, valor_original)
      values ('4000001','ABERTO','em_aberto',100);`);

    const linhas = JSON.stringify([
      { documento: "4000001", cpf: "11111111111", valor: 100, venc: null, curso: "G" }, // já existe
      { documento: "4999999", cpf: "11111111111", valor: 900, venc: null, curso: "G" }, // ausente
      { documento: "4888888", cpf: "33333333333", valor: 800, venc: null, curso: "G" }, // protegida
      { documento: "123456",  cpf: "11111111111", valor: 60,  venc: null, curso: "G" }, // divergente
      { documento: "0000",    cpf: "11111111111", valor: 5,   venc: null, curso: "G" }, // rejeitado
    ]);

    const r = (await db.query(
      `select public.mensalidades_ausentes_inserir($1::jsonb, 'lote-soma', true) as r`, [linhas]
    )).rows[0].r;

    // o invariante que a 5ª revisão exigiu: os grupos somam com o
    // classificado, e o arquivo fecha com rejeitado + colapsado + grupos.
    const grupos = r.ja_existente + r.protegida + r.ausente_elegivel
                 + r.divergente + r.cpf_ambiguo;
    expect(grupos).toBe(r.linhas_classificadas);
    expect(r.linhas_arquivo).toBe(
      r.rejeitado_documento_invalido + r.colapsado_repeticao_identica + grupos);
    expect(r).toMatchObject({ linhas_arquivo: 5, rejeitado_documento_invalido: 1 });
  });

  it("duplicata normalizada é recusada sem erro, registrada, e o índice segue ÚNICO", async () => {
    const db = await banco();
    await db.exec(`insert into public.acordos_titulos (documento, situacao) values ('4039712','ABERTO');`);

    // 1) o índice existe E é único: a unicidade não pode ter sido afrouxada
    const { rows: idx } = await db.query(
      `select x.indisunique as unico
         from pg_class c join pg_index x on x.indexrelid = c.oid
        where c.relname = 'ux_acordos_titulos_documento_norm'`);
    expect(idx).toHaveLength(1);
    expect(idx[0].unico).toBe(true);

    // 2) a tentativa NÃO levanta -- é isso que salva as outras 499 do lote
    await expect(
      db.exec(`insert into public.acordos_titulos (documento, situacao) values ('04039712','ABERTO');`)
    ).resolves.toBeDefined();

    // 3) e a duplicata NÃO entrou: segue um título só sob a chave normalizada
    const { rows: tit } = await db.query(
      `select count(*)::int as n
         from public.acordos_titulos
        where public.extracao_documento_norm(documento) = '4039712'`);
    expect(tit[0].n).toBe(1);

    // 4) a recusa foi REGISTRADA: pular em silêncio seria ocultar divergência
    const { rows: aud } = await db.query(
      `select detalhes->>'documento_existente' as existente,
              detalhes->>'documento_recusado'  as recusado,
              detalhes->>'chave_normalizada'   as chave
         from public.auditoria
        where acao = 'TITULO_DUPLICADO_NORMALIZADO_RECUSADO'`);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({
      existente: "4039712",
      recusado: "04039712",
      chave: "4039712",
    });
  });

  // -------------------------------------------------------------------------
  // B1 — recálculo de saldo. A migration 20261009210000 foi REPROVADA pelo
  // Guardião em 27/10/2026 por fome de fila e por falha silenciosa no gatilho.
  // Estes dois testes carregam a migration corrigida de verdade (não uma cópia
  // do SQL) e provam os dois pontos.
  // -------------------------------------------------------------------------
  async function bancoB1() {
    const db = await banco();
    await db.exec(`
      create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
      create function public.usuario_e_gestao() returns boolean language sql stable as $$ select true $$;
      -- Dublê de recalcular_situacao_aluno. A de produção tem assinatura
      -- (p_aluno_id uuid, p_lote text) returns jsonb -- CONFERIDA no catálogo
      -- em 27/10/2026. Aqui ela falha de propósito para o aluno marcado, que é
      -- o caso que a fome de fila explorava.
      create table public._recalc_chamadas (aluno_id uuid, lote text, em timestamptz default now());
      create function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text)
        returns jsonb language plpgsql as $$
        begin
          insert into public._recalc_chamadas (aluno_id, lote) values (p_aluno_id, p_lote);
          if p_aluno_id = 'bbbbbbbb-0000-0000-0000-00000000000f'::uuid then
            raise exception 'falha proposital do dublê';
          end if;
          return jsonb_build_object('ok', true);
        end $$;
    `);
    await db.exec(
      ler("supabase/aguardando_aprovacao/20261009210000_recalculo_de_saldo_por_titulo.sql")
    );
    return db;
  }

  it("B1: o aluno que falha NÃO monopoliza a fila e sai no teto de 3 tentativas", async () => {
    const db = await bancoB1();
    const bom  = "bbbbbbbb-0000-0000-0000-000000000001";
    const ruim = "bbbbbbbb-0000-0000-0000-00000000000f";
    await db.exec(`
      insert into public.recalculo_saldo_pendente (aluno_id, origem) values
        ('${ruim}','teste'), ('${bom}','teste');`);

    // 1ª passada: o bom é processado e SAI; o ruim fica, com tentativas = 1
    const p1 = (await db.query(`select public.recalculo_saldo_pendente_processar(10,'t1') as r`)).rows[0].r;
    expect(p1).toMatchObject({ processados: 1, com_erro: 1, restantes: 1, desistidos: 0 });

    const tent = async () => (await db.query(
      `select tentativas, ultimo_erro from public.recalculo_saldo_pendente where aluno_id='${ruim}'`
    )).rows[0];
    expect((await tent()).tentativas).toBe(1);
    expect((await tent()).ultimo_erro).toMatch(/falha proposital/);

    // 2ª e 3ª passadas levam ao teto
    await db.query(`select public.recalculo_saldo_pendente_processar(10,'t2')`);
    await db.query(`select public.recalculo_saldo_pendente_processar(10,'t3')`);
    expect((await tent()).tentativas).toBe(3);

    // 4ª passada: NÃO tenta mais. É isto que impede o giro infinito das 10
    // voltas de 500 que a tela faz.
    const p4 = (await db.query(`select public.recalculo_saldo_pendente_processar(10,'t4') as r`)).rows[0].r;
    expect(p4).toMatchObject({ processados: 0, com_erro: 0, restantes: 0, desistidos: 1 });

    // `restantes: 0` é o sinal que faz a tela parar de girar; e a linha não foi
    // perdida -- continua na tabela, contada em `desistidos`.
    const { rows: fila } = await db.query(
      `select count(*)::int as n from public.recalculo_saldo_pendente`);
    expect(fila[0].n).toBe(1);

    // O bom foi chamado UMA vez e saiu da fila -- não é rechamado a cada passada.
    const { rows: chBom } = await db.query(
      `select count(*)::int as n from public._recalc_chamadas where aluno_id='${bom}'`);
    expect(chBom[0].n).toBe(1);

    // ACHADO DESTE TESTE, e ele justifica a coluna `ultimo_erro`:
    // o rastro das chamadas que FALHARAM não sobrevive. O `raise` do recálculo
    // reverte a subtransação do bloco `begin ... exception` do dreno, e com ela
    // qualquer escrita feita dentro da chamada -- inclusive um log que a
    // própria função tentasse gravar.
    const { rows: chRuim } = await db.query(
      `select count(*)::int as n from public._recalc_chamadas where aluno_id='${ruim}'`);
    expect(chRuim[0].n).toBe(0);
    // Logo `recalculo_saldo_pendente.ultimo_erro` / `tentativas`, escritos pelo
    // dreno DEPOIS do rollback da subtransação, são o único registro durável de
    // que aquele aluno falhou. Sem eles a falha seria invisível -- que era
    // exatamente o apontamento do Guardião.
    expect((await tent()).ultimo_erro).toMatch(/falha proposital/);
  });

  it("B1: falha ao enfileirar vira linha em auditoria e NÃO derruba a gravação do título", async () => {
    const db = await bancoB1();
    // força o enfileiramento a falhar, que é o caminho que antes caía em
    // `exception when others then null` e desaparecia
    await db.exec(`alter table public.recalculo_saldo_pendente
                     add constraint ck_falha_proposital check (false) not valid;
                   alter table public.recalculo_saldo_pendente validate constraint ck_falha_proposital;`);

    // a dívida TEM de ser gravada: saldo é campo derivado, fail-soft é correto
    await db.exec(`insert into public.acordos_titulos (aluno_id, documento, situacao)
                   values ('bbbbbbbb-0000-0000-0000-000000000002','7777777','ABERTO');`);
    const { rows: t } = await db.query(
      `select count(*)::int as n from public.acordos_titulos where documento='7777777'`);
    expect(t[0].n).toBe(1);

    // ...mas a falha NÃO é silenciosa
    const { rows: aud } = await db.query(
      `select detalhes->>'tg_op' as op, detalhes->>'sqlstate' as estado,
              detalhes->>'erro' as erro
         from public.auditoria where acao = 'RECALCULO_FILA_ENFILEIRAR_FALHOU'`);
    expect(aud).toHaveLength(1);
    expect(aud[0].op).toBe("INSERT");
    expect(aud[0].erro).toMatch(/ck_falha_proposital|check constraint/i);
  });

  // -------------------------------------------------------------------------
  // BLOQUEIO B — acordo não pode nascer subdeclarado.
  //
  // Determinação da gestão em 27/10/2026: "Não autorizo aceitar o risco de
  // acordos com valor_total, qtd_parcelas ou saldo subdeclarados, mesmo com
  // monitoramento."
  //
  // O mecanismo do defeito, em `importar_acordos` (20260917200000):
  //   :880-884  recalcula fila_acordos_confirmar.qtd_parcelas e valor_total
  //             AGREGANDO acordos_titulos where importacao_id = p_importacao_id
  //   :887-890  cria public.acordos com valor_total, qtd_parcelas e
  //             saldo = f.valor_total
  // Título pulado pela guarda FALTA no agregado -> acordo subdeclarado.
  //
  // Boleto de acordo é `0`+`5`+acordo(6)+seq(4) — começa com ZERO, que é a
  // forma que extracao_documento_norm colapsa. Os dois testes usam esse
  // formato de verdade, com e sem o zero à esquerda.
  // -------------------------------------------------------------------------
  const LOTE_ANTIGO = "11111111-0000-0000-0000-000000000001";
  const LOTE_NOVO   = "22222222-0000-0000-0000-000000000002";

  async function comAcordoPreexistente(db) {
    // título de acordo que JÁ está na base, grafia de 12 dígitos (sem o zero)
    await db.exec(`
      insert into public.acordos_titulos
        (documento, situacao, tipo_boleto, valor_em_aberto, importacao_id)
      values ('512345600009','ABERTO','Acordo', 500, '${LOTE_ANTIGO}');`);
  }

  // o agregado que `importar_acordos` faz para montar o acordo
  const agregado = async (db, lote) => (await db.query(
    `select count(*)::int as qtd_parcelas,
            coalesce(sum(coalesce(valor_em_aberto, valor_original, 0)),0)::float8 as valor_total
       from public.acordos_titulos
      where importacao_id = '${lote}' and tipo_boleto = 'Acordo'`)).rows[0];

  it("B: na importação de ACORDOS a colisão ABORTA o lote inteiro -- nada parcial é gravado", async () => {
    const db = await banco();
    await comAcordoPreexistente(db);

    // O lote novo traz DOIS títulos: um legítimo e um cuja chave normalizada
    // colide com o preexistente, só pela grafia (zero à esquerda).
    // `reativa.importando` acesa = assinatura de `importar_acordos`.
    // Os statements vão separados de propósito: num `exec` único, o `commit`
    // seguinte vem depois do erro e o PGlite reporta "current transaction is
    // aborted", mascarando a mensagem que se quer provar.
    await db.exec(`begin; select set_config('reativa.importando','on', true);`);

    // a linha legítima entra primeiro
    await db.exec(`
      insert into public.acordos_titulos
        (documento, situacao, tipo_boleto, valor_em_aberto, importacao_id)
      values ('512345600010','ABERTO','Acordo', 700, '${LOTE_NOVO}');`);

    // a colidente LEVANTA, com a mensagem rastreável que a gestão pediu
    await expect(db.exec(`
      insert into public.acordos_titulos
        (documento, situacao, tipo_boleto, valor_em_aberto, importacao_id)
      values ('0512345600009','ABERTO','Acordo', 500, '${LOTE_NOVO}');`)
    ).rejects.toThrow(/TITULO_DUPLICADO_NORMALIZADO_NA_IMPORTACAO/);

    // a mensagem nomeia as DUAS grafias e a chave -- é o que torna o erro
    // acionável sem precisar de auditoria (que o rollback levaria embora)
    await expect(db.exec(`
      insert into public.acordos_titulos (documento, situacao) values ('0512345600009','ABERTO');`)
    ).rejects.toThrow(/current transaction is aborted/);

    // `importar_acordos` não tem handler em volta do insert, então a transação
    // reverte inteira -- é o que o rollback abaixo representa.
    await db.exec(`rollback;`);

    // NADA do lote ficou -- nem o título legítimo que entrou ANTES do erro.
    // É isso que significa "sem gravar acordo parcial": o agregado de
    // :880-884 não encontra lote nenhum, então :887-890 não cria acordo.
    expect(await agregado(db, LOTE_NOVO)).toMatchObject({
      qtd_parcelas: 0, valor_total: 0,
    });

    // e o título preexistente segue intacto, com a grafia original
    const { rows: antigo } = await db.query(
      `select documento, valor_em_aberto::float8 as v from public.acordos_titulos
        where importacao_id = '${LOTE_ANTIGO}'`);
    expect(antigo).toHaveLength(1);
    expect(antigo[0]).toMatchObject({ documento: "512345600009", v: 500 });
  });

  it("B (controle negativo): sem o ramo que aborta, o agregado nasceria SUBDECLARADO", async () => {
    const db = await banco();
    await comAcordoPreexistente(db);

    // MESMO cenário, mas SEM a GUC -- é o ramo da tela de borderô, onde pular
    // é correto. Serve de controle negativo: mostra o número que `importar_acordos`
    // veria se a colisão fosse pulada em vez de abortada.
    await db.exec(`
      insert into public.acordos_titulos
        (documento, situacao, tipo_boleto, valor_em_aberto, importacao_id)
      values ('512345600010','ABERTO','Acordo', 700, '${LOTE_NOVO}');`);
    await db.exec(`
      insert into public.acordos_titulos
        (documento, situacao, tipo_boleto, valor_em_aberto, importacao_id)
      values ('0512345600009','ABERTO','Acordo', 500, '${LOTE_NOVO}');`);

    // O arquivo trouxe 2 títulos somando 1.200. O agregado vê 1 e 700.
    // ESTE é o acordo subdeclarado que a gestão recusou: valor_total 700 em vez
    // de 1.200, qtd_parcelas 1 em vez de 2, e `saldo = valor_total` junto.
    expect(await agregado(db, LOTE_NOVO)).toMatchObject({
      qtd_parcelas: 1, valor_total: 700,
    });

    // a diferença está registrada, não perdida -- este ramo audita
    const { rows: aud } = await db.query(
      `select detalhes->>'documento_recusado' as recusado
         from public.auditoria
        where acao = 'TITULO_DUPLICADO_NORMALIZADO_RECUSADO'`);
    expect(aud).toHaveLength(1);
    expect(aud[0].recusado).toBe("0512345600009");

    // E é exatamente por isso que o ramo da GUC levanta: aqui, na mensalidade,
    // 700 é o número certo (o título de 500 já existe com a outra grafia e a
    // dívida não deve dobrar); no acordo, 700 é o número ERRADO, porque
    // `acordos.valor_total` e `acordos.saldo` saem dele.
  });

  it("grafia IDÊNTICA não é tocada pela guarda -- segue o ON CONFLICT do chamador", async () => {
    const db = await banco();
    await db.exec(`insert into public.acordos_titulos (documento, situacao) values ('4039712','ABERTO');`);
    // mesmo documento, mesma grafia: a guarda devolve NEW e quem resolve é o
    // ON CONFLICT (documento) de sempre. Sem o `on conflict` aqui, o UNIQUE
    // cru levanta -- e é o comportamento histórico, que não se mexeu.
    await expect(
      db.exec(`insert into public.acordos_titulos (documento, situacao) values ('4039712','ABERTO');`)
    ).rejects.toThrow(/duplicate key|acordos_titulos_documento_key/i);
    // e a guarda não registrou nada: não houve divergência de grafia
    const { rows: aud } = await db.query(
      `select count(*)::int as n from public.auditoria
        where acao = 'TITULO_DUPLICADO_NORMALIZADO_RECUSADO'`);
    expect(aud[0].n).toBe(0);
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

// ---------------------------------------------------------------------------
// O INDICADOR DA PRÉVIA ("Títulos novos para importar")
// ---------------------------------------------------------------------------
//
// O indicador não tem regra própria: ele conta o que `confirmarImportacao` vai
// gravar. Este bloco existe para prender os dois. O `selecionaComoOLaco`
// abaixo é a transcrição dos descartes do laço de `registrosTitulos` em
// Borderos.jsx -- se alguém mudar o laço e não mudar o utilitário (ou o
// contrário), o primeiro teste quebra.
describe("indicador: títulos novos para importar", () => {
  // transcrição dos três `continue` do laço de gravação, nesta ordem
  function selecionaComoOLaco(linhas) {
    const chaves = new Set();
    const saida = [];
    for (const linha of linhas) {
      if (motivoDeNaoTocar(linha)) continue;              // já existe / terminal
      if (linha.origemMatch === "analise") continue;       // aluno irresolvível
      const chave = String(linha.numTitulo ?? "").trim().replace(/^0+/, "") || null;
      if (chave) {
        if (chaves.has(chave)) continue;                   // repetido no lote
        chaves.add(chave);
      }
      saida.push(linha);
    }
    return saida;
  }

  const LOTE = [
    // entram
    { numTitulo: "5001", valor: 100.5,  jaExiste: false, origemMatch: "cpf" },
    { numTitulo: "5002", valor: 200.25, jaExiste: false, origemMatch: "novo" },
    // não entram
    { numTitulo: "5003", valor: 999,    jaExiste: true,  origemMatch: "cpf", situacaoAtual: "ABERTO",    statusAtual: "em_aberto" },
    { numTitulo: "5004", valor: 999,    jaExiste: true,  origemMatch: "cpf", situacaoAtual: "CANCELADA", statusAtual: "cancelada" },
    { numTitulo: "5005", valor: 999,    jaExiste: false, origemMatch: "analise" },
    // mesma chave normalizada do 5001: a segunda grafia não entra duas vezes
    { numTitulo: "05001", valor: 100.5, jaExiste: false, origemMatch: "cpf" },
  ];

  it("conta o mesmo que o laço de gravação, linha por linha", () => {
    const esperado = selecionaComoOLaco(LOTE);
    const { quantidade, valor } = titulosNovosParaImportar(LOTE);

    expect(quantidade).toBe(esperado.length);
    expect(valor).toBeCloseTo(esperado.reduce((s, l) => s + l.valor, 0), 2);
  });

  it("os 4 descartes são os esperados: existente, terminal, análise e grafia repetida", () => {
    const { quantidade, valor } = titulosNovosParaImportar(LOTE);
    expect(quantidade).toBe(2);
    expect(valor).toBeCloseTo(300.75, 2);
  });

  it("valor ilegível não derruba a contagem -- entra como zero", () => {
    // a linha VAI ser gravada de qualquer forma (`valor_original: linha.valor`),
    // então esconder a linha por causa do valor seria pior do que somar zero
    const { quantidade, valor } = titulosNovosParaImportar([
      { numTitulo: "6001", valor: null,        jaExiste: false, origemMatch: "cpf" },
      { numTitulo: "6002", valor: "quarenta",  jaExiste: false, origemMatch: "cpf" },
      { numTitulo: "6003", valor: 40.4,        jaExiste: false, origemMatch: "cpf" },
    ]);
    expect(quantidade).toBe(3);
    expect(valor).toBeCloseTo(40.4, 2);
  });

  it("lote vazio ou nulo dá zero, não explode", () => {
    expect(titulosNovosParaImportar([])).toEqual({ quantidade: 0, valor: 0 });
    expect(titulosNovosParaImportar(null)).toEqual({ quantidade: 0, valor: 0 });
  });

  it("borderô inteiro já existente: zero para importar, e o indicador diz isso", () => {
    const todosExistentes = ["7001", "7002", "7003"].map((d) => ({
      numTitulo: d, valor: 500, jaExiste: true, origemMatch: "cpf",
      situacaoAtual: "ABERTO", statusAtual: "em_aberto",
    }));
    expect(titulosNovosParaImportar(todosExistentes)).toEqual({ quantidade: 0, valor: 0 });
  });
});
