// AUDITORIA DO ENCERRAMENTO OPERACIONAL (migration 20261026195000).
//
// `casos.encerrado_operacional` tira o aluno da cobranca, das filas e da
// contagem, e hoje muda sem deixar rastro: `casos` nao tem coluna de data de
// encerramento, e o censo de 26/10/2026 achou ZERO registros em `auditoria`
// para os 40 casos encerrados que estavam na fila da Conferencia Prime -- e UMA
// unica linha em `aluno_movimentacoes` entre os 7 com divida viva.
//
// ORIGEM DOS CENARIOS: desenhados na branch `fix/encerramento-exige-saldo`
// (SHA 57e2de29), encerrada pela gestao em 26/10/2026 com esta implementacao
// mantida como principal. Reescritos aqui sobre a bancada desta branch -- a de
// ONZE funcoes com md5 de producao -- porque o arquivo de origem dependia da
// sobreposicao de fixture e da migration de regra que esta entrega supersede.
//
// O QUE PROVA:
//   T9   grava estado anterior, operacao e data; autor e motivo NULOS sem contexto;
//   T9b  quando o contexto existe, usa o contexto, na ordem GUC -> jwt -> caso;
//   T9c  a trilha nao e legivel nem truncavel por `authenticated`, e tem RLS;
//   T14  `auth.jwt()`/`auth.uid()` quebrados NAO derrubam a escrita em `casos`;
//   RB   o rollback desliga a captura e PRESERVA as linhas;
//   +1   a migration da regra (20261026200000) nao escreve em `casos`, logo nao
//        gera ruido na trilha quando e aplicada depois.
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
const AUDITORIA = ler("supabase/migrations/20261026195000_auditoria_encerramento_operacional.sql");
const RB_AUDITORIA = ler("supabase/rollbacks/20261026195000_auditoria_encerramento_operacional.rollback.sql");
const REGRA = ler("supabase/migrations/20261026200000_encerramento_sem_saldo_validacao_financeira.sql");

const CPF = "55566677788";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

let COM_AUDITORIA;

beforeAll(async () => {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  await db.exec(`insert into public.usuarios (nome, email, perfil, ativo)
                 values ('Amanda', 'amanda.seibel@aelbra.com.br', 'gestao', true);`);
  await db.exec(ACORDO_CANCELADO);
  await db.exec(GRUPO_A);
  await db.exec(ALINHAR);
  // o contrato da bancada: onze funcoes com o md5 de producao de 26/10
  const { rows } = await db.query(
    `select n.nspname||'.'||p.proname as nome, md5(p.prosrc) as md5
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`
  );
  const noBanco = {};
  for (const r of rows) noBanco[r.nome] = r.md5;
  for (const [nome, md5] of Object.entries(MD5_ALINHADO)) {
    if (noBanco[nome] !== md5) throw new Error(`bancada diverge de producao: ${nome}`);
  }
  await db.exec(AUDITORIA);
  COM_AUDITORIA = await db.dumpDataDir("none");
  await db.close();
}, 240000);

const abrir = () => new PGlite({ loadDataDir: COM_AUDITORIA, extensions: { unaccent } });
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

async function cenario(db, n, o = {}) {
  const aluno = U(n), caso = U(100000 + n);
  await db.query(`insert into public.alunos (id, cpf, nome) values ($1,$2,$3)`,
    [aluno, o.cpf ?? CPF, `Aluno ${n}`]);
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, status_atual, caso_atualizado_por)
     values ($1,$2,$3,$3,$4,$5,$6)`,
    [caso, aluno, o.cpf ?? CPF, `Aluno ${n}`, o.statusAtual ?? "Em cobranca", o.atualizadoPor ?? null]
  );
  return { aluno, caso };
}
const trilha = (db, caso) =>
  q(db, `select caso_id, aluno_id, valor_anterior, valor_novo, operacao, usuario_email, usuario_role,
                origem, motivo, alterado_em is not null as tem_data, metadados
           from public.casos_encerramento_auditoria where caso_id = $1 order by id`, [caso]);

// ============================================================ T9
describe("T9 — a trilha registra, e nao inventa o que falta", () => {
  it("grava estado anterior, operacao e data; autor e motivo ficam NULOS sem contexto", async () => {
    const db = abrir();
    const c = await cenario(db, 12);
    // nasce nao encerrado: INSERT nao audita
    expect((await q1(db, `select count(*)::int n from public.casos_encerramento_auditoria`)).n).toBe(0);

    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c.caso]);

    const t = await trilha(db, c.caso);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      caso_id: c.caso, aluno_id: c.aluno,
      valor_anterior: false, valor_novo: true, operacao: "UPDATE", tem_data: true,
    });
    expect(t[0].metadados.status_atual).toBe("SEM SALDO EM ABERTO");
    expect(t[0].metadados.nao_acionar).toBe(false);
    expect(t[0].metadados).toHaveProperty("saldo_no_instante");
    expect(t[0].metadados).toHaveProperty("txid");
    // o CPF nao entra na trilha; so se havia CPF utilizavel
    expect(t[0].metadados).not.toHaveProperty("cpf_limpo");
    expect(t[0].metadados.cpf_limpo_preenchido).toBe(true);
    // NAO INVENTA
    expect(t[0].usuario_email).toBeNull();
    expect(t[0].motivo).toBeNull();
  });

  it("caso que JA NASCE encerrado e auditado no INSERT", async () => {
    const db = abrir();
    const c = await cenario(db, 15, { statusAtual: "SEM SALDO EM ABERTO" });
    const t = await trilha(db, c.caso);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ operacao: "INSERT", valor_anterior: null, valor_novo: true });
  });

  it("mudanca que NAO troca o encerramento nao gera linha", async () => {
    const db = abrir();
    const c = await cenario(db, 16);
    await db.query(`update public.casos set nome = 'Outro Nome' where id = $1`, [c.caso]);
    await db.query(`update public.casos set status_atual = 'Em cobranca' where id = $1`, [c.caso]);
    expect(await trilha(db, c.caso)).toHaveLength(0);
  });
});

// ============================================================ T9b
describe("T9b — quando o contexto existe, usa o contexto", () => {
  it("usa a GUC antes do jwt e do caso_atualizado_por", async () => {
    const db = abrir();
    const c = await cenario(db, 13, { atualizadoPor: "fallback@aelbra.com.br" });
    await db.exec(`select set_config('reativa.encerramento_usuario', 'gestao@aelbra.com.br', false);
                   select set_config('reativa.encerramento_motivo', 'conferencia individual', false);`);
    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c.caso]);

    const t = await trilha(db, c.caso);
    expect(t[0].usuario_email).toBe("gestao@aelbra.com.br");
    expect(t[0].motivo).toBe("conferencia individual");
    expect(t[0].origem).toBeTruthy();
  });

  it("sem GUC e sem jwt, cai em caso_atualizado_por -- e nao em nada inventado", async () => {
    const db = abrir();
    const c = await cenario(db, 14, { atualizadoPor: "sistema_zerado_real" });
    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c.caso]);
    const t = await trilha(db, c.caso);
    expect(t[0].usuario_email).toBe("sistema_zerado_real");
  });

  it("origem NUNCA e nula: sem GUC cai em SESSION:<session_user>", async () => {
    const db = abrir();
    const c = await cenario(db, 17);
    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c.caso]);
    const t = await trilha(db, c.caso);
    expect(t[0].origem).toMatch(/^SESSION:/);
  });
});

// ============================================================ T9c
describe("T9c — a trilha nao e leitura de operador", () => {
  it("authenticated nao le nem trunca, e a RLS esta ligada", async () => {
    const db = abrir();
    const r = await q1(db,
      `select coalesce(has_table_privilege('authenticated','public.casos_encerramento_auditoria','SELECT'), false) le,
              coalesce(has_table_privilege('authenticated','public.casos_encerramento_auditoria','TRUNCATE'), false) trunca,
              coalesce(has_table_privilege('authenticated','public.casos_encerramento_auditoria','INSERT'), false) escreve,
              relrowsecurity rls, (select count(*)::int from pg_policy where polrelid = c.oid) policies
         from pg_class c where c.relname = 'casos_encerramento_auditoria'`);
    expect(r).toMatchObject({ le: false, trunca: false, escreve: false, rls: true, policies: 0 });
  });

  it("o EXECUTE da funcao de gatilho e revogado de PUBLIC, nao so dos dois papeis", async () => {
    const db = abrir();
    const r = await q1(db,
      `select has_function_privilege('public','public.trg_auditar_encerramento_operacional()','EXECUTE') pub,
              has_function_privilege('authenticated','public.trg_auditar_encerramento_operacional()','EXECUTE') auth
         from pg_proc p where p.proname='trg_auditar_encerramento_operacional' limit 1`);
    expect(r).toMatchObject({ pub: false, auth: false });
  });
});

// ============================================================ T14
describe("T14 — contexto de auth quebrado nao derruba a escrita no caso", () => {
  it("se auth.jwt() e auth.uid() levantam, o UPDATE passa e a trilha grava autor NULO", async () => {
    const db = abrir();
    // o gatilho e `after insert or update` em `casos` SEM clausula `when`: uma
    // excecao ali derrubaria QUALQUER escrita na tabela, inclusive rotina em lote
    await db.exec(`
      create or replace function auth.jwt() returns jsonb language plpgsql as
      $f$ begin raise exception 'claims malformado'; end; $f$;
      create or replace function auth.uid() returns uuid language plpgsql as
      $f$ begin raise exception 'claims malformado'; end; $f$;`);
    const c = await cenario(db, 21);

    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c.caso]);

    expect(await q1(db, `select encerrado_operacional e from public.casos where id=$1`, [c.caso]))
      .toMatchObject({ e: true });
    const t = await trilha(db, c.caso);
    expect(t).toHaveLength(1);
    expect(t[0].usuario_email).toBeNull();
    expect(t[0].usuario_role).toBeNull();
    expect(t[0].metadados.auth_uid).toBeNull();
    expect(t[0].valor_novo).toBe(true);
  });
});

// ============================================================ rollback
describe("o rollback desliga a captura e preserva o historico", () => {
  it("gatilho e funcao saem; a tabela e as linhas ficam", async () => {
    const db = abrir();
    const c = await cenario(db, 31);
    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c.caso]);
    expect(await trilha(db, c.caso)).toHaveLength(1);

    await db.exec(RB_AUDITORIA);

    expect((await q1(db, `select count(*)::int n from pg_trigger
                           where tgname='trg_auditar_encerramento_operacional'`)).n).toBe(0);
    expect((await q1(db, `select count(*)::int n from pg_proc
                           where proname='trg_auditar_encerramento_operacional'`)).n).toBe(0);
    // a trilha e as linhas sobrevivem
    expect((await q1(db, `select to_regclass('public.casos_encerramento_auditoria') r`)).r).not.toBeNull();
    expect(await trilha(db, c.caso)).toHaveLength(1);

    // e, desligada a captura, encerramento volta a nao deixar rastro
    const c2 = await cenario(db, 32);
    await db.query(`update public.casos set status_atual = 'SEM SALDO EM ABERTO' where id = $1`, [c2.caso]);
    expect(await trilha(db, c2.caso)).toHaveLength(0);
  });
});

// ============================================================ integracao
describe("integracao com a migration da regra", () => {
  it("aplicar a regra (20261026200000) depois da auditoria nao gera linha na trilha", async () => {
    const db = abrir();
    // Para a regra congelar, o alvo precisa de DIVIDA REAL: com o texto e saldo
    // zero ela confirma o encerramento e nao congela nada -- que e o
    // comportamento correto e foi o que este teste mediu na primeira versao.
    const c1 = await cenario(db, 41, { statusAtual: "SEM SALDO EM ABERTO", cpf: "12312312311" });
    await db.query(
      `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original,
         saldo_corrigido, situacao, status, tipo_boleto, created_at)
       values ($1,'12312312311','DAUD41','2026-03-10',1500,1500,'ABERTO','em_aberto','Mensalidade','2026-01-10')`,
      [c1.aluno]);
    // O texto tambem no ALUNO, que e o retrato de producao: os 243 alvos de
    // aluno devem o "encerrado" a `alunos.status_acionamento`, nao ao caso.
    await db.query(`update public.alunos set status_acionamento = 'SEM SALDO EM ABERTO' where id = $1`,
      [c1.aluno]);
    await cenario(db, 42, { statusAtual: "SEM SALDO EM ABERTO", cpf: "45645645644" });
    const antes = (await q1(db, `select count(*)::int n from public.casos_encerramento_auditoria`)).n;

    await db.exec(REGRA);

    // a regra nao escreve em `casos`: so le, e grava na trilha de congelamento
    expect((await q1(db, `select count(*)::int n from public.casos_encerramento_auditoria`)).n).toBe(antes);
    // o que tem divida foi congelado (nos dois escopos); o que nao tem, nao
    expect((await q1(db, `select count(*)::int n from public.caso_encerramento_sem_saldo
                           where caso_id = $1`, [c1.caso])).n).toBe(1);
    expect((await q1(db, `select count(*)::int n from public.caso_encerramento_sem_saldo
                           where aluno_id = $1 and escopo = 'ALUNO'`, [c1.aluno])).n).toBe(1);
    expect((await q1(db, `select count(*)::int n from public.caso_encerramento_sem_saldo
                           where cpf_congelado = public._cpf11('45645645644')`)).n).toBe(0);
  });

  it("ciclo completo: as duas aplicam em ordem e cada rollback devolve producao", async () => {
    // A entrega sao DUAS migrations que entram em sequencia (195000 antes de
    // 200000). Este teste percorre o caminho inteiro -- aplicar as duas,
    // reverter as duas -- porque e o que acontece de verdade se a aplicacao
    // precisar ser desfeita, e nenhum dos outros testes cobre a sequencia.
    const PROD = {
      caso_encerrado_operacional: "adc514c7a018018d866096d8e420d7b3",
      casos_elegiveis_liberacao_fidelizacao: "fb72379bec0573059354843c3f82ddbd",
      casos_reabrir_com_divida: "63deeb34b039b9260c0d224b73d9ec81",
    };
    const md5 = async (db, f) => (await q1(db,
      `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=$1
          and pg_get_function_identity_arguments(p.oid) not like '%p_caso_id%' limit 1`, [f]))?.m;

    const db = abrir(); // ja tem a auditoria (195000) aplicada
    // alvo real: o texto no caso E no aluno, com divida
    const aluno = U(80), caso = U(100080), cpf = "78978978977";
    await db.query(`insert into public.alunos (id,cpf,nome,status_atual,status_jornada,status_acionamento)
                    values ($1,$2,'A80','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO')`, [aluno, cpf]);
    await db.query(`insert into public.casos (id,aluno_id,cpf,cpf_limpo,nome,status_atual,status_acionamento,
                      status_jornada,encerrado_operacional)
                    values ($1,$2,$3,$3,'A80','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO','SEM_SALDO_EM_ABERTO',true)`,
                   [caso, aluno, cpf]);
    await db.query(`insert into public.acordos_titulos (aluno_id,cpf,documento,vencimento,valor_original,
                      saldo_corrigido,situacao,status,tipo_boleto,created_at)
                    values ($1,$2,'D80','2026-03-10',3000,3000,'ABERTO','em_aberto','Mensalidade','2026-01-10')`,
                   [aluno, cpf]);
    const auditoriaAntes = (await q1(db, `select count(*)::int n from public.casos_encerramento_auditoria`)).n;

    await db.exec(REGRA);

    // congela os DOIS escopos e nao gera ruido na auditoria
    const cong = await q(db, `select escopo, classificacao from public.caso_encerramento_sem_saldo order by escopo`);
    expect(cong.map((x) => x.escopo)).toEqual(["ALUNO", "CASO"]);
    expect((await q1(db, `select count(*)::int n from public.casos_encerramento_auditoria`)).n).toBe(auditoriaAntes);
    expect((await q1(db, `select public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
              c.status_acionamento, c.status_financeiro, c.status_jornada) r
              from public.casos c where c.id=$1`, [caso])).r).toBe(true);

    await db.exec(ler("supabase/rollbacks/20261026200000_encerramento_sem_saldo_validacao_financeira.rollback.sql"));

    for (const [f, esperado] of Object.entries(PROD)) {
      expect(await md5(db, f), f).toBe(esperado);
    }
    // a trilha de congelamento e os verbos: uma fica, os outros saem
    expect((await q1(db, `select count(*)::int n from public.caso_encerramento_sem_saldo`)).n).toBe(2);
    expect((await q1(db, `select count(*)::int n from pg_proc
                           where proname like 'caso_encerramento_resolver%'`)).n).toBe(0);

    await db.exec(RB_AUDITORIA);

    expect((await q1(db, `select count(*)::int n from pg_trigger
                           where tgname='trg_auditar_encerramento_operacional'`)).n).toBe(0);
    expect((await q1(db, `select to_regclass('public.casos_encerramento_auditoria') r`)).r).not.toBeNull();
  });
});
