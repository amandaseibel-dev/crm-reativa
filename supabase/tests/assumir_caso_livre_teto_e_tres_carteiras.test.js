// ASSUMIR ATENDIMENTO: teto oficial e as tres carteiras -- teste de comportamento.
//
// Roda a MIGRATION REAL
// (supabase/migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql)
// e o ROLLBACK REAL num PostgreSQL real (PGlite), sobre duas fixtures com o
// texto EXATO de producao, cada corpo conferido por md5 do `prosrc`:
//
//   fidelizacao_por_dono_prod_20260930  -- 37 funcoes, 21 tabelas e os 12
//     gatilhos de `casos`, inclusive `trigger_impor_teto_operador`, e as guardas
//     que decidem tudo: caso_protegido_redistribuicao,
//     caso_encerrado_operacional, caso_aguarda_confirmacao_financeira,
//     saldo_titulos_aberto, calibragem_teto_operador, carteira_geral_email;
//   assumir_caso_livre_prod_20261020    -- o que nasceu depois de 30/09: a
//     coluna casos.giro_fidelizacao_ate e 6 funcoes, entre elas a propria
//     assumir_caso_livre e internal.patch_funcao_ancorada.
//
// Nada de duble nas regras. Unico stub: auth.jwt(), que a fixture resolve por
// GUC para o teste "entrar" como cada pessoa -- infraestrutura, nao regra.
//
// NENHUM DADO REAL: operadores sao os e-mails de operacao, alunos e CPFs sao
// inventados, UUIDs sequenciais.
//
// A migration NAO FOI APLICADA em banco nenhum. Este teste e a unica coisa que
// a executa, num banco efemero que morre no fim.
//
// FUSO = UTC, como producao. `caso_em_giro_fidelizacao` compara com
// America/Sao_Paulo, entao fuso solto faria o mesmo teste passar aqui e falhar
// no CI. Tem de vir antes de instanciar o PGlite.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql");
const MD5_BASE = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const COMPLEMENTO = ler("supabase/tests/fixtures/assumir_caso_livre_prod_20261020.sql");
const MD5_COMPL = JSON.parse(ler("supabase/tests/fixtures/assumir_caso_livre_prod_20261020.md5.json"));
const MIGRATION = ler("supabase/migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql");
const ROLLBACK = ler("supabase/rollbacks/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.rollback.sql");

// Operadores ATIVOS; CG, OLGA e GESTAO sao as tres carteiras de livre assuncao.
const LUANA = "cobranca05@aelbra.com.br";
const MAURICIO = "cobranca06@aelbra.com.br";
const OLGA = "cobranca03@aelbra.com.br";
const GESTAO = "amanda.seibel@aelbra.com.br";
const CG = "carteira.geral@reativa.local";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(20000000000 + n);

// A fixture resolve auth.jwt() lendo `request.jwt.claims`, como o PostgREST.
const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

const assumir = (db, casoId) =>
  q1(db, "select * from public.assumir_caso_livre($1)", [casoId]);

// Base do teto: a MESMA que trg_impor_teto_operador cobra.
const ativos = async (db, email) =>
  Number((await q1(db,
    `select count(*)::int n from public.casos c where c.operador_email = $1
       and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
       and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)`,
    [email])).n);

async function construir() {
  const db = new PGlite({ extensions: ext });
  await db.exec(FIXTURE);
  await db.exec(COMPLEMENTO);

  // PORTAO DE FIDELIDADE: se qualquer corpo divergir de producao, para aqui.
  const rows = await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries({ ...MD5_BASE, ...MD5_COMPL })) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ('LUANA',    '${LUANA}',    'operador', true,  'LUANA',    true),
      ('MAURICIO', '${MAURICIO}', 'operador', true,  'MAURICIO', true),
      ('OLGA',     '${OLGA}',     'operador', false, 'OLGA',     false),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null,     false);
    -- Teto da gestao, baixo de proposito: testar o teto com 3 casos em vez de 700.
    insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '3'::jsonb)
      on conflict (chave) do update set valor = excluded.valor;
  `);
  return db;
}

// aluno + titulo ABERTO com saldo + caso. Por padrao: elegivel.
async function cenario(db, n, o = {}) {
  const {
    dono = null, saldo = 500, naoAcionar = false, statusAtual = null,
    statusAcion = null, giroAte = null, dua = "2026-08-01", retorno = "2026-11-20",
    donoAcordo = null, tabulado = true,
  } = o;
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome)
     values ($1,$2,$3,$4,$5,'DONO')`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, dono]);
  if (saldo > 0) {
    await db.query(
      `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento,
          valor_original, saldo_corrigido, situacao, status)
       values ($1,$2,$3,'2026-03-10',$4,$4,'ABERTO','em_aberto')`,
      [U(n), cpf, `DOC${n}`, saldo]);
  }
  if (donoAcordo) {
    await db.query(
      `insert into public.acordos (aluno_id, cpf, status, numero_acordo, operador_responsavel_email, valor_total)
       values ($1,$2,'QUITADO',$3,$4,100)`,
      [U(n), cpf, 90000 + n, donoAcordo]);
  }
  const caso = await q1(db,
    `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email, status_atual,
        status_acionamento, nao_acionar, data_ultimo_acionamento, data_retorno,
        giro_fidelizacao_ate, ultima_tabulacao_em, caso_codigo)
     values ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [U(n), cpf, `Aluno Sintetico ${n}`, dono, statusAtual, statusAcion, naoAcionar,
     dua, retorno, giroAte, tabulado ? "2026-08-01T10:00:00" : null, n]);
  return caso.id;
}

let SEM; // producao de hoje, sem a migration
let COM; // com a migration aplicada

beforeAll(async () => {
  const b1 = await construir();
  SEM = await b1.dumpDataDir();
  await b1.close();

  const b2 = await construir();
  await b2.exec(MIGRATION);
  COM = await b2.dumpDataDir();
  await b2.close();
});

const abrirSem = () => new PGlite({ loadDataDir: SEM, extensions: ext });
const abrirCom = () => new PGlite({ loadDataDir: COM, extensions: ext });

describe("a linha de base de produção tem os dois defeitos", () => {
  it("hoje, caso da Carteira Geral NÃO pode ser assumido", async () => {
    const db = await abrirSem();
    const caso = await cenario(db, 1, { dono: CG });
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("ja foi assumido por outro operador");
    await db.close();
  });

  it("hoje, o mesmo vale para a carteira da Olga e a da gestão", async () => {
    const db = await abrirSem();
    const a = await cenario(db, 2, { dono: OLGA });
    const b = await cenario(db, 3, { dono: GESTAO });
    await como(db, LUANA);
    expect((await assumir(db, a)).sucesso).toBe(false);
    expect((await assumir(db, b)).sucesso).toBe(false);
    await db.close();
  });

  it("hoje, o teto oficial é IGNORADO e quem paga a conta é o gatilho", async () => {
    const db = await abrirSem();
    for (const n of [10, 11, 12]) await cenario(db, n, { dono: LUANA });
    const novo = await cenario(db, 13, { dono: null });
    expect(await ativos(db, LUANA)).toBe(3);

    await como(db, LUANA);
    const r = await assumir(db, novo);

    // O 500 literal nao ve o teto de 3, entao a funcao ACEITA assumir.
    expect(r.sucesso).toBe(true);
    // E `trigger_impor_teto_operador` tem de limpar a sujeira depois, soltando
    // OUTRO caso da carteira do operador -- um caso que ele nao pediu para
    // largar. A carga volta ao teto, mas por compensacao, nao por decisao.
    const liberou = await qn(db,
      "select acao from public.historico_operadores_alunos where acao='LIBERACAO_AUTOMATICA_TETO_EXCEDIDO'");
    expect(liberou.length).toBe(1);
    expect(await ativos(db, LUANA)).toBe(3);
    await db.close();
  });
});

describe("as três carteiras passam a ser de livre assunção", () => {
  it("Carteira Geral: assume na hora, sem esperar 10 dias", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 20, { dono: CG });
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(true);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [caso])).e).toBe(LUANA);
    await db.close();
  });

  it("carteira da Olga (operador inativo) e carteira da gestão (perfil ≠ operador)", async () => {
    const db = await abrirCom();
    const a = await cenario(db, 21, { dono: OLGA });
    const b = await cenario(db, 22, { dono: GESTAO });
    await como(db, LUANA);
    expect((await assumir(db, a)).sucesso).toBe(true);
    expect((await assumir(db, b)).sucesso).toBe(true);
    await db.close();
  });

  it("a trilha diz de qual carteira o caso saiu", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 23, { dono: CG });
    await como(db, LUANA);
    await assumir(db, caso);
    const h = await q1(db,
      `select acao, observacao from public.historico_operadores_alunos
        where acao='ASSUMIR_ATENDIMENTO' order by criado_em desc limit 1`);
    expect(h.acao).toBe("ASSUMIR_ATENDIMENTO");
    expect(h.observacao).toContain("Assumido de Carteira Geral");
    expect(h.observacao).toContain("Fidelizacao inicia apenas apos acionamento valido");
    await db.close();
  });

  it("o caso conta imediatamente na carga do operador", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 24, { dono: CG });
    const antes = await ativos(db, LUANA);
    await como(db, LUANA);
    await assumir(db, caso);
    expect(await ativos(db, LUANA)).toBe(antes + 1);
    await db.close();
  });
});

describe("as proteções continuam barrando — inclusive nas três carteiras", () => {
  it("`nao_acionar` é recusado mesmo na Carteira Geral", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 30, { dono: CG, naoAcionar: true });
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("nao elegivel");
    await db.close();
  });

  it("restrição jurídica é recusada mesmo na Carteira Geral", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 31, { dono: CG, statusAtual: "JURIDICO" });
    await como(db, LUANA);
    expect((await assumir(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("suspensão de cobrança é recusada mesmo na Carteira Geral", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 32, { dono: CG, statusAtual: "SUSPENSAO COBRANCA" });
    await como(db, LUANA);
    expect((await assumir(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("sem saldo em aberto é recusado", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 33, { dono: CG, saldo: 0 });
    await como(db, LUANA);
    expect((await assumir(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("caso de OUTRO operador ativo continua recusado — é o que protege a fidelização do colega", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 34, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("ja foi assumido por outro operador");
    await db.close();
  });

  it("marca de giro VIVA continua recusada, com a mesma mensagem", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 35, { dono: MAURICIO, giroAte: "2099-12-31" });
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("fidelizado pelo giro de carteira");
    await db.close();
  });

  it("operador com a carteira fechada para casos novos é recusado", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 36, { dono: CG });
    await db.query("update public.usuarios set recebe_novos_casos=false where email=$1", [LUANA]);
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("carteira esta fechada");
    await db.close();
  });
});

describe("o teto oficial passa a valer, e a operação é atômica", () => {
  it("abaixo do teto, assume e fica exatamente no teto", async () => {
    const db = await abrirCom();
    for (const n of [40, 41] ) await cenario(db, n, { dono: LUANA });
    const novo = await cenario(db, 42, { dono: CG });
    expect(await ativos(db, LUANA)).toBe(2);

    await como(db, LUANA);
    const r = await assumir(db, novo);

    expect(r.sucesso).toBe(true);
    expect(await ativos(db, LUANA)).toBe(3); // teto = 3
    await db.close();
  });

  it("no teto, troca: libera um caso nunca tabulado e assume o novo", async () => {
    const db = await abrirCom();
    for (const n of [50, 51] ) await cenario(db, n, { dono: LUANA });
    await cenario(db, 52, { dono: LUANA, tabulado: false }); // o candidato a liberacao
    const novo = await cenario(db, 53, { dono: CG });
    expect(await ativos(db, LUANA)).toBe(3);

    await como(db, LUANA);
    const r = await assumir(db, novo);

    expect(r.sucesso).toBe(true);
    expect(r.caso_liberado).toBeTruthy();
    expect(await ativos(db, LUANA)).toBe(3); // continua no teto
    const h = await qn(db,
      "select acao from public.historico_operadores_alunos where acao='LIBERACAO_TROCA_ASSUMIR'");
    expect(h.length).toBe(1);
    await db.close();
  });

  it("acima do teto e sem caso para trocar: recusa dizendo o teto vigente", async () => {
    const db = await abrirCom();
    for (const n of [60, 61, 62] ) await cenario(db, n, { dono: LUANA });
    const novo = await cenario(db, 63, { dono: CG });
    expect(await ativos(db, LUANA)).toBe(3);

    await como(db, LUANA);
    // Todos os casos do operador foram tabulados: nao ha candidato a liberacao.
    const r = await assumir(db, novo);

    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("Carteira cheia (3 casos)");
    // ATOMICIDADE: nada ficou pela metade.
    expect(await ativos(db, LUANA)).toBe(3);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [novo])).e).toBe(CG);
    expect(Number((await q1(db,
      "select count(*)::int n from public.historico_operadores_alunos")).n)).toBe(0);
    await db.close();
  });

  it("com a migration, a recusa vem ANTES de escrever: o gatilho não precisa compensar", async () => {
    const db = await abrirCom();
    for (const n of [70, 71, 72] ) await cenario(db, n, { dono: LUANA });
    const novo = await cenario(db, 74, { dono: CG });
    expect(await ativos(db, LUANA)).toBe(3);

    await como(db, LUANA);
    const r = await assumir(db, novo);

    // A diferenca pratica em relacao a linha de base: a funcao RECUSA olhando o
    // teto, em vez de aceitar e deixar `trigger_impor_teto_operador` soltar um
    // caso qualquer da carteira do operador para caber.
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("Carteira cheia (3 casos)");
    const liberou = await qn(db,
      "select acao from public.historico_operadores_alunos where acao='LIBERACAO_AUTOMATICA_TETO_EXCEDIDO'");
    expect(liberou.length).toBe(0);
    expect(await ativos(db, LUANA)).toBe(3);
    await db.close();
  });

  it("a linha do caso é travada para escrita durante a assunção", async () => {
    const db = await abrirCom();
    const def = (await q1(db,
      `select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='assumir_caso_livre'`)).d;
    // PGlite e de uma conexao so: duas sessoes de verdade nao sao simulaveis
    // aqui. O que este teste garante e que o `for update` -- a trava que impede
    // dois operadores de assumirem o mesmo caso -- nao foi removido pelo patch.
    expect(def).toContain("where c.id = p_caso_id for update");
    expect(def).toContain("limit 1 for update skip locked");
    await db.close();
  });
});

describe("o que a migration NÃO toca", () => {
  it("titularidade financeira do acordo fica idêntica", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 80, { dono: CG, donoAcordo: MAURICIO });
    const antes = await qn(db, "select id, operador_responsavel_email e from public.acordos order by id");
    await como(db, LUANA);
    expect((await assumir(db, caso)).sucesso).toBe(true);
    const depois = await qn(db, "select id, operador_responsavel_email e from public.acordos order by id");
    expect(depois).toEqual(antes);
    expect(depois[0].e).toBe(MAURICIO);
    await db.close();
  });

  it("`data_ultimo_acionamento`, retorno e a marca de giro ficam intactos", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 81, { dono: CG, dua: "2026-08-01", retorno: "2026-11-20" });
    await como(db, LUANA);
    await assumir(db, caso);
    const c = await q1(db,
      `select data_ultimo_acionamento::text dua, data_retorno::text ret, giro_fidelizacao_ate g
         from public.casos where id=$1`, [caso]);
    expect(c.dua).toBe("2026-08-01");
    expect(c.ret).toBe("2026-11-20");
    expect(c.g).toBeNull();
    await db.close();
  });

  it("nenhuma outra função foi alterada pela migration", async () => {
    const sem = await abrirSem();
    const com = await abrirCom();
    const corpos = async (db) => Object.fromEntries((await qn(db,
      `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal')`)).map((r) => [r.nome, r.md5]));
    const a = await corpos(sem);
    const b = await corpos(com);
    const mudaram = Object.keys(a).filter((k) => a[k] !== b[k]);
    expect(mudaram).toEqual(["public.assumir_caso_livre"]);
    await sem.close();
    await com.close();
  });
});

describe("o rollback devolve o estado anterior", () => {
  it("depois do rollback, a Carteira Geral volta a ser inassumível", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    const caso = await cenario(db, 90, { dono: CG });
    await como(db, LUANA);
    const r = await assumir(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("ja foi assumido por outro operador");
    await db.close();
  });

  it("o rollback devolve o corpo byte a byte do de produção", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    const md5 = (await q1(db,
      `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='assumir_caso_livre'`)).m;
    expect(md5).toBe(MD5_COMPL["public.assumir_caso_livre"]);
    await db.close();
  });
});

describe("a migration é idempotente", () => {
  it("aplicar duas vezes não muda nada e não falha", async () => {
    const db = await abrirCom();
    const antes = (await q1(db,
      `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='assumir_caso_livre'`)).m;
    await db.exec(MIGRATION);
    const depois = (await q1(db,
      `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='assumir_caso_livre'`)).m;
    expect(depois).toBe(antes);
    await db.close();
  });
});
