// ENCERRAMENTO OPERACIONAL: O TEXTO DEIXA DE VALER COMO PROVA DE SALDO ZERO.
//
// Banco real (PGlite) sobre a fixture de producao do grupo A, mais o arquivo de
// alinhamento que traz o texto EXATO de `pg_get_functiondef` das funcoes que a
// fixture de 18/09 nao reproduzia mais. O contrato de md5 cobre OITO funcoes e
// e o que prova que a bancada e producao de 26/10/2026 -- se a transcricao do
// alinhamento estiver errada, estes testes reprovam antes de qualquer assercao.
//
// O QUE ESTE TESTE PROVA, item por item do pedido:
//   1. o texto `SEM SALDO EM ABERTO` deixa de encerrar sem conferencia -- o
//      defeito e REPRODUZIDO antes e corrigido depois, no mesmo cenario;
//   2. suspensao, cancelamento, juridico e `nao_acionar` seguem preservados;
//   3. o congelamento mantem os casos existentes exatamente como estavam;
//   4. a mudanca nao devolve ninguem as carteiras, as distribuicoes nem as
//      acoes massivas -- medido pela resposta do predicado e pelo reabridor;
//   5. duplicidade de caso e de cobranca e barrada, inclusive na porta manual;
//   6. auditoria com data, responsavel, justificativa e estado anterior, e sem
//      inventar o que nao existe (o legado nasce com autor NULO);
//   7. o rollback preserva a trilha.
//
// NENHUM DADO REAL: CPFs, nomes e valores sao inventados.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 90000, hookTimeout: 240000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/grupo_a_prod_20260918.sql");
const ACORDO_CANCELADO = ler("supabase/migrations/20260918000000_acordo_cancelado_nao_cancela_cobranca.sql");
const GRUPO_A = ler("supabase/migrations/20260918150000_grupo_a_confirmacao_prime.sql");
const ALINHAR = ler("supabase/tests/fixtures/encerramento_sem_saldo_alinhar_prod_20261026.sql");
const MD5_ALINHADO = JSON.parse(ler("supabase/tests/fixtures/encerramento_sem_saldo_alinhar_prod_20261026.md5.json"));
const MIGRATION = ler("supabase/migrations/20261026200000_encerramento_sem_saldo_validacao_financeira.sql");
const ROLLBACK = ler("supabase/rollbacks/20261026200000_encerramento_sem_saldo_validacao_financeira.rollback.sql");

// md5(prosrc) medido em PRODUCAO em 26/10/2026.
const MD5_PREDICADO = "adc514c7a018018d866096d8e420d7b3";
const MD5_SALDO_CPF = "ee0d3a1f54b4785e57e0abd86157342f";
const MD5_CANONICA = "1f676604ebeba3561eafc6306e187ba2";
const MD5_REABRIR = "63deeb34b039b9260c0d224b73d9ec81";

const GESTAO = "amanda.seibel@aelbra.com.br";
const OP1 = "cobranca05@aelbra.com.br";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const JUST = "conferido na ficha e no Prime: a divida e real e vai voltar para a fila";

let ANTES; // producao de 26/10, sem a correcao
let DEPOIS; // o mesmo, com a correcao aplicada (sem casos, para congelar nada)

async function base() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  await db.exec(`insert into public.usuarios (nome, email, perfil, ativo) values
    ('Luana', '${OP1}', 'operador', true), ('Amanda', '${GESTAO}', 'gestao', true);`);
  await db.exec(ACORDO_CANCELADO);
  await db.exec(GRUPO_A);
  await db.exec(ALINHAR);
  // O contrato: a bancada reproduz producao (onze funcoes).
  const { rows } = await db.query(
    `select n.nspname||'.'||p.proname as nome, md5(p.prosrc) as md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`
  );
  const noBanco = {};
  for (const r of rows) noBanco[r.nome] = r.md5;
  for (const [nome, md5] of Object.entries(MD5_ALINHADO)) {
    if (noBanco[nome] !== md5) throw new Error(`bancada diverge de producao: ${nome} (${noBanco[nome]} != ${md5})`);
  }
  return db;
}

beforeAll(async () => {
  const a = await base();
  ANTES = await a.dumpDataDir("none");
  await a.close();
  const d = await base();
  await d.exec(MIGRATION);
  DEPOIS = await d.dumpDataDir("none");
  await d.close();
}, 240000);

const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: { unaccent } });
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

const SUB = { [GESTAO]: U(900001), [OP1]: U(900002) };
async function como(db, email, role = "authenticated") {
  const claims = email === null
    ? JSON.stringify({ sub: U(900009), role })
    : JSON.stringify({ email, sub: SUB[email] ?? U(900009), role });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
}
const semJwt = (db) => db.query(`select set_config('request.jwt.claims', '', false)`);

// Um aluno, um caso e, quando pedido, uma mensalidade aberta de verdade.
async function cenario(db, n, o = {}) {
  const aluno = U(n);
  const caso = U(100000 + n);
  const cpf = String(10000000000 + n);
  await db.query(
    `insert into public.alunos (id, nome, cpf, matricula, status_atual, status_jornada, status_acionamento)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [aluno, `Aluno ${n}`, cpf, `M${n}`, o.alunoStatus ?? "SEM_SALDO_EM_ABERTO",
     o.alunoJornada ?? "SEM_SALDO_EM_ABERTO", o.alunoAcionamento ?? "SEM_SALDO_EM_ABERTO"]
  );
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, matricula, operador_email, operador_nome,
                               status_atual, status_acionamento, status_financeiro, status_jornada,
                               encerrado_operacional, nao_acionar, total_em_aberto)
     values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)`,
    [caso, aluno, cpf, `Aluno ${n}`, `M${n}`, o.operador ?? OP1, o.operador === null ? null : "OP",
     o.statusAtual ?? "SEM_SALDO_EM_ABERTO", o.statusAcionamento ?? "SEM_SALDO_EM_ABERTO",
     o.statusFinanceiro ?? null, o.statusJornada ?? "SEM_SALDO_EM_ABERTO",
     o.encerrado ?? true, o.naoAcionar ?? false]
  );
  if (o.divida) {
    await db.query(
      `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
                                           situacao, status, tipo_boleto, created_at)
       values ($1,$2,$3,'2026-03-10',$4,$4,'ABERTO','em_aberto','Mensalidade','2026-01-10')`,
      [aluno, cpf, `D${n}`, o.divida]
    );
  }
  return { aluno, caso, cpf };
}

const predicado5 = async (db, c) =>
  (await q1(db, `select public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                        c.status_financeiro, c.status_jornada) r from public.casos c where c.id = $1`, [c.caso])).r;
const predicado7 = async (db, c) =>
  (await q1(db, `select public.caso_encerrado_operacional(c.aluno_id, c.id, c.cpf_limpo, c.status_atual,
                        c.status_acionamento, c.status_financeiro, c.status_jornada) r
                   from public.casos c where c.id = $1`, [c.caso])).r;
const trilha = (db, c) =>
  q(db, `select classificacao, saldo_no_momento, decidido_por, decidido_em, origem, justificativa,
                estado_anterior, resolvido_em, resolvido_por
           from public.caso_encerramento_sem_saldo where caso_id = $1 order by id`, [c.caso]);
const contarDinheiro = (db) =>
  q1(db, `select (select count(*) from public.acordos)::int a, (select count(*) from public.parcelas)::int p,
                 (select count(*) from public.pagamentos)::int g,
                 (select count(*) from public.acordo_titulo_vinculo)::int v,
                 (select count(*) from public.acordos_titulos)::int t,
                 (select coalesce(sum(saldo_corrigido),0) from public.acordos_titulos)::numeric soma`);
const fotoCasos = (db) =>
  q(db, `select id, status_atual, status_acionamento, status_financeiro, status_jornada,
                encerrado_operacional, nao_acionar from public.casos order by id`);

// ============================================================ a bancada
describe("a bancada", () => {
  it("reproduz producao de 26/10/2026 nas onze funcoes do contrato", async () => {
    const db = await abrir(ANTES);
    for (const [nome, md5] of Object.entries(MD5_ALINHADO)) {
      const r = await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                               where n.nspname='public' and p.proname=$1 limit 1`, [nome.replace("public.", "")]);
      expect(r?.m, nome).toBe(md5);
    }
  });
});

// ============================================================ a migration
describe("a migration", () => {
  it("troca so o predicado e nao cria dinheiro nem altera caso", async () => {
    const db = await abrir(ANTES);
    await cenario(db, 1, { divida: 1000 });
    const dinheiroAntes = await contarDinheiro(db);
    const casosAntes = await fotoCasos(db);
    const md5 = async (f, like) => (await q1(db,
      `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=$1
          and ($2::text is null or pg_get_function_identity_arguments(p.oid) like $2::text) limit 1`, [f, like ?? null]))?.m;

    expect(await md5("caso_encerrado_operacional", "p_cpf%")).toBe(MD5_PREDICADO);
    await db.exec(MIGRATION);

    expect(await md5("caso_encerrado_operacional", "p_cpf%")).not.toBe(MD5_PREDICADO);
    // intactas: a conferencia por CPF, a canonica e o reabridor
    expect(await md5("saldo_titulos_aberto")).toBe(MD5_SALDO_CPF);
    expect(await md5("aluno_saldo_pendente_detalhe")).toBe(MD5_CANONICA);
    // o reabridor E alterado de proposito: ganha a guarda do congelamento
    expect(await md5("casos_reabrir_com_divida")).not.toBe(MD5_REABRIR);
    // nada de dinheiro, nada de caso
    expect(await contarDinheiro(db)).toEqual(dinheiroAntes);
    expect(await fotoCasos(db)).toEqual(casosAntes);
  });

  it("recusa aplicar sobre um predicado que nao e o de producao", async () => {
    const db = await abrir(ANTES);
    await db.exec(`create or replace function public.caso_encerrado_operacional(
                     p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
                   returns boolean language plpgsql stable set search_path to 'public'
                   as $f$ begin return true; end $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/MD5_INESPERADO em caso_encerrado_operacional/);
  });

  it("e idempotente e o rollback devolve o texto de producao preservando a trilha", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 1, { divida: 1000 });
    await db.exec(MIGRATION);
    expect(await trilha(db, c)).toHaveLength(1);

    await db.exec(ROLLBACK);
    const dep = await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                               where n.nspname='public' and p.proname='caso_encerrado_operacional'
                                 and pg_get_function_identity_arguments(p.oid) like 'p_cpf%'`);
    expect(dep.m).toBe(MD5_PREDICADO);
    // a trilha e a leitura ficam; o que escreve sai
    expect(await trilha(db, c)).toHaveLength(1);
    expect((await q1(db, `select to_regclass('public.caso_encerramento_sem_saldo') r`)).r).not.toBeNull();
    expect((await q1(db, `select count(*)::int n from pg_proc p join pg_namespace n2 on n2.oid=p.pronamespace
                           where n2.nspname='public' and p.proname='caso_encerramento_resolver'`)).n).toBe(0);
  });
});

// ============================================================ item 1
describe("o texto deixa de valer como prova de saldo zero", () => {
  it("ANTES: caso com texto e divida real de R$ 1.000 e dado como encerrado", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 1, { divida: 1000 });
    expect(await predicado5(db, c)).toBe(true); // o defeito
  });

  it("DEPOIS, sem congelamento: o mesmo caso deixa de ser encerrado", async () => {
    const db = await abrir(DEPOIS);
    const c = await cenario(db, 1, { divida: 1000 });
    expect(await predicado5(db, c)).toBe(false);
    expect(await predicado7(db, c)).toBe(false);
  });

  it("texto com saldo zero de verdade continua encerrado (os 2.868 nao mudam)", async () => {
    const db = await abrir(DEPOIS);
    const c = await cenario(db, 2); // sem divida
    expect(await predicado5(db, c)).toBe(true);
    expect(await predicado7(db, c)).toBe(true);
  });

  it("SALDO ZERO CONFIRMADO passa a ser conferido, e nao perde efeito quando o saldo e zero", async () => {
    const db = await abrir(DEPOIS);
    const comDivida = await cenario(db, 3, {
      divida: 500, statusAtual: "SALDO_ZERO_CONFIRMADO", statusAcionamento: "SALDO_ZERO_CONFIRMADO",
      statusJornada: "SALDO_ZERO_CONFIRMADO" });
    const semDivida = await cenario(db, 4, {
      statusAtual: "SALDO_ZERO_CONFIRMADO", statusAcionamento: "SALDO_ZERO_CONFIRMADO",
      statusJornada: "SALDO_ZERO_CONFIRMADO" });
    expect(await predicado5(db, comDivida)).toBe(false);
    expect(await predicado5(db, semDivida)).toBe(true);
  });

  it("CPF vazio: as DUAS assinaturas recusam dar saldo zero sem prova", async () => {
    const db = await abrir(DEPOIS);
    // Antes, `saldo_titulos_aberto('')` devolvia 0 e o caso passava por "sem
    // saldo" com divida de R$ 900. Agora CPF vazio nao resolve aluno nenhum e a
    // conferencia devolve NAO COMPROVADO nas duas assinaturas.
    const aluno = U(5), caso = U(100005);
    await db.query(`insert into public.alunos (id,nome,cpf,matricula,status_atual,status_jornada)
                    values ($1,'Aluno 5','','M5','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO')`, [aluno]);
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,matricula,operador_email,
                      status_atual,status_acionamento,status_jornada,encerrado_operacional,total_em_aberto)
                    values ($1,$2,'','','Aluno 5','M5',$3,'SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO',true,0)`,
                   [caso, aluno, OP1]);
    await db.query(`insert into public.acordos_titulos (aluno_id,cpf,documento,vencimento,valor_original,
                      saldo_corrigido,situacao,status,tipo_boleto,created_at)
                    values ($1,'','D5','2026-03-10',900,900,'ABERTO','em_aberto','Mensalidade','2026-01-10')`, [aluno]);
    const c = { caso, aluno };
    expect(await q1(db, `select public.saldo_titulos_aberto('') s`)).toMatchObject({ s: "0" });
    expect(await predicado5(db, c)).toBe(false);
    expect(await predicado7(db, c)).toBe(false);
  });
});

// ============================================================ item 2
describe("as restricoes seguem preservadas", () => {
  for (const [rotulo, campo, valor] of [
    ["juridico no status_atual", "statusAtual", "JURIDICO"],
    ["suspensao de cobranca no status_atual", "statusAtual", "SUSPENSAO_COBRANCA"],
    ["cancelamento de cobranca na jornada", "statusJornada", "CANCELAMENTO_COBRANCA"],
    ["juridico no financeiro", "statusFinanceiro", "JURIDICO"],
  ]) {
    it(`${rotulo}: encerrado mesmo com divida, antes e depois`, async () => {
      for (const dump of [ANTES, DEPOIS]) {
        const db = await abrir(dump);
        const c = await cenario(db, 6, { divida: 5000, [campo]: valor });
        expect(await predicado5(db, c)).toBe(true);
        await db.close();
      }
    });
  }

  it("nao_acionar nunca e reaberto pelo reabridor, antes e depois", async () => {
    for (const dump of [ANTES, DEPOIS]) {
      const db = await abrir(dump);
      const c = await cenario(db, 7, { divida: 2000, naoAcionar: true });
      await como(db, GESTAO);
      const n = (await q1(db, `select public.casos_reabrir_com_divida() r`)).r;
      expect(n).toBe(0);
      expect(await q1(db, `select nao_acionar, encerrado_operacional from public.casos where id=$1`, [c.caso]))
        .toMatchObject({ nao_acionar: true, encerrado_operacional: true });
      await db.close();
    }
  });
});

// ============================================================ itens 3 e 4
describe("congelamento: nada se move no dia da aplicacao", () => {
  it("a migration congela exatamente os casos que mudariam de resposta", async () => {
    const db = await abrir(ANTES);
    const comDivida = await cenario(db, 10, { divida: 1000 });
    const semDivida = await cenario(db, 11);
    const juridico = await cenario(db, 12, { divida: 1000, statusAtual: "JURIDICO" });
    const naoAcionar = await cenario(db, 13, { divida: 1000, naoAcionar: true });
    const outroCaso = await cenario(db, 14, { divida: 1000 });
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,matricula,operador_email,
                      status_atual,encerrado_operacional,total_em_aberto)
                    values ($1,$2,$3,$3,'Aluno 14 bis','M14b',$4,'Em cobrança',false,1000)`,
                   [U(200014), outroCaso.aluno, outroCaso.cpf, OP1]);

    const antes = {};
    for (const c of [comDivida, semDivida, juridico, naoAcionar, outroCaso]) antes[c.caso] = await predicado5(db, c);

    await db.exec(MIGRATION);

    // item 4: a resposta do predicado nao muda para NINGUEM
    for (const c of [comDivida, semDivida, juridico, naoAcionar, outroCaso]) {
      expect(await predicado5(db, c), `caso ${c.caso}`).toBe(antes[c.caso]);
    }
    // e o congelamento pegou so quem precisava, com o motivo certo
    expect((await trilha(db, comDivida))[0]).toMatchObject({ classificacao: "LEGADO_NAO_CONFERIDO" });
    expect((await trilha(db, naoAcionar))[0]).toMatchObject({ classificacao: "NAO_ACIONAR" });
    expect((await trilha(db, outroCaso))[0]).toMatchObject({ classificacao: "OUTRO_CASO_ATIVO" });
    expect(await trilha(db, semDivida)).toHaveLength(0); // passa pela conferencia, nao precisa congelar
    expect(await trilha(db, juridico)).toHaveLength(0);  // a linha 1 sustenta sozinha
  });

  // ITEM 4, medido: com o congelamento, NENHUM caso fica reaberto. O caminho,
  // porem, nao e o desejado -- esta documentado no teste seguinte como defeito
  // aberto, porque deixa rastro enganoso.
  it("com o congelamento, nenhum caso fica reaberto; sem ele, dois ficam", async () => {
    const montar = async (aplicar) => {
      const db = await abrir(ANTES);
      await cenario(db, 15, { divida: 1000 });
      await cenario(db, 16, { divida: 3000 });
      await cenario(db, 18, { divida: 2000, naoAcionar: true });
      await cenario(db, 19, { divida: 2000, statusAtual: "JURIDICO" });
      if (aplicar) await db.exec(MIGRATION);
      await como(db, GESTAO);
      await db.query(`select public.casos_reabrir_com_divida()`);
      const abertos = (await q(db, `select id from public.casos
                                     where not coalesce(encerrado_operacional,false) order by id`)).map((x) => x.id);
      await db.close();
      return abertos;
    };
    expect(await montar(false)).toEqual([U(100015), U(100016)]);
    expect(await montar(true)).toEqual([]);
  });

  it("o reabridor NAO tenta o congelado: nenhum REABERTURA_DIVIDA_NOVA indevido", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 27, { divida: 1000 });
    await db.exec(MIGRATION);
    await como(db, GESTAO);
    const n = (await q1(db, `select public.casos_reabrir_com_divida() r`)).r;

    expect(n).toBe(0); // nao conta como reaberto
    expect(await q1(db, `select encerrado_operacional e from public.casos where id=$1`, [c.caso]))
      .toMatchObject({ e: true });
    expect(await predicado5(db, c)).toBe(true);
    // o rastro enganoso nao existe mais
    const mov = await q(db, `select tipo from public.aluno_movimentacoes
                              where aluno_id = $1 and tipo = 'REABERTURA_DIVIDA_NOVA'`, [c.aluno]);
    expect(mov).toHaveLength(0);
  });

  it("sem a guarda no reabridor, o congelado e SOLTO de verdade", async () => {
    // Prova de que a guarda do reabridor nao e decorativa. Arrancando so ela, o
    // caso congelado e reaberto -- e, com a chave de CPF exigindo coincidencia
    // de status, o recalculo NAO o fecha de volta (os status mudaram, entao o
    // retrato congelado deixa de falar por ele). Resultado: liberacao real de
    // um caso que a gestao ainda nao julgou.
    const db = await abrir(ANTES);
    const c = await cenario(db, 28, { divida: 1000 });
    await db.exec(MIGRATION);
    const def = (await q1(db, `select pg_get_functiondef(p.oid) d from pg_proc p
                                join pg_namespace n on n.oid=p.pronamespace
                               where n.nspname='public' and p.proname='casos_reabrir_com_divida'`)).d;
    await db.exec(def.replace("and not public.caso_encerramento_congelado(c.id)", ""));

    await como(db, GESTAO);
    const n = (await q1(db, `select public.casos_reabrir_com_divida() r`)).r;
    expect(n).toBe(1);
    expect(await q1(db, `select encerrado_operacional e, status_atual s from public.casos where id=$1`, [c.caso]))
      .toMatchObject({ e: false, s: "Em cobrança" });
    // com a guarda (teste anterior) isso nao acontece: 0 reaberturas
  });
});

// ============================================================ cron 8
describe("cron 8: a fidelizacao nao solta quem esta congelado", () => {
  const elegiveis = (db) => q(db, `select caso_id from public.casos_elegiveis_liberacao_fidelizacao()`);

  it("caso com texto e divida NAO entra na lista, antes nem depois", async () => {
    for (const [dump, aplicar] of [[ANTES, false], [ANTES, true]]) {
      const db = await abrir(dump);
      const c = await cenario(db, 30, { divida: 1000 });
      if (aplicar) await db.exec(MIGRATION);
      const lista = (await elegiveis(db)).map((x) => x.caso_id);
      expect(lista, `aplicar=${aplicar}`).not.toContain(c.caso);
      await db.close();
    }
  });

  it("congelado SEM CPF utilizavel: e a guarda por caso_id que o segura", async () => {
    // Sem CPF, a consulta do congelamento por CPF nao acha nada e a conferencia
    // financeira devolve "nao comprovado" -> o predicado diria false e o cron 8
    // soltaria o caso. Quem o segura e `caso_encerramento_congelado(c.id)`.
    const db = await abrir(ANTES);
    const aluno = U(31), caso = U(100031);
    await db.query(`insert into public.alunos (id,nome,cpf,matricula,status_atual,status_jornada,status_acionamento)
                    values ($1,'A31','','M31','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO')`, [aluno]);
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,matricula,operador_email,operador_nome,
                      status_atual,status_acionamento,status_jornada,encerrado_operacional,nao_acionar,total_em_aberto)
                    values ($1,$2,'','','A31','M31',$3,'OP','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO',true,false,0)`,
                   [caso, aluno, OP1]);
    await db.query(`insert into public.acordos_titulos (aluno_id,cpf,documento,vencimento,valor_original,
                      saldo_corrigido,situacao,status,tipo_boleto,created_at)
                    values ($1,'','D31','2026-03-10',900,900,'ABERTO','em_aberto','Mensalidade','2026-01-10')`, [aluno]);
    await db.exec(MIGRATION);

    // congelado por caso_id (e por aluno_id), nao por CPF
    expect((await q1(db, `select public.caso_encerramento_congelado($1) c`, [caso])).c).toBe(true);
    expect((await q1(db, `select public._cpf11('') c`)).c).toBeNull();
    // o predicado de 5 args, que o cron 8 chama, nao tem como achar o congelamento
    expect((await q1(db, `select public.caso_encerrado_operacional('', 'SEM_SALDO_EM_ABERTO',
              'SEM_SALDO_EM_ABERTO', null, 'SEM_SALDO_EM_ABERTO') r`)).r).toBe(false);
    // e mesmo assim o cron 8 nao o solta
    expect((await elegiveis(db)).map((x) => x.caso_id)).not.toContain(caso);
  });

  it("o que o cron 8 ja preservava continua preservado", async () => {
    const db = await abrir(ANTES);
    const naoAcionar = await cenario(db, 32, { divida: 1000, naoAcionar: true });
    const juridico = await cenario(db, 33, { divida: 1000, statusAtual: "JURIDICO" });
    await db.exec(MIGRATION);
    const lista = (await elegiveis(db)).map((x) => x.caso_id);
    expect(lista).not.toContain(naoAcionar.caso);
    expect(lista).not.toContain(juridico.caso);
  });

  it("caso em cobranca normal segue elegivel: a guarda nova nao prende quem nao e congelado", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 34, {
      divida: 1000, encerrado: false, statusAtual: "Em cobrança",
      statusAcionamento: "MENSAGEM_ENVIADA", statusJornada: "Em cobrança",
      alunoStatus: "Em cobrança", alunoJornada: "Em cobrança", alunoAcionamento: "MENSAGEM_ENVIADA" });
    const antes = (await elegiveis(db)).map((x) => x.caso_id);
    await db.exec(MIGRATION);
    const depois = (await elegiveis(db)).map((x) => x.caso_id);
    expect(antes).toContain(c.caso);
    expect(depois).toContain(c.caso); // nao foi congelado, logo nao foi preso
  });
});

// ============================================================ escopo ALUNO
describe("escopo aluno: os sete consumidores que passam alunos.*", () => {
  const predicadoAluno = async (db, aluno) =>
    (await q1(db, `select public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento,
                          null::text, a.status_jornada) r from public.alunos a where a.id = $1`, [aluno])).r;

  it("aluno com texto e divida: encerrado ANTES, e segue encerrado DEPOIS pelo congelamento", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 40, { divida: 2500 });
    expect(await predicadoAluno(db, c.aluno)).toBe(true);
    await db.exec(MIGRATION);
    expect(await predicadoAluno(db, c.aluno)).toBe(true);
    const t = await q(db, `select escopo, classificacao from public.caso_encerramento_sem_saldo
                            where aluno_id = $1 order by escopo`, [c.aluno]);
    expect(t.map((x) => x.escopo)).toEqual(["ALUNO", "CASO"]);
    expect(t.find((x) => x.escopo === "ALUNO").classificacao).toBe("ALUNO_LEGADO_NAO_CONFERIDO");
  });

  it("sem o congelamento, o aluno com divida deixaria de ser encerrado", async () => {
    const db = await abrir(DEPOIS); // migration aplicada com a base vazia: nada congelado
    const c = await cenario(db, 41, { divida: 2500 });
    expect(await predicadoAluno(db, c.aluno)).toBe(false);
  });

  it("aluno com saldo zero continua encerrado, e nao e congelado", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 42); // sem divida
    await db.exec(MIGRATION);
    expect(await predicadoAluno(db, c.aluno)).toBe(true);
    expect(await q(db, `select 1 from public.caso_encerramento_sem_saldo where aluno_id = $1`, [c.aluno]))
      .toHaveLength(0);
  });

  it("devolver o caso a cobranca tambem levanta o congelamento do aluno", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 43, { divida: 1000 });
    await db.exec(MIGRATION);
    expect(await predicadoAluno(db, c.aluno)).toBe(true);

    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver($1,'DEVOLVER_A_COBRANCA',$2) r`,
      [c.caso, JUST])).r;
    expect(r).toMatchObject({ ok: true, congelamento: "RETIRADO", congelamento_aluno_retirado: 1 });
    expect(await predicadoAluno(db, c.aluno)).toBe(false);
    expect(await predicado5(db, c)).toBe(false);
  });
});

// ============================================================ porta do aluno
describe("porta de saida do escopo ALUNO (os 240 sem saida)", () => {
  // O retrato dos 240 medidos em producao: o ALUNO carrega o texto e tem divida,
  // mas o caso dele esta ATIVO -- entao nasce registro de escopo ALUNO e NENHUM
  // de escopo CASO. Era exatamente esse grupo que `caso_encerramento_resolver`
  // nao conseguia alcancar: R$ 316.692,09 sem verbo nenhum capaz de decidir.
  const soAluno = async (db, n) => {
    const c = await cenario(db, n, {
      divida: 2000, encerrado: false, statusAtual: "Em cobrança",
      statusAcionamento: "MENSAGEM_ENVIADA", statusJornada: "Em cobrança",
      alunoStatus: "SEM_SALDO_EM_ABERTO", alunoJornada: "SEM_SALDO_EM_ABERTO",
      alunoAcionamento: "SEM_SALDO_EM_ABERTO" });
    return c;
  };
  const predicadoAluno = async (db, aluno) =>
    (await q1(db, `select public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento,
                          null::text, a.status_jornada) r from public.alunos a where a.id = $1`, [aluno])).r;

  it("o verbo por CASO nao alcanca: e o bloqueio que esta correcao fecha", async () => {
    const db = await abrir(ANTES);
    const c = await soAluno(db, 70);
    await db.exec(MIGRATION);
    const t = await q(db, `select escopo from public.caso_encerramento_sem_saldo
                            where aluno_id = $1 order by escopo`, [c.aluno]);
    expect(t.map((x) => x.escopo)).toEqual(["ALUNO"]); // nenhum registro de CASO

    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver($1,'MANTER_ENCERRADO',$2) r`,
      [c.caso, JUST])).r;
    expect(r).toMatchObject({ ok: false, erro: "SEM_REGISTRO_VIGENTE" });
  });

  it("o verbo por ALUNO resolve: MANTER renova com autor, data e justificativa", async () => {
    const db = await abrir(ANTES);
    const c = await soAluno(db, 71);
    await db.exec(MIGRATION);
    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver_aluno($1,'MANTER_ENCERRADO',$2) r`,
      [c.aluno, "aluno em tratativa institucional, nao cobrar por ora"])).r;
    expect(r).toMatchObject({ ok: true, congelamento: "RENOVADO" });

    const t = await q(db, `select classificacao, decidido_por, decidido_em, resolvido_em, resolvido_por
                             from public.caso_encerramento_sem_saldo
                            where aluno_id = $1 and escopo = 'ALUNO' order by id`, [c.aluno]);
    expect(t).toHaveLength(2);
    expect(t[0].resolvido_por).toBe(GESTAO);
    expect(t[1]).toMatchObject({ classificacao: "MANTIDO_PELA_GESTAO", decidido_por: GESTAO });
    expect(t[1].decidido_em).not.toBeNull();
    expect(await predicadoAluno(db, c.aluno)).toBe(true); // segue congelado
  });

  it("DEVOLVER retira o congelamento e o predicado de nivel aluno diz a verdade", async () => {
    const db = await abrir(ANTES);
    const c = await soAluno(db, 72);
    await db.exec(MIGRATION);
    expect(await predicadoAluno(db, c.aluno)).toBe(true);

    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver_aluno($1,'DEVOLVER_A_COBRANCA',$2) r`,
      [c.aluno, JUST])).r;
    expect(r).toMatchObject({ ok: true, congelamento: "RETIRADO" });
    expect(await predicadoAluno(db, c.aluno)).toBe(false);
    // e nao reabriu caso nenhum: o caso dele ja estava ativo e segue como estava
    expect(await q1(db, `select encerrado_operacional e from public.casos where id=$1`, [c.caso]))
      .toMatchObject({ e: false });
  });

  it("exige gestao, identidade e justificativa de verdade", async () => {
    const db = await abrir(ANTES);
    const c = await soAluno(db, 73);
    await db.exec(MIGRATION);

    await como(db, OP1);
    await expect(db.query(`select public.caso_encerramento_resolver_aluno($1,'MANTER_ENCERRADO',$2)`, [c.aluno, JUST]))
      .rejects.toThrow(/decisao da gestao/);
    await como(db, null, "service_role");
    await expect(db.query(`select public.caso_encerramento_resolver_aluno($1,'MANTER_ENCERRADO',$2)`, [c.aluno, JUST]))
      .rejects.toThrow(/AUTORIA_OBRIGATORIA/);
    await como(db, GESTAO);
    await expect(db.query(`select public.caso_encerramento_resolver_aluno($1,'MANTER_ENCERRADO',$2)`, [c.aluno, "curto"]))
      .rejects.toThrow(/JUSTIFICATIVA_OBRIGATORIA/);
    await expect(db.query(`select public.caso_encerramento_resolver_aluno($1,'INVENTADA',$2)`, [c.aluno, JUST]))
      .rejects.toThrow(/DECISAO_INVALIDA/);

    expect(await q(db, `select 1 from public.caso_encerramento_sem_saldo
                         where aluno_id=$1 and resolvido_em is not null`, [c.aluno])).toHaveLength(0);
  });

  it("registro de ALUNO resolve mesmo se o aluno foi apagado -- nao fica insoluvel", async () => {
    // `aluno_id` nao tem FK: a trilha sobrevive a exclusao do aluno. Se o verbo
    // exigisse o aluno, o registro ficaria sem saida para sempre.
    const db = await abrir(ANTES);
    const c = await soAluno(db, 75);
    await db.exec(MIGRATION);
    expect(await q(db, `select 1 from public.caso_encerramento_sem_saldo
                         where aluno_id=$1 and escopo='ALUNO' and resolvido_em is null`, [c.aluno]))
      .toHaveLength(1);

    await db.query(`delete from public.casos where aluno_id = $1`, [c.aluno]);
    await db.query(`delete from public.acordos_titulos where aluno_id = $1`, [c.aluno]);
    await db.query(`delete from public.alunos where id = $1`, [c.aluno]);

    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver_aluno($1,'MANTER_ENCERRADO',$2) r`,
      [c.aluno, "aluno removido da base; congelamento encerrado por limpeza"])).r;
    expect(r).toMatchObject({ ok: true, congelamento: "RENOVADO" });
    // saldo NULO, que e a verdade: nao ha aluno para medir
    expect(r.saldo_no_momento).toBeNull();
  });

  it("aluno sem registro vigente devolve SEM_REGISTRO_VIGENTE", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 74); // sem divida: nao congela
    await db.exec(MIGRATION);
    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver_aluno($1,'MANTER_ENCERRADO',$2) r`,
      [c.aluno, JUST])).r;
    expect(r).toMatchObject({ ok: false, erro: "SEM_REGISTRO_VIGENTE" });
  });
});

// ============================================================ chave de CPF
describe("a chave de CPF nao contamina caso ativo do mesmo CPF", () => {
  it("caso ATIVO que compartilha CPF com aluno congelado NAO e congelado", async () => {
    // Medido em producao: sem a coincidencia de status, o congelamento de ALUNO
    // atingiria 243 casos ATIVOS que compartilham o CPF (R$ 319.168,86, 242 com
    // operador) -- o oposto do objetivo. Dos 243, zero tem os mesmos status do
    // retrato congelado.
    const db = await abrir(ANTES);
    const alvo = await cenario(db, 60, { divida: 1000 });
    // segundo caso do MESMO CPF, em cobranca normal e ativo
    const outro = U(200060);
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,matricula,operador_email,operador_nome,
                      status_atual,status_acionamento,status_jornada,encerrado_operacional,total_em_aberto)
                    values ($1,$2,$3,$3,'A60 bis','M60b',$4,'OP','Em cobrança','MENSAGEM_ENVIADA','Em cobrança',false,1000)`,
                   [outro, alvo.aluno, alvo.cpf, OP1]);
    const pred = async (id) => (await q1(db, `select public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                      c.status_acionamento, c.status_financeiro, c.status_jornada) r
                      from public.casos c where c.id=$1`, [id])).r;
    expect(await pred(outro)).toBe(false); // ativo antes

    await db.exec(MIGRATION);

    expect(await pred(alvo.caso)).toBe(true);  // o alvo segue congelado
    expect(await pred(outro)).toBe(false);     // o ativo NAO foi contaminado
  });

  it("mesmos status e mesmo CPF: o congelamento alcanca, porque e o mesmo retrato", async () => {
    const db = await abrir(ANTES);
    const alvo = await cenario(db, 61, { divida: 1000 });
    const gemeo = U(200061);
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,matricula,operador_email,operador_nome,
                      status_atual,status_acionamento,status_jornada,encerrado_operacional,total_em_aberto)
                    values ($1,$2,$3,$3,'A61 bis','M61b',$4,'OP','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO',true,0)`,
                   [gemeo, alvo.aluno, alvo.cpf, OP1]);
    await db.exec(MIGRATION);
    const pred = async (id) => (await q1(db, `select public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                      c.status_acionamento, c.status_financeiro, c.status_jornada) r
                      from public.casos c where c.id=$1`, [id])).r;
    expect(await pred(gemeo)).toBe(true);
  });

  it("apagar o caso apaga a linha da trilha em cascata, mas delete direto segue recusado", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 62, { divida: 1000 });
    await db.exec(MIGRATION);
    expect(await trilha(db, c)).toHaveLength(1);

    await expect(db.query(`delete from public.caso_encerramento_sem_saldo where caso_id=$1`, [c.caso]))
      .rejects.toThrow(/TRILHA_IMUTAVEL/);

    // o cascade do caso tem de passar, senao o caso congelado nunca mais some
    await db.query(`delete from public.casos where id=$1`, [c.caso]);
    expect(await trilha(db, c)).toHaveLength(0);
  });
});

// ============================================================ aluno_id nulo
describe("aluno indeterminado e situacao NAO COMPROVADA, nunca saldo zero", () => {
  it("a canonica devolve 0.00 para aluno nulo -- e a conferencia nao cai nessa", async () => {
    const db = await abrir(DEPOIS);
    expect(await q1(db, `select (public.aluno_saldo_pendente_detalhe(null)->>'total') t`))
      .toMatchObject({ t: "0.00" }); // o retorno que enganaria
    expect((await q1(db, `select public._caso_sem_saldo_conferido(null, null) r`)).r).toBe(false);
    expect((await q1(db, `select public._caso_sem_saldo_conferido(null, '') r`)).r).toBe(false);
  });

  it("CPF que nao resolve exatamente um aluno nao vira saldo zero", async () => {
    const db = await abrir(DEPOIS);
    // CPF que nao existe em alunos
    expect((await q1(db, `select public._caso_sem_saldo_conferido(null, '99999999999') r`)).r).toBe(false);
    // CPF duplicado em dois alunos: ambiguo -> nao comprovado
    await db.query(`insert into public.alunos (id,nome,cpf,matricula,status_atual,status_jornada)
                    values ($1,'G1','55555555555','MG1','Em cobrança','Em cobrança'),
                           ($2,'G2','55555555555','MG2','Em cobrança','Em cobrança')`, [U(50), U(51)]);
    expect((await q1(db, `select public._caso_sem_saldo_conferido(null, '55555555555') r`)).r).toBe(false);
  });

  it("CPF que resolve um aluno so usa a canonica dele", async () => {
    const db = await abrir(DEPOIS);
    const semDivida = await cenario(db, 52);
    const comDivida = await cenario(db, 53, { divida: 700 });
    expect((await q1(db, `select public._caso_sem_saldo_conferido(null, $1) r`, [semDivida.cpf])).r).toBe(true);
    expect((await q1(db, `select public._caso_sem_saldo_conferido(null, $1) r`, [comDivida.cpf])).r).toBe(false);
  });
});

// ============================================================ itens 5 e 6
describe("a gestao resolve, com auditoria e sem duplicar cobranca", () => {
  it("o registro legado nasce com autor e data NULOS, sem inventar informacao", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 20, { divida: 1234.56 });
    await db.exec(MIGRATION);
    const [t] = await trilha(db, c);
    expect(t.decidido_por).toBeNull();
    expect(t.decidido_em).toBeNull();
    expect(t.origem).toBe("MIGRATION");
    expect(t.justificativa).toMatch(/NAO consta em nenhum registro/i);
    expect(Number(t.saldo_no_momento)).toBeCloseTo(1234.56, 2);
    // estado anterior registrado de verdade
    expect(t.estado_anterior).toMatchObject({
      status_atual: "SEM_SALDO_EM_ABERTO", encerrado_operacional: true, nao_acionar: false,
    });
  });

  it("MANTER_ENCERRADO renova o congelamento com autor, data e justificativa", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 21, { divida: 1000 });
    await db.exec(MIGRATION);
    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver($1,'MANTER_ENCERRADO',$2) r`,
      [c.caso, "aluno em acordo administrativo com a reitoria, nao cobrar"])).r;
    expect(r).toMatchObject({ ok: true, congelamento: "RENOVADO" });

    const t = await trilha(db, c);
    expect(t).toHaveLength(2);
    expect(t[0].resolvido_em).not.toBeNull();
    expect(t[0].resolvido_por).toBe(GESTAO);
    expect(t[1]).toMatchObject({ classificacao: "MANTIDO_PELA_GESTAO", decidido_por: GESTAO, origem: "GESTAO" });
    expect(t[1].decidido_em).not.toBeNull();
    expect(await predicado5(db, c)).toBe(true); // segue congelado
  });

  it("DEVOLVER_A_COBRANCA retira o congelamento e o predicado passa a dizer a verdade", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 22, { divida: 1000 });
    await db.exec(MIGRATION);
    expect(await predicado5(db, c)).toBe(true);

    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver($1,'DEVOLVER_A_COBRANCA',$2) r`,
      [c.caso, JUST])).r;
    expect(r).toMatchObject({ ok: true, congelamento: "RETIRADO" });
    expect(await predicado5(db, c)).toBe(false);

    // quem devolve de fato e o reabridor, com as travas dele
    const n = (await q1(db, `select public.casos_reabrir_com_divida() r`)).r;
    expect(n).toBe(1);
    expect(await q1(db, `select encerrado_operacional, status_atual from public.casos where id=$1`, [c.caso]))
      .toMatchObject({ encerrado_operacional: false, status_atual: "Em cobrança" });
  });

  it("DEVOLVER_A_COBRANCA e recusado quando criaria um segundo caso aberto para o aluno", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 23, { divida: 1000 });
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,matricula,operador_email,
                      status_atual,encerrado_operacional,total_em_aberto)
                    values ($1,$2,$3,$3,'Aluno 23 bis','M23b',$4,'Em cobrança',false,1000)`,
                   [U(200023), c.aluno, c.cpf, OP1]);
    await db.exec(MIGRATION);
    await como(db, GESTAO);
    const r = (await q1(db, `select public.caso_encerramento_resolver($1,'DEVOLVER_A_COBRANCA',$2) r`,
      [c.caso, JUST])).r;
    expect(r).toMatchObject({ ok: false, erro: "ALUNO_JA_TEM_CASO_ABERTO" });
    expect(await predicado5(db, c)).toBe(true); // continua congelado
  });

  it("resolver exige gestao, identidade e justificativa de verdade", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 24, { divida: 1000 });
    await db.exec(MIGRATION);

    await como(db, OP1);
    await expect(db.query(`select public.caso_encerramento_resolver($1,'MANTER_ENCERRADO',$2)`, [c.caso, JUST]))
      .rejects.toThrow(/decisao da gestao/);

    await como(db, null, "service_role"); // papel de servico SEM e-mail
    await expect(db.query(`select public.caso_encerramento_resolver($1,'MANTER_ENCERRADO',$2)`, [c.caso, JUST]))
      .rejects.toThrow(/AUTORIA_OBRIGATORIA/);

    await semJwt(db);
    await expect(db.query(`select public.caso_encerramento_resolver($1,'MANTER_ENCERRADO',$2)`, [c.caso, JUST]))
      .rejects.toThrow(/AUTORIA_OBRIGATORIA/);

    await como(db, GESTAO);
    await expect(db.query(`select public.caso_encerramento_resolver($1,'MANTER_ENCERRADO',$2)`, [c.caso, "curto"]))
      .rejects.toThrow(/JUSTIFICATIVA_OBRIGATORIA/);
    await expect(db.query(`select public.caso_encerramento_resolver($1,'INVENTADA',$2)`, [c.caso, JUST]))
      .rejects.toThrow(/DECISAO_INVALIDA/);

    expect(await trilha(db, c)).toHaveLength(1); // nada mudou na trilha
  });

  it("a trilha e append-only e authenticated so le", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 25, { divida: 1000 });
    await db.exec(MIGRATION);

    await expect(db.query(`delete from public.caso_encerramento_sem_saldo where caso_id=$1`, [c.caso]))
      .rejects.toThrow(/TRILHA_IMUTAVEL/);
    await expect(db.query(`update public.caso_encerramento_sem_saldo set justificativa='forjada' where caso_id=$1`, [c.caso]))
      .rejects.toThrow(/TRILHA_IMUTAVEL/);

    const g = await q(db, `select privilege_type from information_schema.role_table_grants
                            where table_schema='public' and table_name='caso_encerramento_sem_saldo'
                              and grantee='authenticated'`);
    expect(g.map((x) => x.privilege_type).sort()).toEqual(["SELECT"]);

    for (const sql of [
      `insert into public.caso_encerramento_sem_saldo (caso_id,aluno_id,classificacao,estado_anterior,justificativa,origem)
       values ('${c.caso}','${c.aluno}','NAO_ACIONAR','{}'::jsonb,'tentativa de escrita direta pelo app','GESTAO')`,
      `truncate table public.caso_encerramento_sem_saldo`,
    ]) {
      await db.exec("begin");
      let passou = false;
      try { await db.exec("set local role authenticated"); await db.exec(sql); passou = true; } catch { /* esperado */ }
      await db.exec("rollback");
      expect(passou).toBe(false);
    }
  });

  it("a fila de pendencias e da gestao", async () => {
    const db = await abrir(ANTES);
    const c = await cenario(db, 26, { divida: 7777 });
    await db.exec(MIGRATION);
    await como(db, GESTAO);
    const fila = await q(db, `select * from public.caso_encerramento_pendentes(50)`);
    expect(fila.some((f) => f.caso_id === c.caso && Number(f.saldo_no_momento) === 7777)).toBe(true);
    await como(db, OP1);
    await expect(db.query(`select * from public.caso_encerramento_pendentes(50)`))
      .rejects.toThrow(/decisao da gestao/);
  });
});
