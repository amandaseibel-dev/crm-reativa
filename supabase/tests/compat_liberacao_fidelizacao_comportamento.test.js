// COMPATIBILIDADE DO CAMINHO DE LIBERACAO COM A FIDELIZACAO POR RESPONSAVEL.
//
// Roda as DUAS migrations reais e os DOIS rollbacks reais num PostgreSQL real
// (PGlite) sobre a fixture estrutural derivada de producao:
//   20260930090000_fidelizacao_por_responsavel_atual.sql        (infraestrutura)
//   20260930100000_compat_liberacao_fidelizacao_por_responsavel.sql (esta frente)
//
// A fixture traz 37 funcoes com o texto EXATO de producao (md5 do prosrc
// conferido), 21 tabelas, os 12 gatilhos de INSERT/UPDATE de casos e
// aluno_movimentacoes, e -- o que importa aqui -- public.liberar_fidelizacao_caso
// e public.liberar_casos_fidelizacao_vencida, com a guarda dos 10 dias que a
// migration 20260929101500 instalou em producao.
//
// NENHUM DADO REAL: operadores @teste.local, UUIDs e CPFs inventados.
// NADA APLICADO: as migrations rodam so neste banco efemero, que morre no fim.
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
const MD5_PROD = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const MIG_INFRA = ler("supabase/migrations/20260930090000_fidelizacao_por_responsavel_atual.sql");
const MIG_COMPAT = ler("supabase/migrations/20260930100000_compat_liberacao_fidelizacao_por_responsavel.sql");
const ROLL_COMPAT = ler("supabase/rollbacks/20260930100000_compat_liberacao_fidelizacao_por_responsavel.rollback.sql");

const A = "operador.a@teste.local";
const GESTAO = "gestao@teste.local";
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(10000000000 + n);

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

let DUMP_INFRA;  // fixture + migration de infraestrutura (sem a compatibilidade)
let DUMP_COMPAT; // fixture + infraestrutura + compatibilidade
const abrir = (dump) => new PGlite({ loadDataDir: dump, extensions: ext });

beforeAll(async () => {
  const db = new PGlite({ extensions: ext });
  await db.exec(FIXTURE);

  // PORTAO DE FIDELIDADE: se qualquer corpo divergir de producao, para aqui.
  const rows = await qn(db, `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries(MD5_PROD)) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome) values
      ('Operador A', '${A}', 'operador', true, 'OPERADOR A'),
      ('Gestao Teste', '${GESTAO}', 'gerencia', true, null);
  `);
  await db.exec(MIG_INFRA);
  DUMP_INFRA = await db.dumpDataDir();
  await db.exec(MIG_COMPAT);
  DUMP_COMPAT = await db.dumpDataDir();
  await db.close();
});

// aluno + caso + titulo ABERTO com saldo (logo, nao protegido por saldo zero)
async function cenario(db, n, o = {}) {
  const { inicio = null, dua = null, statusAcion = null, saldo = 500, naoAcionar = false } = o;
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email,
        responsavel_atual_nome, responsavel_atual_em)
     values ($1,$2,$3,$4,$5,'OPERADOR A','2026-08-01T12:00:00Z')`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, A]
  );
  if (saldo > 0) {
    await db.query(
      `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento,
          valor_original, saldo_corrigido, situacao, status)
       values ($1,$2,$3,'2026-01-10',$4,$4,'ABERTO','em_aberto')`,
      [U(n), cpf, `DOC${n}`, saldo]
    );
  }
  const caso = await q1(db,
    `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email,
        status_acionamento, nao_acionar, data_ultimo_acionamento, caso_codigo)
     values ($1,$2,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [U(n), cpf, `Aluno Sintetico ${n}`, A, statusAcion, naoAcionar, dua, n]);
  // relogio do dono, em data local de Brasilia
  const temCol = await q1(db, `select count(*)::int n from information_schema.columns
    where table_schema='public' and table_name='casos' and column_name='fidelizacao_inicio'`);
  if (temCol.n > 0 && inicio !== null) {
    await db.query(`update public.casos set fidelizacao_inicio =
      (public.hoje_brt() - $2::int)::timestamp at time zone 'America/Sao_Paulo' where id=$1`,
      [caso.id, inicio]);
  }
  return caso.id;
}

const dono = async (db, casoId) =>
  (await q1(db, `select operador_email from public.casos where id=$1`, [casoId])).operador_email;

// ============================================================================
describe("assinatura, schema e ACL da funcao nova", () => {
  it("D. assinatura exata em internal", async () => {
    const db = abrir(DUMP_COMPAT);
    const f = await q1(db, `select n.nspname schema, p.proname nome,
        pg_get_function_identity_arguments(p.oid) args,
        pg_get_function_result(p.oid) retorno, p.prosecdef security_definer,
        array_to_string(p.proconfig,',') config
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.proname='liberar_fidelizacao_caso_v2'`);
    expect(f.schema).toBe("internal");
    expect(f.args).toBe("p_caso_id uuid, p_motivo text, p_autor text");
    expect(f.retorno).toBe("boolean");
    expect(f.security_definer).toBe(true);
    expect(f.config).toBe("search_path=public");
    await db.close();
  });

  it("E. o schema internal nao tem USAGE para anon, authenticated nem service_role", async () => {
    const db = abrir(DUMP_COMPAT);
    const s = await q1(db, `select
      has_schema_privilege('anon','internal','USAGE') anon,
      has_schema_privilege('authenticated','internal','USAGE') auth,
      has_schema_privilege('service_role','internal','USAGE') service`);
    expect(s).toMatchObject({ anon: false, auth: false, service: false });
    await db.close();
  });

  it("E2. nenhum EXECUTE concedido a authenticated na funcao nova", async () => {
    const db = abrir(DUMP_COMPAT);
    const f = await q1(db, `select coalesce(array_to_string(p.proacl,' | '),'(default)') acl
      from pg_proc p where p.proname='liberar_fidelizacao_caso_v2'`);
    expect(f.acl).not.toMatch(/\bauthenticated=/);
    expect(f.acl).not.toMatch(/\banon=/);
    await db.close();
  });

  it("E3. nao existe wrapper publico com o nome novo", async () => {
    const db = abrir(DUMP_COMPAT);
    const n = await q1(db, `select count(*)::int n from pg_proc p
      join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname like '%liberar_fidelizacao_caso_v2%'`);
    expect(n.n).toBe(0);
    await db.close();
  });

  it("a migration nao mexe em cron, backfill, sombra nem modo", () => {
    const semComentarios = MIG_COMPAT.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(semComentarios).not.toMatch(/cron\./i);
    expect(semComentarios).not.toMatch(/fidelizacao_backfill_corte\s*\(/);
    expect(semComentarios).not.toMatch(/fidelizacao_sombra_registrar\s*\(/);
    expect(semComentarios).not.toMatch(/parametros_operacao/);
    // e cria exatamente UM objeto
    expect((semComentarios.match(/create or replace function/gi) || []).length).toBe(1);
    expect(semComentarios).not.toMatch(/create (table|trigger|index|policy)/i);
  });
});

// ============================================================================
describe("F. a v1 continua byte a byte, e nenhum caller muda", () => {
  const md5De = async (dump, nome) => {
    const db = abrir(dump);
    const r = await q1(db, `select md5(p.prosrc) md5 from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname||'.'||p.proname = $1`, [nome]);
    await db.close();
    return r?.md5;
  };

  for (const nome of [
    "public.liberar_fidelizacao_caso",
    "public.liberar_casos_fidelizacao_vencida",
    "public.casos_elegiveis_liberacao_fidelizacao",
    "public.caso_dentro_prazo_fidelizacao",
    "internal.matricula_em_fidelizacao",
    "public.caso_protegido_redistribuicao",
  ]) {
    it(`${nome}: md5 antes = depois = producao`, async () => {
      const antes = await md5De(DUMP_INFRA, nome);
      const depois = await md5De(DUMP_COMPAT, nome);
      expect(antes).toBe(MD5_PROD[nome]);
      expect(depois).toBe(antes);
    });
  }

  it("a assinatura de liberar_fidelizacao_caso continua com 3 argumentos -- sem overload ambiguo", async () => {
    const db = abrir(DUMP_COMPAT);
    const r = await qn(db, `select pg_get_function_identity_arguments(p.oid) args
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='liberar_fidelizacao_caso'`);
    expect(r.length).toBe(1); // UMA assinatura, nao duas
    expect(r[0].args).toBe("p_caso_id uuid, p_motivo text, p_autor text");
    // e a chamada posicional de 3 args que o lote faz continua resolvendo
    const c = await cenario(db, 1, { inicio: 30, dua: "2026-01-01" });
    const ok = await q1(db, `select public.liberar_fidelizacao_caso($1,'X','Y') ok`, [c]);
    expect(ok.ok).toBe(true);
    await db.close();
  });

  it("o lote da v1 continua funcionando exatamente como antes", async () => {
    const rodar = async (dump) => {
      const db = abrir(dump);
      await db.exec(`select set_config('request.jwt.claims','{"email":"${GESTAO}"}',false)`);
      await cenario(db, 2, { inicio: 30, dua: "2026-01-01" });
      const n = await q1(db, `select public.liberar_casos_fidelizacao_vencida(100) n`);
      const livres = await q1(db, `select count(*)::int n from public.casos where operador_email is null`);
      await db.close();
      return { soltou: Number(n.n), livres: livres.n };
    };
    expect(await rodar(DUMP_COMPAT)).toEqual(await rodar(DUMP_INFRA));
  });
});

// ============================================================================
describe("G. os 5 cenarios obrigatorios", () => {
  // `inicio` em dias atras (relogio do DONO); `dua` em data (relogio do CASO)
  const HOJE = () => new Date().toISOString().slice(0, 10);

  it("CENARIO 1 -- dono vencido + caso recente: v1 NAO libera, v2 LIBERA", async () => {
    const db = abrir(DUMP_COMPAT);
    const c1 = await cenario(db, 10, { inicio: 30, dua: HOJE() });
    const v1 = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c1]);
    expect(v1.ok).toBe(false);
    expect(await dono(db, c1)).toBe(A);

    const c2 = await cenario(db, 11, { inicio: 30, dua: HOJE() });
    const v2 = await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c2]);
    expect(v2.ok).toBe(true);
    expect(await dono(db, c2)).toBe(null);
    await db.close();
  });

  it("CENARIO 2 -- dono recente + caso vencido: v1 libera (comportamento atual), v2 NAO libera", async () => {
    const db = abrir(DUMP_COMPAT);
    const c1 = await cenario(db, 12, { inicio: 2, dua: "2026-01-01" });
    const v1 = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c1]);
    expect(v1.ok).toBe(true);   // a regra vigente solta -- e isso NAO muda
    expect(await dono(db, c1)).toBe(null);

    const c2 = await cenario(db, 13, { inicio: 2, dua: "2026-01-01" });
    const v2 = await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c2]);
    expect(v2.ok).toBe(false);  // o dono ainda esta no prazo dele
    expect(await dono(db, c2)).toBe(A);
    await db.close();
  });

  it("CENARIO 3 -- ambos vencidos: v1 libera e v2 libera", async () => {
    const db = abrir(DUMP_COMPAT);
    const c1 = await cenario(db, 14, { inicio: 30, dua: "2026-01-01" });
    expect((await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c1])).ok).toBe(true);
    const c2 = await cenario(db, 15, { inicio: 30, dua: "2026-01-01" });
    expect((await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c2])).ok).toBe(true);
    await db.close();
  });

  it("CENARIO 4 -- caso protegido: v2 NAO libera (e a v2 e mais estrita que a v1 aqui)", async () => {
    const db = abrir(DUMP_COMPAT);
    // protegido por negociacao em curso, regra real de producao
    const c2 = await cenario(db, 16, { inicio: 30, dua: "2026-01-01", statusAcion: "EM NEGOCIACAO" });
    expect((await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c2])).ok).toBe(false);
    expect(await dono(db, c2)).toBe(A);

    // nao_acionar tambem protege
    const c3 = await cenario(db, 17, { inicio: 30, dua: "2026-01-01", naoAcionar: true });
    expect((await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c3])).ok).toBe(false);

    // ACHADO REGISTRADO: a v1, chamada DIRETO, NAO checa protecao -- ela confia
    // na lista casos_elegiveis_liberacao_fidelizacao, que filtra. Este teste
    // documenta o comportamento de hoje; nao o altera.
    const c1 = await cenario(db, 18, { inicio: 30, dua: "2026-01-01", statusAcion: "EM NEGOCIACAO" });
    const v1direto = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c1]);
    expect(v1direto.ok).toBe(true); // v1 direto solta caso protegido -- hoje e assim

    // e pela LISTA, que e o caminho que o cron usa, o protegido nunca aparece
    const naLista = await q1(db, `select count(*)::int n
      from public.casos_elegiveis_liberacao_fidelizacao() f
      where f.caso_id = $1`, [c1]);
    expect(naLista.n).toBe(0);
    await db.close();
  });

  it("CENARIO 5 -- fidelizacao_inicio NULL: v2 NAO libera", async () => {
    const db = abrir(DUMP_COMPAT);
    const c = await cenario(db, 19, { inicio: null, dua: "2026-01-01" });
    const nulo = await q1(db, `select fidelizacao_inicio from public.casos where id=$1`, [c]);
    expect(nulo.fidelizacao_inicio).toBe(null);
    expect((await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c])).ok).toBe(false);
    expect(await dono(db, c)).toBe(A);
    await db.close();
  });

  it("caso sem dono ou inexistente: as duas devolvem false, sem erro", async () => {
    const db = abrir(DUMP_COMPAT);
    const c = await cenario(db, 20, { inicio: 30, dua: "2026-01-01" });
    await db.query(`update public.casos set operador_email=null where id=$1`, [c]);
    expect((await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c])).ok).toBe(false);
    expect((await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c])).ok).toBe(false);
    const fantasma = "99999999-9999-9999-9999-999999999999";
    expect((await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [fantasma])).ok).toBe(false);
    await db.close();
  });
});

// ============================================================================
describe("H. paridade das escritas -- a duplicacao deliberada fica travada", () => {
  // CONTRATO: enquanto v1 e v2 coexistirem, mudancas no nucleo de escrita
  // precisam manter paridade entre os dois caminhos. Este teste compara os
  // EFEITOS OBSERVAVEIS, nao o texto das funcoes -- e o que detecta alguem
  // mexer em um lado e esquecer o outro.
  const efeitos = async (caminho) => {
    const db = abrir(DUMP_COMPAT);
    const c = await cenario(db, 30, { inicio: 30, dua: "2026-01-01" });
    const antesMovs = (await q1(db, `select count(*)::int n from public.aluno_movimentacoes`)).n;
    const ok = await q1(db,
      caminho === "v1"
        ? `select public.liberar_fidelizacao_caso($1) ok`
        : `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c]);
    const caso = await q1(db, `select operador_email, operador_nome, operador,
        caso_atualizado_por is not null tem_autor,
        caso_atualizado_em is not null tem_data,
        aluno_id, cpf_limpo, nome, status_acionamento, nao_acionar,
        data_ultimo_acionamento, fidelizacao_inicio is not null relogio_mantido,
        encerrado_operacional, saldo_total, total_em_aberto
      from public.casos where id=$1`, [c]);
    const aluno = await q1(db, `select responsavel_atual_email, responsavel_atual_nome,
        responsavel_atual_em is not null resp_em_mantido, data_ultimo_acionamento,
        status_acionamento from public.alunos where id=$1`, [U(30)]);
    const hist = await q1(db, `select count(*)::int linhas,
        max(chave_unificacao) chave, max(nome_aluno) nome, max(cpf_referencia) cpf,
        max(operador_anterior_nome) op_ant_nome, max(operador_anterior_email) op_ant_email,
        max(operador_nome) op_nome, max(operador_email) op_email
      from public.historico_operadores_alunos`);
    const outras = await q1(db, `select
        (select count(*)::int from public.reposicao_carteira_fila) reposicao,
        (select count(*)::int from public.aluno_movimentacoes) movs,
        (select count(*)::int from public.acordos_titulos) titulos,
        (select count(*)::int from public.acordos) acordos,
        (select count(*)::int from public.parcelas) parcelas,
        (select count(*)::int from public.pagamentos) pagamentos,
        (select count(*)::int from public.solicitacoes_confirmacao_pagamento) solic,
        (select count(*)::int from public.alunos_estado_anterior) estado_anterior,
        (select count(*)::int from public.ficha_reabertura_barrada) ficha_barrada`);
    await db.close();
    return { ok: ok.ok, caso, aluno, hist, outras, movsDelta: outras.movs - antesMovs };
  };

  it("as duas escritas produzem o MESMO estado, exceto motivo, autor e a observacao", async () => {
    const v1 = await efeitos("v1");
    const v2 = await efeitos("v2");

    expect(v1.ok).toBe(true);
    expect(v2.ok).toBe(true);

    // casos: identico em tudo, inclusive no que NAO deve mudar
    expect(v2.caso).toEqual(v1.caso);
    // alunos: identico
    expect(v2.aluno).toEqual(v1.aluno);
    // historico: mesma forma e mesmos campos de identificacao/operador anterior
    expect(v2.hist).toEqual(v1.hist);
    // nenhuma outra tabela tocada, e a contagem e igual nos dois caminhos
    expect(v2.outras).toEqual(v1.outras);
    // NENHUM dos dois gera reposicao: trigger_repor_caso_operador so dispara
    // quando o operador NAO muda, e liberar muda (para null).
    expect(v1.outras.reposicao).toBe(0);
    expect(v2.outras.reposicao).toBe(0);
    // AMBOS geram EXATAMENTE UMA movimentacao, e pelo mesmo motivo: zerar
    // operador_email dispara trg_sync_alunos_apos_casos -> internal.set_resp_aluno,
    // que registra REDISTRIBUICAO_SINCRONIZACAO. O que importa para a paridade e
    // que o numero seja o MESMO nos dois caminhos -- e e.
    expect(v2.movsDelta).toBe(v1.movsDelta);
    expect(v1.movsDelta).toBe(1);
  });

  it("a unica diferenca no historico e acao (motivo), autor e observacao", async () => {
    const linha = async (caminho) => {
      const db = abrir(DUMP_COMPAT);
      const c = await cenario(db, 31, { inicio: 30, dua: "2026-01-01" });
      await db.query(caminho === "v1"
        ? `select public.liberar_fidelizacao_caso($1)`
        : `select internal.liberar_fidelizacao_caso_v2($1)`, [c]);
      const h = await q1(db, `select acao, observacao from public.historico_operadores_alunos limit 1`);
      const k = await q1(db, `select caso_atualizado_por from public.casos where id=$1`, [c]);
      await db.close();
      return { acao: h.acao, obs: h.observacao, autor: k.caso_atualizado_por };
    };
    const v1 = await linha("v1");
    const v2 = await linha("v2");
    expect(v1.acao).toBe("FIDELIZACAO_EXPIRADA");
    expect(v2.acao).toBe("FIDELIZACAO_EXPIRADA_DONO");
    expect(v1.autor).toBe("sistema_fidelizacao");
    expect(v2.autor).toBe("sistema_fidelizacao_v2");
    // as observacoes explicam regras diferentes, e e a unica prosa que difere
    expect(v1.obs).toMatch(/ultimo acionamento/);
    expect(v2.obs).toMatch(/responsavel atual/);
  });
});

// ============================================================================
describe("I. antes x depois -- o bloqueio que motivou esta frente", () => {
  it("ANTES da compatibilidade: v2 elegivel + liberar_fidelizacao_caso = false", async () => {
    const db = abrir(DUMP_INFRA); // SEM a migration de compatibilidade
    const c = await cenario(db, 40, { inicio: 30, dua: new Date().toISOString().slice(0, 10) });
    const eleg = await q1(db, `select count(*)::int n
      from public.casos_elegiveis_liberacao_fidelizacao_v2() where caso_id=$1`, [c]);
    const soltou = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c]);
    expect(eleg.n).toBe(1);        // a v2 considera elegivel
    expect(soltou.ok).toBe(false); // e o caminho de liberacao RECUSA
    expect(await dono(db, c)).toBe(A);
    // e o caminho novo nem existe ainda
    const existe = await q1(db, `select count(*)::int n from pg_proc
      where proname='liberar_fidelizacao_caso_v2'`);
    expect(existe.n).toBe(0);
    await db.close();
  });

  it("DEPOIS: v2 elegivel + caminho v2 = true, e a v1 continua false no MESMO cenario", async () => {
    const db = abrir(DUMP_COMPAT);
    const hoje = new Date().toISOString().slice(0, 10);

    // caso 1: pelo caminho novo
    const c1 = await cenario(db, 41, { inicio: 30, dua: hoje });
    const eleg1 = await q1(db, `select count(*)::int n
      from public.casos_elegiveis_liberacao_fidelizacao_v2() where caso_id=$1`, [c1]);
    const v2 = await q1(db, `select internal.liberar_fidelizacao_caso_v2($1) ok`, [c1]);
    expect(eleg1.n).toBe(1);
    expect(v2.ok).toBe(true);
    expect(await dono(db, c1)).toBe(null);

    // caso 2, identico: pelo caminho antigo, continua recusando
    const c2 = await cenario(db, 42, { inicio: 30, dua: hoje });
    const v1 = await q1(db, `select public.liberar_fidelizacao_caso($1) ok`, [c2]);
    expect(v1.ok).toBe(false);
    expect(await dono(db, c2)).toBe(A);
    await db.close();
  });

  it("o futuro cron da v2 consegue percorrer lista + liberacao de ponta a ponta", async () => {
    const db = abrir(DUMP_COMPAT);
    const hoje = new Date().toISOString().slice(0, 10);
    for (let n = 50; n < 55; n++) await cenario(db, n, { inicio: 30, dua: hoje });
    await cenario(db, 55, { inicio: 30, dua: hoje, statusAcion: "EM NEGOCIACAO" }); // protegido
    // o que o cron novo faria: pegar a lista da v2 e liberar pelo caminho da v2
    const soltos = await q1(db, `
      with alvo as (
        select caso_id from public.casos_elegiveis_liberacao_fidelizacao_v2()
         where ordem_na_fila <= public.fidelizacao_teto_diario())
      select count(*) filter (where internal.liberar_fidelizacao_caso_v2(caso_id))::int n
        from alvo`);
    expect(soltos.n).toBe(5); // os 5 desprotegidos
    const protegido = await q1(db, `select operador_email from public.casos
      where aluno_id=$1`, [U(55)]);
    expect(protegido.operador_email).toBe(A); // o protegido nao saiu
    await db.close();
  });

  it("o cron VIGENTE continua na v1 -- a migration nao cria nem altera agendamento", () => {
    expect(MIG_COMPAT).not.toMatch(/cron\.(schedule|unschedule|alter_job)/i);
    expect(MIG_INFRA).not.toMatch(/cron\.(schedule|unschedule|alter_job)/i);
  });
});

// ============================================================================
describe("J. rollback", () => {
  it("dropa so a funcao nova e deixa todo o resto intacto", async () => {
    const db = abrir(DUMP_COMPAT);
    const antes = await q1(db, `select
      (select count(*)::int from pg_proc where proname='liberar_fidelizacao_caso_v2') v2,
      (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='liberar_fidelizacao_caso') md5_v1,
      (select count(*)::int from information_schema.columns where table_schema='public'
        and table_name='casos' and column_name='fidelizacao_inicio') coluna,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname like 'fidelizacao%') helpers`);
    expect(antes.v2).toBe(1);

    await db.exec(ROLL_COMPAT);

    const depois = await q1(db, `select
      (select count(*)::int from pg_proc where proname='liberar_fidelizacao_caso_v2') v2,
      (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='liberar_fidelizacao_caso') md5_v1,
      (select count(*)::int from information_schema.columns where table_schema='public'
        and table_name='casos' and column_name='fidelizacao_inicio') coluna,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname like 'fidelizacao%') helpers`);
    expect(depois.v2).toBe(0);                     // a funcao nova saiu
    expect(depois.md5_v1).toBe(antes.md5_v1);      // a v1 intacta
    expect(depois.md5_v1).toBe(MD5_PROD["public.liberar_fidelizacao_caso"]);
    expect(depois.coluna).toBe(antes.coluna);      // a coluna do #560 fica
    expect(depois.helpers).toBe(antes.helpers);    // os helpers do #560 ficam

    // e o caminho vigente continua funcionando depois do rollback
    await db.exec(`select set_config('request.jwt.claims','{"email":"${GESTAO}"}',false)`);
    await cenario(db, 60, { inicio: 30, dua: "2026-01-01" });
    const lote = await q1(db, `select public.liberar_casos_fidelizacao_vencida(100) n`);
    expect(Number(lote.n)).toBeGreaterThanOrEqual(1);
    await db.close();
  });

  it("migration -> rollback -> migration, sem residuo", async () => {
    const db = abrir(DUMP_INFRA);
    await db.exec(MIG_COMPAT);
    expect((await q1(db, `select count(*)::int n from pg_proc where proname='liberar_fidelizacao_caso_v2'`)).n).toBe(1);
    await db.exec(ROLL_COMPAT);
    expect((await q1(db, `select count(*)::int n from pg_proc where proname='liberar_fidelizacao_caso_v2'`)).n).toBe(0);
    await db.exec(MIG_COMPAT);
    expect((await q1(db, `select count(*)::int n from pg_proc where proname='liberar_fidelizacao_caso_v2'`)).n).toBe(1);
    // reaplicar sobre si mesma tambem
    await db.exec(MIG_COMPAT);
    expect((await q1(db, `select count(*)::int n from pg_proc where proname='liberar_fidelizacao_caso_v2'`)).n).toBe(1);
    await db.close();
  });
});

// ============================================================================
describe("K. pre-requisito do #560 declarado, e nada acopla as etapas", () => {
  it("a funcao compila mesmo sem a coluna, mas nao executa (corpo plpgsql)", async () => {
    const db = new PGlite({ extensions: ext });
    await db.exec(FIXTURE);                 // fixture SEM a migration de infraestrutura
    await db.exec(MIG_COMPAT);              // compila: corpo plpgsql nao e validado
    const existe = await q1(db, `select count(*)::int n from pg_proc
      where proname='liberar_fidelizacao_caso_v2'`);
    expect(existe.n).toBe(1);
    // ao EXECUTAR sem a coluna, falha -- por isso a ordem de aplicacao importa
    await db.exec(`insert into public.alunos (id,cpf,nome) values ('${U(70)}','${CPF(70)}','X')`);
    const c = await q1(db, `insert into public.casos (aluno_id,cpf,cpf_limpo,nome,operador_email,caso_codigo)
      values ('${U(70)}','${CPF(70)}','${CPF(70)}','X','${A}',70) returning id`);
    await expect(db.query(`select internal.liberar_fidelizacao_caso_v2($1)`, [c.id]))
      .rejects.toThrow(/fidelizacao_inicio|column .* does not exist/i);
    await db.close();
  });

  it("a migration de compatibilidade nao chama nada da etapa de ativacao", () => {
    const semComentarios = MIG_COMPAT.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const proibido of [
      "fidelizacao_backfill_corte", "fidelizacao_sombra_registrar",
      "parametros_operacao", "cron.", "'ativo'",
    ]) {
      expect(semComentarios, `nao pode citar ${proibido}`).not.toContain(proibido);
    }
  });
});
